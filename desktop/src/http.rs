//! Shared HTTP client, so a proxy change can take effect without a restart.

use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use crate::settings::ProxyConfig;

/// A cheap-to-clone handle to the process HTTP client.
///
/// Replacing the inner client updates every clone: the Web API, token
/// refresh, artwork, lyrics, and the update check all pick up a new proxy
/// on the next request.
#[derive(Clone)]
pub struct Http {
    inner: Arc<Inner>,
}

struct Inner {
    /// The client the handle starts with. One built in the background is
    /// waited for by the first readers.
    first: OnceLock<Result<reqwest::Client, String>>,
    /// A later client, or a block, in place of the first.
    later: RwLock<Option<Result<reqwest::Client, String>>>,
}

impl Http {
    fn starting(first: Option<Result<reqwest::Client, String>>) -> Self {
        let inner = Inner {
            first: OnceLock::new(),
            later: RwLock::new(None),
        };
        if let Some(first) = first {
            let _ = inner.first.set(first);
        }
        Self {
            inner: Arc::new(inner),
        }
    }

    pub fn new(client: reqwest::Client) -> Self {
        Self::starting(Some(Ok(client)))
    }

    pub fn from_proxy(proxy: &ProxyConfig) -> Result<Self, String> {
        build_client(proxy).map(Self::new)
    }

    /// Builds the client on a thread of its own: loading the system's
    /// trusted certificates takes long enough to hold up the first window.
    /// `failed` hears why a configuration did not build; the handle then
    /// stays [`unavailable`](Self::unavailable) until a replacement.
    pub fn build_in_background(
        proxy: ProxyConfig,
        failed: impl FnOnce(&str) + Send + 'static,
    ) -> Self {
        let http = Self::starting(None);
        let first = Arc::clone(&http.inner);
        std::thread::Builder::new()
            .name("http-client".into())
            .spawn(move || {
                let built =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_client(&proxy)))
                        .unwrap_or_else(|_| Err("The network client could not be built.".into()));
                let error = built.as_ref().err().cloned();
                let _ = first.first.set(built);
                if let Some(error) = error {
                    failed(&error);
                }
            })
            .expect("unable to start the network client thread");
        http
    }

    /// Keep the interface available to repair settings without permitting
    /// requests to bypass the configuration that failed to build.
    pub fn unavailable(error: String) -> Self {
        Self::starting(Some(Err(error)))
    }

    pub fn replace(&self, client: reqwest::Client) {
        *self
            .inner
            .later
            .write()
            .unwrap_or_else(|lock| lock.into_inner()) = Some(Ok(client));
    }

    pub fn block(&self, error: String) {
        *self
            .inner
            .later
            .write()
            .unwrap_or_else(|lock| lock.into_inner()) = Some(Err(error));
    }

    pub fn client(&self) -> Result<reqwest::Client, String> {
        if let Some(later) = self
            .inner
            .later
            .read()
            .unwrap_or_else(|lock| lock.into_inner())
            .clone()
        {
            return later;
        }
        self.inner.first.wait().clone()
    }
}

impl Default for Http {
    fn default() -> Self {
        Self::new(reqwest::Client::new())
    }
}

impl From<reqwest::Client> for Http {
    fn from(client: reqwest::Client) -> Self {
        Self::new(client)
    }
}

pub fn build_client(proxy: &ProxyConfig) -> Result<reqwest::Client, String> {
    client_builder(proxy)?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.without_url().to_string())
}

pub fn build_blocking(
    proxy: &ProxyConfig,
    timeout: Duration,
) -> Result<reqwest::blocking::Client, String> {
    blocking_builder(proxy)?
        .timeout(timeout)
        .build()
        .map_err(|error| error.without_url().to_string())
}

fn client_builder(proxy: &ProxyConfig) -> Result<reqwest::ClientBuilder, String> {
    apply_proxy(
        trusting_native_roots(reqwest::Client::builder()).user_agent(user_agent()),
        proxy,
    )
}

/// The system's trusted root certificates, read once per process. Reading
/// them is most of the time a client takes to build, and on macOS two
/// clients reading at once take about as long as one after the other.
fn native_roots() -> &'static [reqwest::Certificate] {
    static ROOTS: OnceLock<Vec<reqwest::Certificate>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        // Only those rustls accepts, as reqwest keeps them: native stores
        // carry certificates too old or malformed to parse.
        let mut accepted = rustls::RootCertStore::empty();
        rustls_native_certs::load_native_certs()
            .certs
            .into_iter()
            .filter(|cert| accepted.add(cert.clone()).is_ok())
            .filter_map(|cert| reqwest::Certificate::from_der(&cert).ok())
            .collect()
    })
}

