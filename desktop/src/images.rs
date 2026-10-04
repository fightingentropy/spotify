//! Album art: fetched once, kept on disk, decoded by egui on demand.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use egui::load::{Bytes, BytesLoadResult, BytesLoader, BytesPoll, ImagePoll, LoadError};
use sha1::{Digest, Sha1};

use crate::http::Http;

/// Maximum artwork bytes held in memory.
///
/// Time-based eviction does not work here: after creating a texture, egui no
/// longer requests its source bytes. Visible images were therefore evicted and
/// reloaded every two and a half minutes (#129).
///
/// Size-based eviction keeps visible images stable.
const HELD_BYTES: usize = 64 * 1024 * 1024;
const MAX_ART_BYTES: usize = 8 * 1024 * 1024;

/// Decoded ColorImage plus the GPU texture, both RGBA.
fn decoded_and_texture_bytes(width: usize, height: usize) -> usize {
    2 * width.saturating_mul(height).saturating_mul(4)
}

/// What this loader answers for. egui offers it every URI, and artwork that
/// is not fetched over the network belongs to another loader.
fn is_http(uri: &str) -> bool {
    uri.starts_with("https://") || uri.starts_with("http://")
}

/// The picture a URL names: the URL without the expiry and signature the
/// music server issues afresh with every response. Each picture is then
/// fetched, held, and stored once, whichever signature it arrives with.
fn artwork_key(url: &str) -> Cow<'_, str> {
    let Some((base, query)) = url.split_once('?') else {
        return Cow::Borrowed(url);
    };
    let (query, fragment) = match query.split_once('#') {
        Some((query, fragment)) => (query, Some(fragment)),
        None => (query, None),
    };
    let signed = |pair: &&str| {
        let name = pair.split_once('=').map_or(*pair, |(name, _)| name);
        matches!(name, "spotify_exp" | "spotify_sig")
    };
    if !query.split('&').any(|pair| signed(&pair)) {
        return Cow::Borrowed(url);
    }
    let kept: Vec<&str> = query.split('&').filter(|pair| !signed(pair)).collect();
    let mut key = base.to_owned();
    if !kept.is_empty() {
        key.push('?');
        key.push_str(&kept.join("&"));
    }
    if let Some(fragment) = fragment {
        key.push('#');
        key.push_str(fragment);
    }
    Cow::Owned(key)
}

enum Entry {
    Pending,
    Ready {
        bytes: Option<Arc<[u8]>>,
        last_used: Instant,
        /// JPEG bytes still held, plus decoded image and texture once painted.
        retained: usize,
    },
    /// The URL that failed: one signed afresh is tried again.
    Failed {
        url: String,
        error: String,
    },
}

struct Inner {
    /// By [`artwork_key`].
    entries: Mutex<HashMap<String, Entry>>,
    /// The URLs egui has drawn each picture under, by [`artwork_key`], so
    /// letting a picture go frees every texture made of it.
    drawn_as: Mutex<HashMap<String, Vec<String>>>,
    /// The latest signed URL of each picture drawn by its key, which the
    /// picture is fetched with.
    signed: Mutex<HashMap<String, String>>,
    http: Http,
    runtime: tokio::runtime::Handle,
    cache_dir: PathBuf,
}

#[derive(Clone)]
pub struct ArtLoader {
    inner: Arc<Inner>,
}

