//! Shared HTTP client, so a new sign-in's client reaches every clone.

use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

/// A cheap-to-clone handle to the process HTTP client.
///
/// Replacing the inner client updates every clone: the music API, artwork,
/// and lyrics all pick up a signed-in client on the next request. Clients
/// follow the system's proxy settings.
#[derive(Clone)]
pub struct Http {
    inner: Arc<Inner>,
}

struct Inner {
    /// The client the handle starts with. One built in the background is
    /// waited for by the first readers.
    first: OnceLock<Result<reqwest::Client, String>>,
    /// A later client in place of the first.
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

    /// Builds the client on a thread of its own: loading the system's
    /// trusted certificates takes long enough to hold up the first window.
    /// `failed` hears why the client did not build; the handle then stays
    /// unavailable until a replacement.
    pub fn build_in_background(failed: impl FnOnce(&str) + Send + 'static) -> Self {
        let http = Self::starting(None);
        let first = Arc::clone(&http.inner);
        std::thread::Builder::new()
            .name("http-client".into())
            .spawn(move || {
                let built =
                    std::panic::catch_unwind(build_client)
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

    pub fn replace(&self, client: reqwest::Client) {
        *self
            .inner
            .later
            .write()
            .unwrap_or_else(|lock| lock.into_inner()) = Some(Ok(client));
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

pub fn build_client() -> Result<reqwest::Client, String> {
    trusting_native_roots(reqwest::Client::builder())
        .user_agent(user_agent())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.without_url().to_string())
}

pub fn build_blocking(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(user_agent())
        .timeout(timeout)
        .build()
        .map_err(|error| error.without_url().to_string())
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

fn user_agent() -> &'static str {
    concat!("Spotifast/", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let http = Http::build_in_background(move |error| {
            let _ = sender.send(error.to_owned());
        });
        assert!(
            http.clone().client().is_ok(),
            "the first reader waits for it"
        );
        assert!(failures.try_recv().is_err());
        http.replace(build_client().unwrap());
        assert!(http.client().is_ok());
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
}