/// A builder that trusts the system's roots without reading them again.
/// Without any, reqwest reads and reports on them itself.
pub(crate) fn trusting_native_roots(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let roots = native_roots();
    if roots.is_empty() {
        return builder;
    }
    roots
        .iter()
        .cloned()
        .fold(builder.tls_built_in_root_certs(false), |builder, root| {
            builder.add_root_certificate(root)
        })
}

pub(crate) fn blocking_builder(
    proxy: &ProxyConfig,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    apply_blocking_proxy(
        reqwest::blocking::Client::builder().user_agent(user_agent()),
        proxy,
    )
}

fn apply_proxy(
    builder: reqwest::ClientBuilder,
    proxy: &ProxyConfig,
) -> Result<reqwest::ClientBuilder, String> {
    Ok(match proxy {
        ProxyConfig::Invalid(error) => return Err(error.clone()),
        ProxyConfig::Off => builder.no_proxy(),
        ProxyConfig::System => builder,
        ProxyConfig::Http(manual) | ProxyConfig::Socks(manual) => builder.proxy(
            manual
                .reqwest_proxy()
                .map_err(|error| error.without_url().to_string())?,
        ),
    })
}

fn apply_blocking_proxy(
    builder: reqwest::blocking::ClientBuilder,
    proxy: &ProxyConfig,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    Ok(match proxy {
        ProxyConfig::Invalid(error) => return Err(error.clone()),
        ProxyConfig::Off => builder.no_proxy(),
        ProxyConfig::System => builder,
        ProxyConfig::Http(manual) | ProxyConfig::Socks(manual) => builder.proxy(
            manual
                .reqwest_proxy()
                .map_err(|error| error.without_url().to_string())?,
        ),
    })
}