impl ArtLoader {
    pub fn new(http: impl Into<Http>, runtime: tokio::runtime::Handle, cache_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&cache_dir);
        Self {
            inner: Arc::new(Inner {
                entries: Mutex::new(HashMap::new()),
                drawn_as: Mutex::new(HashMap::new()),
                signed: Mutex::new(HashMap::new()),
                http: http.into(),
                runtime,
                cache_dir,
            }),
        }
    }

    /// The URI to draw `url`'s picture under: the same whichever signature
    /// `url` carries, so egui decodes and holds the picture once, and a
    /// fresh signature changes nothing on screen. `url` is kept to fetch
    /// the picture with.
    pub fn drawable<'a>(&self, url: &'a str) -> Cow<'a, str> {
        let key = artwork_key(url);
        if let Cow::Owned(key) = &key {
            let mut signed = self.inner.signed.lock().unwrap_or_else(|p| p.into_inner());
            if signed.get(key).is_none_or(|known| known != url) {
                signed.insert(key.clone(), url.to_owned());
            }
        }
        key
    }

    /// Bytes for `url`, from memory, disk, or the network.
    pub async fn fetch(&self, url: &str) -> Result<Arc<[u8]>, String> {
        self.inner.fetch(url).await
    }

    /// Whether artwork has finished loading from disk or the network.
    pub fn is_ready(&self, url: &str) -> bool {
        matches!(
            self.inner
                .entries
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(artwork_key(url).as_ref()),
            Some(Entry::Ready { .. })
        )
    }

    /// Marks artwork as visible so size-based eviction keeps it stable.
    pub fn touch(&self, url: &str) {
        if let Some(Entry::Ready { last_used, .. }) = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(artwork_key(url).as_ref())
        {
            *last_used = Instant::now();
        }
    }

    /// Evicts failed entries and the oldest artwork above the memory limit.
    pub fn evict(&self, ctx: &egui::Context) {
        let letting_go: Vec<String> = {
            let entries = self.inner.entries.lock().unwrap_or_else(|p| p.into_inner());
            let mut failed: Vec<String> = Vec::new();
            let mut held: Vec<(String, Instant, usize)> = Vec::new();
            for (url, entry) in entries.iter() {
                match entry {
                    // Forget failures so a later request can retry.
                    Entry::Failed { .. } => failed.push(url.clone()),
                    Entry::Ready {
                        last_used,
                        retained,
                        ..
                    } => {
                        held.push((url.clone(), *last_used, *retained));
                    }
                    Entry::Pending => {}
                }
            }
            failed.extend(over_budget(held, HELD_BYTES));
            failed
        };
        for key in letting_go {
            let drawn = self
                .inner
                .drawn_as
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key)
                .unwrap_or_default();
            for url in drawn {
                ctx.forget_image(&url);
            }
            self.forget(&key);
        }
    }

    /// The disk-cache file holding `url`'s artwork, once it has been fetched.
    ///
    /// The cache is written atomically (a `.part` file, then a rename), so a
    /// file that is here at all holds a complete, successful response. The
    /// desktop media controls hand this path to the platform instead of the
    /// remote URL: macOS loads cover art itself, synchronously, inside a
    /// callback that cannot report a failure.
    pub fn cached_file(&self, url: &str) -> Option<PathBuf> {
        let path = self.inner.cache_path(url);
        std::fs::metadata(&path)
            .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
            .then_some(path)
    }

    /// Starts the download for `url` while nothing is drawing it, so the
    /// media controls have a file to hand the platform, and answers whether
    /// this call is what started it.
    ///
    /// Artwork already held, already on its way, or addressed by a scheme
    /// this loader does not answer for is left alone.
    pub fn prefetch(&self, ctx: &egui::Context, url: &str) -> bool {
        if !is_http(url) {
            return false;
        }
        let mut entries = self.inner.entries.lock().unwrap_or_else(|p| p.into_inner());
        let key = artwork_key(url);
        if entries.contains_key(key.as_ref()) {
            return false;
        }
        entries.insert(key.into_owned(), Entry::Pending);
        drop(entries);
        self.inner.start(ctx, url.to_string());
        true
    }

    /// Drops held JPEG bytes once egui has made a texture. The disk cache
    /// remains for later reloads.
    pub fn release_bytes(&self, url: &str) {
        self.inner.drop_bytes(url);
    }

    /// Record decoded image + texture size after egui has uploaded the cover.
    pub fn note_decoded(&self, url: &str, width: usize, height: usize) {
        if let Some(Entry::Ready {
            bytes, retained, ..
        }) = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(artwork_key(url).as_ref())
        {
            let jpeg = bytes.as_ref().map(|bytes| bytes.len()).unwrap_or(0);
            *retained = jpeg + decoded_and_texture_bytes(width, height);
        }
    }

    pub fn clear_disk_cache(&self) -> std::io::Result<u64> {
        let mut removed = 0;
        for entry in std::fs::read_dir(&self.inner.cache_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                removed += entry.metadata().map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(removed)
    }
}

/// Which artwork to let go of so that what is kept fits `budget`,
/// oldest first.
///
/// "Oldest" is when egui last needed the bytes, which for a picture it
/// has already made a texture of is when it first loaded. That makes
/// this a rough order rather than a true reading of what is on screen,
/// which is why the budget is generous: being roughly right about which
/// to drop only matters once there is far more artwork than any window
/// is showing.
fn over_budget(mut held: Vec<(String, Instant, usize)>, budget: usize) -> Vec<String> {
    let mut total: usize = held.iter().map(|(_, _, bytes)| bytes).sum();
    if total <= budget {
        return Vec::new();
    }
    held.sort_by_key(|(_, last_used, _)| *last_used);
    let mut letting_go = Vec::new();
    for (url, _, bytes) in held {
        if total <= budget {
            break;
        }
        total = total.saturating_sub(bytes);
        letting_go.push(url);
    }
    letting_go
}

impl Inner {
    fn cache_path(&self, url: &str) -> PathBuf {
        let digest = Sha1::digest(artwork_key(url).as_bytes());
        let mut name = String::with_capacity(40);
        for byte in digest {
            use std::fmt::Write;
            let _ = write!(name, "{byte:02x}");
        }
        self.cache_dir.join(name)
    }