fn user_agent() -> &'static str {
    concat!("Spotifast/", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // TCP read boundaries are unrelated to HTTP headers. Keeping both fixture
    // endpoints open until the full head arrives also prevents resets when the
    // client's remaining header bytes race an early fixture response/close.
    fn read_http_head(reader: &mut impl std::io::Read) -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = match reader.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "fixture HTTP headers were incomplete",
                ));
            }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(bytes);
            }
            if bytes.len() > 64 * 1024 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture HTTP headers exceeded 64 KiB",
                ));
            }
        }
    }

    #[test]
    fn proxy_fixture_reads_headers_split_across_tcp_packets() {
        struct Fragmented(std::io::Cursor<Vec<u8>>);
        impl std::io::Read for Fragmented {
            fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
                std::io::Read::read(&mut self.0, &mut target[..1])
            }
        }
        let expected =
            b"GET http://example.invalid/catalogue HTTP/1.1\r\nHost: example.invalid\r\n\r\n";
        let mut fragmented = Fragmented(std::io::Cursor::new(expected.to_vec()));
        assert_eq!(read_http_head(&mut fragmented).unwrap(), expected);
        assert!(read_http_head(&mut std::io::Cursor::new(b"GET / HTTP/1.1\r\n")).is_err());
    }

    #[test]
    fn invalid_proxy_configuration_never_falls_back_to_a_direct_client() {
        let invalid = ProxyConfig::Invalid("Proxy port must be a number".into());
        assert!(Http::from_proxy(&invalid).is_err());
        assert!(build_blocking(&invalid, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn unavailable_clients_stay_blocked_until_a_successful_replacement() {
        let http = Http::unavailable("Unable to build the configured client".into());
        let artwork = http.clone();
        let api = http.clone();
        assert!(artwork.client().is_err());
        assert!(api.client().is_err());
        http.replace(build_client(&ProxyConfig::Off).unwrap());
        assert!(artwork.client().is_ok());
        assert!(api.client().is_ok());
    }

    #[test]
    fn every_client_trusts_the_system_roots_read_once() {
        let roots = native_roots();
        assert!(!roots.is_empty(), "the system trusts some roots");
        assert!(std::ptr::eq(roots, native_roots()));
        trusting_native_roots(reqwest::Client::builder())
            .build()
            .unwrap();
    }

    #[test]
    fn a_client_built_in_the_background_is_waited_for_and_still_replaceable() {
        let (sender, failures) = std::sync::mpsc::channel::<String>();
        let http = Http::build_in_background(ProxyConfig::Off, move |error| {
            let _ = sender.send(error.to_owned());
        });
        assert!(
            http.clone().client().is_ok(),
            "the first reader waits for it"
        );
        assert!(failures.try_recv().is_err());
        http.block("Proxy settings changed".into());
        assert!(http.client().is_err());
        http.replace(build_client(&ProxyConfig::Off).unwrap());
        assert!(http.client().is_ok());
    }

    #[test]
    fn a_background_build_that_fails_says_why_and_stays_unavailable() {
        let (sender, failures) = std::sync::mpsc::channel::<String>();
        let invalid = ProxyConfig::Invalid("Proxy port must be a number".into());
        let http = Http::build_in_background(invalid, move |error| {
            let _ = sender.send(error.to_owned());
        });
        assert_eq!(http.client().unwrap_err(), "Proxy port must be a number");
        assert_eq!(
            failures.recv_timeout(Duration::from_secs(10)).unwrap(),
            "Proxy port must be a number"
        );
    }

    #[test]
    fn replacing_the_client_is_visible_to_clones() {
        let http = Http::default();
        let clone = http.clone();
        let replacement = reqwest::Client::builder()
            .user_agent("spotifast-test")
            .build()
            .unwrap();
        http.replace(replacement.clone());
        // Distinct Client values still share the pool after a replace; the
        // lock is what matters, and a second replace of a dummy client
        // must not panic.
        clone.replace(reqwest::Client::new());
    }

    #[test]
    fn off_system_and_socks5_each_build_a_client() {
        build_client(&ProxyConfig::Off).unwrap();
        build_client(&ProxyConfig::System).unwrap();
        let settings = crate::settings::Settings {
            proxy_mode: crate::settings::ProxyMode::Socks,
            proxy_host: "127.0.0.1".into(),
            proxy_port: "1080".into(),
            proxy_username: "user".into(),
            proxy_password: "pass".into(),
            ..crate::settings::Settings::default()
        };
        let proxy = settings.proxy_config().unwrap();
        build_client(&proxy).unwrap();
        build_blocking(&proxy, Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn web_api_client_goes_through_an_http_proxy() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;

        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_addr = origin.local_addr().unwrap();
        let origin_thread = thread::spawn(move || {
            let (mut stream, _) = origin.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let request = String::from_utf8(read_http_head(&mut stream).unwrap()).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
                )
                .unwrap();
            request
        });

        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (mut client, _) = proxy.accept().unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let request = read_http_head(&mut client).unwrap();
            let head = String::from_utf8(request.clone()).unwrap();
            let mut upstream = std::net::TcpStream::connect(origin_addr).unwrap();
            upstream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            upstream.write_all(&request).unwrap();
            let mut response = Vec::new();
            upstream.read_to_end(&mut response).unwrap();
            client.write_all(&response).unwrap();
            head
        });

        let settings = crate::settings::Settings {
            proxy_mode: crate::settings::ProxyMode::Http,
            proxy_host: proxy_addr.ip().to_string(),
            proxy_port: proxy_addr.port().to_string(),
            ..crate::settings::Settings::default()
        };
        let proxy_config = settings.proxy_config().unwrap();
        let client = build_blocking(&proxy_config, Duration::from_secs(10)).unwrap();
        let body = client
            .get(format!("http://{origin_addr}/catalogue"))
            .send()
            .unwrap()
            .text()
            .unwrap();
        assert_eq!(body, "proxied");
        let seen_by_proxy = proxy_thread.join().unwrap();
        assert!(
            seen_by_proxy.contains("catalogue"),
            "proxy should see the Web API request, got {seen_by_proxy:?}"
        );
        let seen_by_origin = origin_thread.join().unwrap();
        assert!(seen_by_origin.contains("GET"));
    }

    #[test]
    fn proxy_authentication_preserves_opaque_credentials() {
        use base64::Engine;
        use std::io::Write;
        use std::net::TcpListener;
        use std::thread;

        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (mut client, _) = proxy.accept().unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let head = String::from_utf8(read_http_head(&mut client).unwrap()).unwrap();
            client
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            head
        });

        let username = "alice/name";
        let password = " secret/with spaces ";
        let settings = crate::settings::Settings {
            proxy_mode: crate::settings::ProxyMode::Http,
            proxy_host: proxy_addr.ip().to_string(),
            proxy_port: proxy_addr.port().to_string(),
            proxy_username: username.into(),
            proxy_password: password.into(),
            ..crate::settings::Settings::default()
        };
        let proxy_config = settings.proxy_config().unwrap();
        let client = build_blocking(&proxy_config, Duration::from_secs(10)).unwrap();
        assert_eq!(
            client
                .get("http://example.invalid/catalogue")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        let seen = proxy_thread.join().unwrap();
        let expected =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        assert!(
            seen.lines()
                .any(|line| line
                    .eq_ignore_ascii_case(&format!("Proxy-Authorization: Basic {expected}"))),
            "proxy did not receive the exact configured credentials"
        );
    }

    #[test]
    fn socks5_authentication_and_hostname_resolution_use_the_selected_proxy() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "SOCKS5 proxy was not contacted"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture listener: {error}"),
                }
            };
            // Accepted sockets inherit O_NONBLOCK on macOS. The fixture uses
            // blocking reads after its bounded, nonblocking accept loop.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut pair = [0; 2];
            stream.read_exact(&mut pair).unwrap();
            assert_eq!(pair[0], 5);
            let mut methods = vec![0; pair[1] as usize];
            stream.read_exact(&mut methods).unwrap();
            assert!(methods.contains(&2));
            stream.write_all(&[5, 2]).unwrap();
            stream.read_exact(&mut pair).unwrap();
            assert_eq!(pair[0], 1);
            let mut username = vec![0; pair[1] as usize];
            stream.read_exact(&mut username).unwrap();
            let mut size = [0; 1];
            stream.read_exact(&mut size).unwrap();
            let mut password = vec![0; size[0] as usize];
            stream.read_exact(&mut password).unwrap();
            assert_eq!(username, b"dummy-user");
            assert_eq!(password, b" dummy-password ");
            stream.write_all(&[1, 0]).unwrap();
            let mut command = [0; 4];
            stream.read_exact(&mut command).unwrap();
            assert_eq!(
                command,
                [5, 1, 0, 3],
                "send the hostname for resolution at the proxy"
            );
            stream.read_exact(&mut size).unwrap();
            let mut hostname = vec![0; size[0] as usize];
            stream.read_exact(&mut hostname).unwrap();
            assert_eq!(hostname, b"example.invalid");
            stream.read_exact(&mut pair).unwrap();
            assert_eq!(u16::from_be_bytes(pair), 80);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .unwrap();
            let request = read_http_head(&mut stream).unwrap();
            assert!(String::from_utf8_lossy(&request).starts_with("GET /catalogue HTTP/1.1"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let proxy = crate::settings::Settings {
            proxy_mode: crate::settings::ProxyMode::Socks,
            proxy_host: address.ip().to_string(),
            proxy_port: address.port().to_string(),
            proxy_username: "dummy-user".into(),
            proxy_password: " dummy-password ".into(),
            ..Default::default()
        }
        .proxy_config()
        .unwrap();
        let client = build_blocking(&proxy, Duration::from_secs(3)).unwrap();
        assert_eq!(
            client
                .get("http://example.invalid/catalogue")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn librespot_http_client_sends_connect_through_an_http_proxy() {
        use std::io::Write;
        use std::net::TcpListener;
        use std::thread;

        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (mut client, _) = proxy.accept().unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let head = read_http_head(&mut client).unwrap();
            let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
            String::from_utf8(head).unwrap()
        });

        let proxy_url = reqwest::Url::parse(&format!("http://{proxy_addr}")).unwrap();
        let client = librespot_core::http_client::HttpClient::new(Some(&proxy_url));
        let request = http::Request::builder()
            .method("GET")
            .uri("https://apresolve.spotify.com/")
            .body(Default::default())
            .unwrap();
        let _ = client.request(request).await;
        let seen = proxy_thread.join().unwrap();
        assert!(
            seen.to_ascii_uppercase().contains("CONNECT") && seen.contains("apresolve.spotify.com"),
            "librespot should CONNECT through the proxy, got {seen:?}"
        );
    }
}