    async fn fetch(self: &Arc<Self>, url: &str) -> Result<Arc<[u8]>, String> {
        if let Some(Entry::Ready {
            bytes: Some(bytes), ..
        }) = self
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(artwork_key(url).as_ref())
        {
            return Ok(Arc::clone(bytes));
        }
        let path = self.cache_path(url);
        let cached = tokio::task::spawn_blocking({
            let path = path.clone();
            move || std::fs::read(path).ok()
        })
        .await
        .ok()
        .flatten();
        let bytes: Arc<[u8]> = match cached {
            Some(bytes) if !bytes.is_empty() => Arc::from(bytes),
            _ => {
                let mut response = self
                    .http
                    .client()?
                    .get(url)
                    .send()
                    .await
                    .map_err(|error| error.without_url().to_string())?;
                if !response.status().is_success() {
                    return Err(format!("artwork request failed: {}", response.status()));
                }
                if response
                    .content_length()
                    .is_some_and(|size| size > MAX_ART_BYTES as u64)
                {
                    return Err("artwork is too large".to_string());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|error| error.without_url().to_string())?
                {
                    if bytes.len().saturating_add(chunk.len()) > MAX_ART_BYTES {
                        return Err("artwork is too large".to_string());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                // The loader and file worker share one immutable payload.
                let bytes: Arc<[u8]> = Arc::from(bytes);
                let write_path = path.clone();
                let payload = Arc::clone(&bytes);
                self.runtime.spawn_blocking(move || {
                    let temporary = write_path.with_extension("part");
                    if std::fs::write(&temporary, &payload).is_ok() {
                        let _ = std::fs::rename(&temporary, &write_path);
                    }
                });
                bytes
            }
        };
        Ok(bytes)
    }

    fn start(self: &Arc<Self>, ctx: &egui::Context, url: String) {
        let loader = Arc::clone(self);
        let ctx = ctx.clone();
        self.runtime.spawn(async move {
            let result = loader.fetch(&url).await;
            let key = artwork_key(&url).into_owned();
            let entry = match result {
                Ok(bytes) => Entry::Ready {
                    retained: bytes.len(),
                    bytes: Some(bytes),
                    last_used: Instant::now(),
                },
                Err(error) => Entry::Failed { url, error },
            };
            loader
                .entries
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(key, entry);
            ctx.request_repaint();
        });
    }

    fn drop_bytes(&self, url: &str) {
        if let Some(Entry::Ready {
            bytes, retained, ..
        }) = self
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(artwork_key(url).as_ref())
            && let Some(held) = bytes.take()
        {
            *retained = retained.saturating_sub(held.len());
        }
    }
}

impl BytesLoader for ArtLoader {
    fn id(&self) -> &'static str {
        "spotifast::ArtLoader"
    }

    fn load(&self, ctx: &egui::Context, uri: &str) -> BytesLoadResult {
        if !is_http(uri) {
            return Err(LoadError::NotSupported);
        }
        let key = artwork_key(uri).into_owned();
        // Drawn by its key, a picture is fetched with its latest signature.
        let url = self
            .inner
            .signed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            .cloned()
            .unwrap_or_else(|| uri.to_owned());
        {
            let mut drawn_as = self
                .inner
                .drawn_as
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let urls = drawn_as.entry(key.clone()).or_default();
            if !urls.iter().any(|url| url == uri) {
                urls.push(uri.to_owned());
            }
        }
        let mut entries = self.inner.entries.lock().unwrap_or_else(|p| p.into_inner());
        match entries.get_mut(&key) {
            Some(Entry::Ready {
                bytes: Some(bytes),
                last_used,
                ..
            }) => {
                *last_used = Instant::now();
                Ok(BytesPoll::Ready {
                    size: None,
                    bytes: Bytes::Shared(Arc::clone(bytes)),
                    mime: None,
                })
            }
            Some(Entry::Ready {
                bytes: None,
                last_used,
                ..
            }) => {
                *last_used = Instant::now();
                entries.insert(key, Entry::Pending);
                drop(entries);
                self.inner.start(ctx, url);
                Ok(BytesPoll::Pending { size: None })
            }
            Some(Entry::Pending) => Ok(BytesPoll::Pending { size: None }),
            Some(Entry::Failed { url: failed, error }) if *failed == url => {
                Err(LoadError::Loading(error.clone()))
            }
            Some(Entry::Failed { .. }) | None => {
                entries.insert(key, Entry::Pending);
                drop(entries);
                self.inner.start(ctx, url);
                Ok(BytesPoll::Pending { size: None })
            }
        }
    }

    fn forget(&self, uri: &str) {
        let key = artwork_key(uri);
        self.inner
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key.as_ref());
        if let Some(urls) = self
            .inner
            .drawn_as
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(key.as_ref())
        {
            urls.retain(|url| url != uri);
        }
    }

    fn forget_all(&self) {
        self.inner
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.inner
            .drawn_as
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    fn byte_size(&self) -> usize {
        self.inner
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(|entry| match entry {
                Entry::Ready {
                    bytes: Some(bytes), ..
                } => bytes.len(),
                _ => 0,
            })
            .sum()
    }
}

/// Blur applied to a library thumbnail standing in for a cover.
///
/// The thumbnail already carries little detail, so use a light blur to
/// preserve its identity while higher-resolution artwork loads.
const COVER_BLUR: f32 = 1.5;

/// Softened covers held at once, for library artwork seen recently.
const HELD_COVERS: usize = 64;

fn terminal_art_error(error: &LoadError) -> bool {
    matches!(error, LoadError::NotSupported)
}

/// Softened artwork for covers that are still loading, one entry per URL.
///
/// A library row's small thumbnail is already on screen when its page opens,
/// so enlarging it blurred stands in for the cover until the full artwork
/// arrives. Blurring happens off the UI thread and the result is kept, so a
/// cover that is opened, left, and opened again shows softened art at once.
struct SoftenedCover {
    texture: egui::TextureHandle,
    last_used: Instant,
}

type SoftenedResult = (String, Option<egui::ColorImage>);

pub struct SoftenedCovers {
    textures: HashMap<String, SoftenedCover>,
    pending: HashSet<String>,
    failed: HashSet<String>,
    ready_tx: std::sync::mpsc::Sender<SoftenedResult>,
    ready_rx: std::sync::mpsc::Receiver<SoftenedResult>,
}

impl Default for SoftenedCovers {
    fn default() -> Self {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        Self {
            textures: HashMap::new(),
            pending: HashSet::new(),
            failed: HashSet::new(),
            ready_tx,
            ready_rx,
        }
    }
}

impl SoftenedCovers {
    fn receive_ready(&mut self, ctx: &egui::Context) {
        while let Ok((ready_uri, image)) = self.ready_rx.try_recv() {
            self.pending.remove(&ready_uri);
            if let Some(image) = image {
                if self.textures.len() >= HELD_COVERS
                    && let Some(oldest) = self
                        .textures
                        .iter()
                        .min_by_key(|(_, cover)| cover.last_used)
                        .map(|(uri, _)| uri.clone())
                {
                    self.textures.remove(&oldest);
                }
                let texture =
                    ctx.load_texture("softened-cover", image, egui::TextureOptions::LINEAR);
                self.textures.insert(
                    ready_uri,
                    SoftenedCover {
                        texture,
                        last_used: Instant::now(),
                    },
                );
            } else {
                self.failed.insert(ready_uri);
            }
        }
    }

    /// The softened cover for `uri`, blurring it in the background the first
    /// time it is asked for.
    pub fn texture(
        &mut self,
        ctx: &egui::Context,
        loader: &ArtLoader,
        uri: &str,
    ) -> Option<egui::TextureHandle> {
        self.receive_ready(ctx);
        let uri = loader.drawable(uri);
        let uri = uri.as_ref();
        if let Some(cover) = self.textures.get_mut(uri) {
            cover.last_used = Instant::now();
            return Some(cover.texture.clone());
        }
        if self.failed.contains(uri)
            || self.pending.contains(uri)
            || self.pending.len() >= HELD_COVERS
        {
            return None;
        }
        // The visible thumbnail has already been decoded by egui. Its source
        // bytes may have been released by paint_cover_url, which would discard
        // them again on the next frame before this consumer could use them.
        match ctx.try_load_image(uri, Default::default()) {
            Ok(ImagePoll::Ready { image }) => {
                let ready_tx = self.ready_tx.clone();
                let ready_uri = uri.to_string();
                let ctx = ctx.clone();
                self.pending.insert(ready_uri.clone());
                loader.inner.runtime.spawn_blocking(move || {
                    let image = softened_background(&image);
                    let _ = ready_tx.send((ready_uri, image));
                    ctx.request_repaint();
                });
            }
            Err(error) if terminal_art_error(&error) => {
                self.failed.insert(uri.to_string());
            }
            _ => {}
        }
        None
    }
}

fn softened_background(image: &egui::ColorImage) -> Option<egui::ColorImage> {
    let [width, height] = image.size;
    if width > 8192 || height > 8192 || image.pixels.len() > 64 * 1024 * 1024 / 4 {
        return None;
    }
    let pixels = image
        .pixels
        .iter()
        .flat_map(egui::Color32::to_srgba_unmultiplied)
        .collect();
    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    Some(blurred_image(image.into(), COVER_BLUR))
}

fn blurred_image(image: image::DynamicImage, sigma: f32) -> egui::ColorImage {
    let image = image.thumbnail(256, 256).blur(sigma).to_rgba8();
    egui::ColorImage::from_rgba_unmultiplied(
        [image.width() as usize, image.height() as usize],
        image.as_raw(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn serve_artwork(status: &str, bytes: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/cover", listener.local_addr().unwrap());
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(10), async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                    assert!(request.len() < 8192);
                }
                socket.write_all(header.as_bytes()).await.unwrap();
                if let Err(error) = socket.write_all(&bytes).await {
                    // The bounded reader deliberately closes oversized responses early.
                    assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ));
                }
            })
            .await
            .expect("the owned artwork request completes");
        });
        (url, server)
    }

    fn artwork_test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn artwork_test_loader(runtime: &tokio::runtime::Runtime, dir: PathBuf) -> ArtLoader {
        ArtLoader::new(
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            runtime.handle().clone(),
            dir,
        )
    }

    async fn wait_for_artwork_file(path: &std::path::Path, expected: &[u8]) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if tokio::fs::read(path)
                    .await
                    .is_ok_and(|bytes| bytes == expected)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the background writer completes while its runtime is alive");
    }

    #[test]
    fn downloaded_artwork_survives_caller_drop_and_reloads_without_network() {
        let dir =
            std::env::temp_dir().join(format!("spotifast-art-roundtrip-{}", std::process::id()));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        let expected: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
        let url = runtime.block_on(async {
            let (url, server) = serve_artwork("200 OK", expected.clone()).await;
            let bytes = loader.fetch(&url).await.expect("downloaded artwork");
            assert_eq!(&*bytes, expected.as_slice());
            drop(bytes);
            server.await.unwrap();
            wait_for_artwork_file(&loader.inner.cache_path(&url), &expected).await;
            url
        });
        let path = loader.inner.cache_path(&url);
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert!(!path.with_extension("part").exists());

        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        // The server is gone. A new loader must recover the original bytes
        // from the completed cache, without requesting the URL again.
        assert_eq!(&*runtime.block_on(loader.fetch(&url)).unwrap(), expected);
        assert_eq!(loader.cached_file(&url), Some(path));
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn artwork_cache_write_failure_keeps_download_usable() {
        let dir = std::env::temp_dir().join(format!(
            "spotifast-art-write-failure-{}",
            std::process::id()
        ));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        let (bytes, path) = runtime.block_on(async {
            let (url, server) = serve_artwork("200 OK", b"complete artwork".to_vec()).await;
            let path = loader.inner.cache_path(&url);
            // A directory cannot be replaced by a file, even by an admin.
            std::fs::create_dir(&path).unwrap();
            let bytes = loader
                .fetch(&url)
                .await
                .expect("display does not depend on caching");
            server.await.unwrap();
            wait_for_artwork_file(&path.with_extension("part"), b"complete artwork").await;
            (bytes, path)
        });
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        assert_eq!(&*bytes, b"complete artwork");
        assert!(
            path.is_dir(),
            "the failed replacement preserves the old path"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejected_artwork_responses_do_not_create_cache_files() {
        let dir =
            std::env::temp_dir().join(format!("spotifast-art-rejected-{}", std::process::id()));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        runtime.block_on(async {
            for (status, body, message) in [
                ("404 Not Found", Vec::new(), "artwork request failed: 404"),
                ("200 OK", vec![1; MAX_ART_BYTES + 1], "artwork is too large"),
            ] {
                let (url, server) = serve_artwork(status, body).await;
                let error = loader.fetch(&url).await.unwrap_err();
                assert!(error.starts_with(message), "{error}");
                server.await.unwrap();
            }
        });
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Answers one request per response, in turn, and reports what each
    /// asked for.
    async fn serve_artwork_requests(
        responses: Vec<(&'static str, Vec<u8>)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/cover", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut targets = Vec::new();
            for (status, bytes) in responses {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(10), listener.accept())
                        .await
                        .expect("the artwork is asked for")
                        .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                let line = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned();
                targets.push(line.split(' ').nth(1).unwrap().to_owned());
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&bytes).await.unwrap();
            }
            targets
        });
        (url, server)
    }

    async fn until(mut done: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !done() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the artwork settles");
    }

    #[test]
    fn a_pictures_key_leaves_out_only_the_expiring_signature() {
        let signed = "https://music.example/api/files/local/a.jpg?spotify_exp=99&spotify_scope=media&spotify_sig=abc&spotify_user=u1";
        assert_eq!(
            artwork_key(signed),
            "https://music.example/api/files/local/a.jpg?spotify_scope=media&spotify_user=u1"
        );
        assert_eq!(
            artwork_key("https://music.example/a.jpg?spotify_sig=abc&spotify_exp=99"),
            "https://music.example/a.jpg"
        );
        let plain = "https://i.scdn.co/image/abc?size=640#top";
        assert!(matches!(artwork_key(plain), Cow::Borrowed(key) if key == plain));
    }

    #[test]
    fn a_picture_is_downloaded_once_whichever_signature_it_carries() {
        let dir = std::env::temp_dir().join(format!("spotifast-art-signed-{}", std::process::id()));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        runtime.block_on(async {
            let (base, server) = serve_artwork_requests(vec![("200 OK", b"cover".to_vec())]).await;
            let first = format!("{base}?spotify_exp=1&spotify_sig=a");
            let second = format!("{base}?spotify_exp=2&spotify_sig=b");
            assert_eq!(loader.drawable(&first), loader.drawable(&second));
            assert_eq!(&*loader.fetch(&first).await.unwrap(), b"cover");
            assert_eq!(
                server.await.unwrap(),
                ["/cover?spotify_exp=1&spotify_sig=a"]
            );
            wait_for_artwork_file(&loader.inner.cache_path(&first), b"cover").await;
            // Nothing answers now: the second signature comes from the cache.
            assert_eq!(&*loader.fetch(&second).await.unwrap(), b"cover");
            assert_eq!(loader.cached_file(&second), loader.cached_file(&first));
        });
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_picture_drawn_by_its_key_is_fetched_with_its_latest_signature() {
        let dir = std::env::temp_dir().join(format!("spotifast-art-latest-{}", std::process::id()));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        let ctx = egui::Context::default();
        runtime.block_on(async {
            let (base, server) = serve_artwork_requests(vec![("200 OK", b"cover".to_vec())]).await;
            let stale = format!("{base}?spotify_exp=1&spotify_sig=old");
            let fresh = format!("{base}?spotify_exp=2&spotify_sig=new");
            let uri = loader.drawable(&stale).into_owned();
            assert_eq!(loader.drawable(&fresh), uri.as_str());
            assert!(matches!(
                loader.load(&ctx, &uri),
                Ok(BytesPoll::Pending { .. })
            ));
            assert_eq!(
                server.await.unwrap(),
                ["/cover?spotify_exp=2&spotify_sig=new"]
            );
            until(|| loader.is_ready(&uri)).await;
            assert!(matches!(
                loader.load(&ctx, &uri),
                Ok(BytesPoll::Ready { .. })
            ));
        });
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_picture_refused_under_an_expired_signature_is_tried_with_a_fresh_one() {
        let dir =
            std::env::temp_dir().join(format!("spotifast-art-expired-{}", std::process::id()));
        let runtime = artwork_test_runtime();
        let loader = artwork_test_loader(&runtime, dir.clone());
        let ctx = egui::Context::default();
        runtime.block_on(async {
            let (base, server) = serve_artwork_requests(vec![
                ("403 Forbidden", Vec::new()),
                ("200 OK", b"cover".to_vec()),
            ])
            .await;
            let expired = format!("{base}?spotify_exp=1&spotify_sig=old");
            let uri = loader.drawable(&expired).into_owned();
            assert!(matches!(
                loader.load(&ctx, &uri),
                Ok(BytesPoll::Pending { .. })
            ));
            until(|| loader.load(&ctx, &uri).is_err()).await;

            loader.drawable(&format!("{base}?spotify_exp=2&spotify_sig=new"));
            assert!(matches!(
                loader.load(&ctx, &uri),
                Ok(BytesPoll::Pending { .. })
            ));
            until(|| loader.is_ready(&uri)).await;
            assert_eq!(
                server.await.unwrap(),
                [
                    "/cover?spotify_exp=1&spotify_sig=old",
                    "/cover?spotify_exp=2&spotify_sig=new"
                ]
            );
        });
        drop(loader);
        runtime.shutdown_timeout(Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transient_cover_load_errors_remain_retryable() {
        assert!(!terminal_art_error(&LoadError::Loading(
            "temporary network failure".into()
        )));
        assert!(!terminal_art_error(&LoadError::NoMatchingBytesLoader));
        assert!(terminal_art_error(&LoadError::NotSupported));
    }

    fn softened_test_image() -> egui::ColorImage {
        egui::ColorImage::filled([1, 1], egui::Color32::WHITE)
    }

    #[test]
    fn softened_cover_reuses_decoded_art_after_source_bytes_are_released() {
        let runtime = artwork_test_runtime();
        let dir =
            std::env::temp_dir().join(format!("spotifast-softened-decoded-{}", std::process::id()));
        let loader = artwork_test_loader(&runtime, dir.clone());
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        ctx.add_bytes_loader(Arc::new(loader.clone()));
        let uri = "https://i.scdn.co/image/decoded";
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(64, 32, image::Rgb([20, 30, 40]))
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let bytes: Arc<[u8]> = encoded.into_inner().into();
        loader.inner.entries.lock().unwrap().insert(
            uri.into(),
            Entry::Ready {
                retained: bytes.len(),
                bytes: Some(bytes),
                last_used: Instant::now(),
            },
        );
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !matches!(
                    ctx.try_load_texture(uri, Default::default(), Default::default()),
                    Ok(egui::load::TexturePoll::Ready { .. })
                ) {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                // Painting a visible cover releases its encoded bytes every
                // frame. There is deliberately no disk file or HTTP server.
                loader.release_bytes(uri);
                let mut covers = SoftenedCovers::default();
                loop {
                    loader.release_bytes(uri);
                    let texture = covers.texture(&ctx, &loader, uri);
                    assert!(
                        matches!(
                            loader.inner.entries.lock().unwrap().get(uri),
                            Some(Entry::Ready { bytes: None, .. })
                        ),
                        "softening must not restart the byte loader"
                    );
                    if let Some(texture) = texture {
                        assert_eq!(texture.size(), [256, 128]);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                assert!(covers.pending.is_empty());
                assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
            })
            .await
            .expect("decoded artwork produces a softened cover");
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn softened_cover_pending_requests_are_deduplicated() {
        let runtime = artwork_test_runtime();
        let dir =
            std::env::temp_dir().join(format!("spotifast-softened-pending-{}", std::process::id()));
        let loader = artwork_test_loader(&runtime, dir.clone());
        let ctx = egui::Context::default();
        let mut covers = SoftenedCovers::default();
        covers.pending.insert("pending".to_string());

        assert!(covers.texture(&ctx, &loader, "pending").is_none());
        assert_eq!(covers.pending.len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn softened_cover_completion_and_failure_clear_pending_state() {
        let ctx = egui::Context::default();
        let mut covers = SoftenedCovers::default();
        covers.pending.insert("ready".to_string());
        covers.pending.insert("broken".to_string());
        covers
            .ready_tx
            .send(("ready".to_string(), Some(softened_test_image())))
            .unwrap();
        covers.ready_tx.send(("broken".to_string(), None)).unwrap();

        covers.receive_ready(&ctx);

        assert!(covers.pending.is_empty());
        assert!(covers.textures.contains_key("ready"));
        assert!(covers.failed.contains("broken"));
    }

    #[test]
    fn softened_cover_completion_evicts_the_oldest_texture() {
        let ctx = egui::Context::default();
        let mut covers = SoftenedCovers::default();
        let now = Instant::now();
        for index in 0..HELD_COVERS {
            covers.textures.insert(
                format!("cover-{index}"),
                SoftenedCover {
                    texture: ctx.load_texture(
                        format!("cover-{index}"),
                        softened_test_image(),
                        egui::TextureOptions::LINEAR,
                    ),
                    last_used: now + Duration::from_secs(index as u64),
                },
            );
        }
        covers.pending.insert("fresh".to_string());
        covers
            .ready_tx
            .send(("fresh".to_string(), Some(softened_test_image())))
            .unwrap();

        covers.receive_ready(&ctx);

        assert_eq!(covers.textures.len(), HELD_COVERS);
        assert!(!covers.textures.contains_key("cover-0"));
        assert!(covers.textures.contains_key("fresh"));
    }

    #[test]
    fn softened_cover_blurs_edges_and_bounds_texture_size() {
        let image = egui::ColorImage::from_rgb(
            [640, 320],
            &image::RgbImage::from_fn(640, 320, |x, _| {
                if x < 320 {
                    image::Rgb([255, 0, 0])
                } else {
                    image::Rgb([0, 0, 255])
                }
            })
            .into_raw(),
        );
        let cover = softened_background(&image).expect("valid artwork");
        assert_eq!(cover.size, [256, 128]);
        let center = cover.pixels[64 * 256 + 128];
        assert!(
            center.r() > 40 && center.b() > 40,
            "the edge must be softened: {center:?}"
        );
        assert!(cover.pixels[0].r() > 240, "the cover stays recognizable");
        let oversized = egui::ColorImage::filled([8193, 1], egui::Color32::RED);
        assert!(softened_background(&oversized).is_none());
    }

    /// The media controls ask for a file rather than a URL, and have to be
    /// told "not yet" rather than handed a path to nothing: macOS loads cover
    /// art itself and dereferences a failed load without checking it, which
    /// takes the whole process with it.
    #[test]
    fn a_cached_file_is_named_only_once_it_is_really_there() {
        let dir = std::env::temp_dir().join(format!("spotifast-art-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime to hand the loader");
        let loader = ArtLoader::new(
            reqwest::Client::new(),
            runtime.handle().clone(),
            dir.clone(),
        );
        let url = "https://i.scdn.co/image/abc";

        assert_eq!(loader.cached_file(url), None, "nothing downloaded yet");

        // A half-written download never appears under its real name -- the
        // cache renames one into place -- but an empty file is not artwork.
        let path = loader.inner.cache_path(url);
        std::fs::write(&path, b"").expect("an empty file");
        assert_eq!(loader.cached_file(url), None, "empty is not artwork");

        std::fs::write(&path, b"\xff\xd8\xff jpeg-ish").expect("a file with bytes");
        assert_eq!(loader.cached_file(url), Some(path));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefetching_starts_one_download_and_not_another() {
        let dir = std::env::temp_dir().join(format!("spotifast-prefetch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime to hand the loader");
        let loader = ArtLoader::new(
            reqwest::Client::new(),
            runtime.handle().clone(),
            dir.clone(),
        );
        let ctx = egui::Context::default();
        let url = "https://i.scdn.co/image/never-drawn";

        assert!(loader.prefetch(&ctx, url), "nobody has asked for it yet");
        assert!(!loader.prefetch(&ctx, url), "it is already on its way");

        // A scheme the loader does not answer for is refused outright, the
        // same as in `load`, and nothing is remembered about it.
        let local = "file:///tmp/cover.jpg";
        assert!(
            !loader.prefetch(&ctx, local),
            "not a URL this loader fetches"
        );
        assert!(
            !loader
                .inner
                .entries
                .lock()
                .expect("the entries")
                .contains_key(local),
            "a URI it cannot fetch was remembered anyway"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn held(items: &[(&str, u64, usize)]) -> Vec<(String, Instant, usize)> {
        let base = Instant::now();
        items
            .iter()
            .map(|(url, age_secs, bytes)| {
                (
                    (*url).to_string(),
                    base - std::time::Duration::from_secs(*age_secs),
                    *bytes,
                )
            })
            .collect()
    }

    /// Rule: nothing is let go of while it all fits. This is the case
    /// that matters: an evening of listening never reaches the budget,
    /// so no cover ever blinks out and back (#129).
    #[test]
    fn artwork_that_fits_is_all_kept() {
        let art = held(&[("a", 600, 1000), ("b", 300, 1000), ("c", 1, 1000)]);
        assert!(over_budget(art, 10_000).is_empty());
    }

    /// Rule: over the budget, the oldest go first, and only as many as
    /// it takes to fit.
    #[test]
    fn the_oldest_go_until_the_rest_fit() {
        let art = held(&[
            ("oldest", 900, 1000),
            ("middle", 600, 1000),
            ("newest", 1, 1000),
        ]);
        assert_eq!(over_budget(art, 2000), vec!["oldest"]);
    }

    #[test]
    fn enough_go_to_get_under_the_budget() {
        let art = held(&[
            ("oldest", 900, 1000),
            ("middle", 600, 1000),
            ("newest", 1, 1000),
        ]);
        assert_eq!(over_budget(art, 900), vec!["oldest", "middle", "newest"]);
    }

    /// Rule: an empty gallery asks nothing of anyone.
    #[test]
    fn nothing_held_lets_nothing_go() {
        assert!(over_budget(Vec::new(), 0).is_empty());
    }

    fn retained_total(loader: &ArtLoader) -> usize {
        loader
            .inner
            .entries
            .lock()
            .expect("lock")
            .values()
            .map(|entry| match entry {
                Entry::Ready { retained, .. } => *retained,
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn large_covers_evict_using_decoded_and_texture_sizes() {
        let one = decoded_and_texture_bytes(640, 640);
        assert_eq!(one, 2 * 640 * 640 * 4);
        let jpeg = 50_000usize;
        let dir = std::env::temp_dir().join(format!(
            "spotifast-art-budget-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime for eviction");
        let loader = ArtLoader::new(
            reqwest::Client::new(),
            runtime.handle().clone(),
            dir.clone(),
        );
        let now = Instant::now();
        for i in 0..40 {
            let url = format!("https://i.scdn.co/image/{i}");
            loader.inner.entries.lock().expect("lock").insert(
                url,
                Entry::Ready {
                    bytes: Some(Arc::from(vec![0u8; jpeg])),
                    last_used: now - Duration::from_secs(40 - i),
                    retained: jpeg,
                },
            );
        }
        let jpeg_total = retained_total(&loader);
        assert!(
            jpeg_total < HELD_BYTES,
            "JPEG-only covers must still fit the budget: {jpeg_total}"
        );
        for i in 0..40 {
            let url = format!("https://i.scdn.co/image/{i}");
            loader.release_bytes(&url);
            loader.note_decoded(&url, 640, 640);
        }
        let before = retained_total(&loader);
        assert_eq!(before, 40 * one);
        assert!(
            before > HELD_BYTES,
            "decoded 640×640 covers plus textures must exceed 64 MiB: {before}"
        );
        let ctx = egui::Context::default();
        loader.evict(&ctx);
        let after = retained_total(&loader);
        assert!(
            after <= HELD_BYTES,
            "eviction must bring retained decoded+texture bytes under budget: after={after}"
        );
        assert!(
            after < before,
            "a long scroll of large covers must free memory: before={before} after={after}"
        );
        let entries = loader.inner.entries.lock().expect("lock");
        assert!(
            !entries.contains_key("https://i.scdn.co/image/0"),
            "the oldest scrolled-away cover must go first"
        );
        assert!(
            entries.contains_key("https://i.scdn.co/image/39"),
            "the cover just scrolled into view must stay"
        );
        drop(entries);
        loader.forget_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn releasing_bytes_reloads_from_disk_off_the_ui_thread() {
        use egui::load::BytesLoader;
        use std::time::Duration as StdDuration;

        let dir = std::env::temp_dir().join(format!(
            "spotifast-art-reload-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime for disk reload");
        let loader = ArtLoader::new(
            reqwest::Client::new(),
            runtime.handle().clone(),
            dir.clone(),
        );
        let url = "https://i.scdn.co/image/reload";
        let path = loader.inner.cache_path(url);
        std::fs::create_dir_all(path.parent().expect("cache dir")).expect("cache dir");
        std::fs::write(&path, b"\xff\xd8\xff jpeg-ish").expect("cached jpeg");
        loader.inner.entries.lock().expect("lock").insert(
            url.to_string(),
            Entry::Ready {
                bytes: None,
                last_used: Instant::now(),
                retained: 0,
            },
        );
        let ctx = egui::Context::default();
        let first = loader.load(&ctx, url).expect("load");
        assert!(
            matches!(first, BytesPoll::Pending { .. }),
            "disk reload must not block the UI thread"
        );
        let deadline = Instant::now() + StdDuration::from_secs(2);
        loop {
            std::thread::sleep(StdDuration::from_millis(20));
            match loader.load(&ctx, url) {
                Ok(BytesPoll::Ready { .. }) => break,
                Ok(BytesPoll::Pending { .. }) if Instant::now() < deadline => continue,
                _ => panic!("reload did not finish"),
            }
        }
        loader.forget_all();
        assert!(loader.inner.entries.lock().expect("lock").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
