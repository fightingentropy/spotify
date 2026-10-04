//! The native client's adapter to our music service, not Spotify OAuth/Connect.
//! Only API requests receive the origin-scoped session cookie. Media URLs keep
//! their signatures and can be passed to a separate streaming client unchanged.
pub mod downloads;
mod listening;
mod mapping;
mod models;
#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod tests;

use crate::api::{ApiError, models as view};
use crate::backend::{ApiRequest, ApiResponse};
use crate::http::Http;
pub use models::MusicSong;
use models::*;
use reqwest::{
    Method, Url,
    cookie::{CookieStore, Jar},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Result<T> = std::result::Result<T, ApiError>;
const PAGE_SIZE: u32 = 50;

struct State {
    user: Option<view::User>,
    songs: HashMap<String, MusicSong>,
    cache: HashMap<String, (Instant, Value)>,
    cache_revision: u64,
    promoted: HashMap<String, MusicSong>,
}

#[derive(Clone)]
pub struct MusicApi {
    base: Arc<str>,
    origin: Url,
    media_client: reqwest::Client,
    jar: Arc<Jar>,
    state: Arc<Mutex<State>>,
    generation: Arc<AtomicU64>,
    expired: Arc<AtomicBool>,
    auth_lock: Arc<tokio::sync::Mutex<()>>,
    reads: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    like_writes: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    permits: Arc<tokio::sync::Semaphore>,
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| ApiError::Decode("Invalid music service response".into()))
}
fn unsupported() -> ApiError {
    ApiError::Status {
        status: 501,
        message: "This feature is not available from the music service.".into(),
    }
}
fn failure(message: impl Into<String>) -> ApiError {
    ApiError::Status {
        status: 400,
        message: message.into(),
    }
}
fn segment(value: &str) -> String {
    let mut url = Url::parse("http://localhost/").expect("static URL");
    url.path_segments_mut().expect("URL path").push(value);
    url.path()[1..].to_string()
}
fn query_path(path: &str, query: &str) -> String {
    let mut url = Url::parse("http://localhost/").expect("static URL");
    url.set_path(path);
    url.query_pairs_mut().append_pair("q", query);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

impl MusicApi {
    pub fn new(base_url: &str, http: Http) -> std::result::Result<Self, String> {
        let origin = Url::parse(base_url).map_err(|_| "Enter a valid music server URL")?;
        let local = matches!(
            origin.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if origin.scheme() != "https" && !(origin.scheme() == "http" && local) {
            return Err("Use HTTPS for the music server (HTTP is allowed for localhost).".into());
        }
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err(
                "Use a server origin without credentials, path, query, or fragment.".into(),
            );
        }
        http.client()?;
        let jar = Arc::new(Jar::default());
        let api_origin = origin.origin();
        let media_client = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(concat!("StreamArenaDesktop/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.stop();
                }
                if attempt
                    .previous()
                    .first()
                    .is_some_and(|u| u.origin() == api_origin)
                    && attempt.url().origin() != api_origin
                {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.without_url().to_string())?;
        Ok(Self {
            base: origin.as_str().trim_end_matches('/').into(),
            origin,
            media_client,
            jar,
            state: Arc::new(Mutex::new(State {
                user: None,
                songs: HashMap::new(),
                cache: HashMap::new(),
                cache_revision: 0,
                promoted: HashMap::new(),
            })),
            generation: Arc::new(AtomicU64::new(0)),
            expired: Arc::new(AtomicBool::new(false)),
            auth_lock: Arc::new(tokio::sync::Mutex::new(())),
            reads: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            like_writes: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(tokio::sync::Semaphore::new(6)),
        })
    }

    pub fn client(&self) -> reqwest::Client {
        self.media_client.clone()
    }
    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn session_expired(&self) -> bool {
        self.expired.load(Ordering::SeqCst)
    }

    pub fn track_for_uri(&self, uri: &str) -> Option<view::Track> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .songs
            .get(uri)
            .map(MusicSong::track)
    }

    pub async fn record_play(
        &self,
        uri: &str,
        duration_ms: u32,
    ) -> std::result::Result<(), String> {
        let song = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .songs
            .get(uri)
            .cloned()
            .ok_or_else(|| "This song is no longer in the current account.".to_string())?;
        if matches!(song.source.as_deref(), Some("radio" | "podcast")) {
            return Ok(());
        }
        let mut song =
            serde_json::to_value(song).map_err(|_| "Invalid song metadata".to_string())?;
        if let Some(object) = song.as_object_mut() {
            object.remove("networkImageUrl");
        }
        self.write(
            Method::POST,
            "/api/play-events",
            json!({"song":song,"durationMs":duration_ms}),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// Returns only the opaque session token, never other cookies.
    pub fn export_session_cookie(&self) -> Option<String> {
        let header = self.jar.cookies(&self.origin)?;
        header
            .to_str()
            .ok()?
            .split(';')
            .find_map(|part| {
                part.trim()
                    .strip_prefix("spotify_session=")
                    .map(str::to_string)
            })
            .filter(|s| !s.is_empty())
    }

    /// Restore a token from protected storage, scoped to this exact server.
    pub fn restore_session_cookie(&self, token: &str) -> std::result::Result<(), String> {
        if token.is_empty()
            || token.len() > 4096
            || token
                .bytes()
                .any(|b| !(0x21..=0x7e).contains(&b) || matches!(b, b';' | b',' | b'"' | b'\\'))
        {
            return Err("Invalid saved music session".into());
        }
        self.reset();
        self.jar.add_cookie_str(
            &format!(
                "spotify_session={token}; Path=/; HttpOnly{}",
                if self.origin.scheme() == "https" {
                    "; Secure"
                } else {
                    ""
                }
            ),
            &self.origin,
        );
        Ok(())
    }

    fn reset(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.expired.store(false, Ordering::SeqCst);
        self.jar
            .add_cookie_str("spotify_session=; Path=/; Max-Age=0", &self.origin);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.user = None;
        state.songs.clear();
        state.cache.clear();
        state.cache_revision += 1;
        state.promoted.clear();
    }

    pub async fn sign_in(
        &self,
        email: &str,
        password: &str,
    ) -> std::result::Result<view::User, String> {
        let _auth = self.auth_lock.lock().await;
        self.reset();
        let value = self
            .request(
                Method::POST,
                "/api/auth/signin",
                Some(json!({ "email": email, "password": password })),
            )
            .await
            .map_err(|e| e.to_string())?;
        let user = self
            .user_from(&value)
            .ok_or("The music server did not return an account.")?;
        if self.export_session_cookie().is_none() {
            return Err("The music server did not create a session.".into());
        }
        self.state.lock().unwrap_or_else(|e| e.into_inner()).user = Some(user.clone());
        Ok(user)
    }

    pub async fn session(&self) -> std::result::Result<Option<view::User>, String> {
        let value = self
            .request(Method::GET, "/api/auth/session", None)
            .await
            .map_err(|e| e.to_string())?;
        let user = self.user_from(&value);
        if user.is_none() {
            self.reset();
        } else {
            self.state.lock().unwrap_or_else(|e| e.into_inner()).user = user.clone();
        }
        Ok(user)
    }

    pub async fn sign_out(&self) -> std::result::Result<(), String> {
        let _auth = self.auth_lock.lock().await;
        let result = self
            .request(Method::POST, "/api/auth/signout", Some(json!({})))
            .await;
        self.reset();
        result.map(|_| ()).map_err(|e| e.to_string())
    }

    fn user_from(&self, value: &Value) -> Option<view::User> {
        let user = value.get("user")?;
        let id = user.get("id")?.as_str()?.to_string();
        Some(view::User {
            id: id.clone(),
            display_name: user
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| user.get("email").and_then(Value::as_str))
                .map(str::to_string),
            images: mapping::images(
                user.get("image")
                    .and_then(Value::as_str)
                    .map(|s| self.absolute(s))
                    .as_deref(),
            ),
            uri: Some(format!("spotify:user:{id}")),
            ..Default::default()
        })
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        if !path.starts_with("/api/") {
            return Err(failure("Invalid API path"));
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let url =
            Url::parse(&format!("{}{path}", self.base)).map_err(|_| failure("Invalid API URL"))?;
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| failure("Client is shutting down"))?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(ApiError::NotSignedIn);
        }
        let client = self.client();
        let mut request = client
            .request(method, url.clone())
            .timeout(Duration::from_secs(if path.starts_with("/api/discover/") {
                90
            } else {
                25
            }))
            .header("accept", "application/json");
        if let Some(cookie) = self.jar.cookies(&url) {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| ApiError::Network(e.without_url().to_string()))?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(ApiError::NotSignedIn);
        }
        // Do not import unrelated cookies or accept an off-origin redirect as auth.
        if response.url().origin() != self.origin.origin() {
            return Err(failure("Music server redirected to a different origin"));
        }
        if path.starts_with("/api/auth/") {
            for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
                if let Ok(cookie) = header.to_str() {
                    if cookie.trim_start().starts_with("spotify_session=") {
                        self.jar.add_cookie_str(cookie, &self.origin);
                    }
                }
            }
        }
        let status = response.status();
        if status.as_u16() == 401
            && path != "/api/auth/signin"
            && path != "/api/auth/session"
            && generation == self.generation.load(Ordering::SeqCst)
        {
            self.expired.store(true, Ordering::SeqCst);
        }
        if status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| ApiError::Decode("Invalid JSON from music service".into()))?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(ApiError::NotSignedIn);
        }
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                message: value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("The music request failed.")
                    .to_string(),
            });
        }
        Ok(value)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let generation = self.generation.load(Ordering::SeqCst);
        let key = format!("{generation}:{path}");
        let lock = {
            let mut reads = self.reads.lock().await;
            if reads.len() > 256 {
                reads.clear();
            }
            reads
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _read = lock.lock().await;
        let ttl = if path.starts_with("/api/stats/") {
            5
        } else {
            30
        };
        for _ in 0..3 {
            let revision = {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some((at, value)) = state.cache.get(&key) {
                    if at.elapsed() < Duration::from_secs(ttl) {
                        return Ok(value.clone());
                    }
                }
                state.cache_revision
            };
            let value = self.request(Method::GET, path, None).await?;
            if generation != self.generation.load(Ordering::SeqCst) {
                return Err(ApiError::NotSignedIn);
            }
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            // An older read must not undo a completed like/playlist write. Read
            // again under this URL's dedupe lock, rather than publish stale data.
            if state.cache_revision != revision {
                continue;
            }
            if state.cache.len() >= 128 {
                state
                    .cache
                    .retain(|_, (at, _)| at.elapsed() < Duration::from_secs(30));
            }
            if state.cache.len() >= 128 {
                state.cache.clear();
            }
            state
                .cache
                .insert(key.clone(), (Instant::now(), value.clone()));
            return Ok(value);
        }
        Err(failure("The library changed while loading. Please retry."))
    }

    async fn write(&self, method: Method, path: &str, body: Value) -> Result<Value> {
        self.invalidate_reads();
        let result = self.request(method, path, Some(body)).await;
        self.invalidate_reads();
        result
    }

    fn invalidate_reads(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.cache.clear();
        state.cache_revision += 1;
    }

    fn absolute(&self, value: &str) -> String {
        if value.is_empty() {
            return String::new();
        }
        if value.starts_with('/') && !value.starts_with("//") {
            return format!("{}{value}", self.base);
        }
        if let Ok(url) = Url::parse(value) {
            if matches!(url.scheme(), "https" | "http") {
                return value.to_string();
            }
        }
        String::new()
    }

    fn remember(&self, mut song: MusicSong) -> MusicSong {
        if song.duration_ms == 0 {
            song.duration_ms =
                (song.duration.unwrap_or(0.0).max(0.0) * 1000.0).min(u32::MAX as f64) as u32;
        }
        song.duration = Some(f64::from(song.duration_ms) / 1000.0);
        song.image_url = self.absolute(&song.image_url);
        song.audio_url = self.absolute(&song.audio_url);
        song.lyrics_url = song.lyrics_url.map(|s| self.absolute(&s));
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // History and partial catalog responses can omit the length. Keep a
        // known duration instead of disabling the player's progress and seek.
        if song.duration_ms == 0 {
            if let Some(known) = state.songs.get(&song.uri()) {
                song.duration_ms = known.duration_ms;
                song.duration = known.duration;
            }
        }
        // Fresh catalog responses still describe the provider recording. A keep
        // may already have resolved it to a different, pre-existing library ID.
        let resolved = song
            .discover_track_id
            .as_ref()
            .and_then(|id| state.promoted.get(id))
            .cloned()
            .unwrap_or_else(|| song.clone());
        for promoted in state.promoted.values_mut() {
            if promoted.id == song.id {
                *promoted = song.clone();
            }
        }
        state.songs.insert(song.uri(), resolved.clone());
        state.songs.insert(resolved.uri(), resolved.clone());
        resolved
    }

    fn songs(&self, value: &Value) -> Result<Vec<MusicSong>> {
        let raw = if value.is_array() {
            value.clone()
        } else {
            value.get("songs").cloned().unwrap_or_else(|| json!([]))
        };
        let songs: Vec<MusicSong> = decode(raw)?;
        Ok(songs
            .into_iter()
            .filter(|s| !s.id.is_empty())
            .map(|s| self.remember(s))
            .collect())
    }

    async fn collection(&self, id: &str, offset: u32) -> Result<Collection> {
        if id == "streamarena-radio" {
            return self.radio_collection().await;
        }
        if matches!(id, "streamarena-top" | "streamarena-recent") {
            return self.listening_history_collection(id).await;
        }
        if id == "streamarena-all" {
            let value = self.get("/api/songs").await?;
            let songs = self.songs(&value)?;
            return Ok(Collection {
                kind: Some("curated".into()),
                playlist: Some(MusicPlaylist {
                    id: id.into(),
                    name: "All Songs".into(),
                    editable: Some(false),
                    songs_count: Some(songs.len() as u32),
                    ..Default::default()
                }),
                songs,
                ..Default::default()
            });
        }
        let path = if let Some(catalog) = id.strip_prefix("catalog:") {
            format!(
                "/api/catalog/spotify/playlists/{}?offset={offset}&limit={PAGE_SIZE}",
                segment(catalog)
            )
        } else {
            format!("/api/playlist/{}", segment(id))
        };
        let mut collection: Collection = decode(self.get(&path).await?)?;
        collection.songs = collection
            .songs
            .into_iter()
            .map(|s| self.remember(s))
            .collect();
        if let Some(playlist) = collection.playlist.as_mut() {
            playlist.image_url = playlist.image_url.as_ref().map(|s| self.absolute(s));
            playlist.cover_image_urls = playlist
                .cover_image_urls
                .iter()
                .map(|s| self.absolute(s))
                .collect();
            if collection.kind.as_deref() != Some("library") && collection.kind.is_some() {
                playlist.editable = Some(false);
            }
        }
        Ok(collection)
    }

    async fn album_collection(&self, id: &str) -> Result<Collection> {
        let (provider, id) = id
            .strip_prefix("youtube:")
            .map(|id| ("youtube", id))
            .unwrap_or(("spotify", id));
        let mut result: Collection = decode(
            self.get(&format!("/api/catalog/{provider}/albums/{}", segment(id)))
                .await?,
        )?;
        result.songs = result.songs.into_iter().map(|s| self.remember(s)).collect();
        if let Some(album) = result.album.as_mut() {
            album.image_url = album.image_url.as_ref().map(|s| self.absolute(s));
        }
        Ok(result)
    }

    async fn track(&self, id: &str, refresh: bool) -> Result<MusicSong> {
        let uri = if id.starts_with("spotify:track:") || id.starts_with("spotify:episode:") {
            id.to_string()
        } else {
            format!("spotify:track:{id}")
        };
        if !refresh {
            if let Some(song) = self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .songs
                .get(&uri)
                .cloned()
            {
                return Ok(song);
            }
        }
        let id = uri
            .strip_prefix("spotify:track:")
            .or_else(|| uri.strip_prefix("spotify:episode:"))
            .ok_or_else(unsupported)?;
        if id.starts_with("radio:") || id.starts_with("podcast:") {
            return self.listening_track(id).await;
        }
        let value = self
            .request(Method::GET, &format!("/api/songs/{}", segment(id)), None)
            .await;
        // Temporary/catalog IDs are intentionally absent from permanent songs.
        // Recover real saved metadata rather than inventing a title from an ID.
        let value = match value {
            Err(ApiError::Status { status: 404, .. }) if !refresh => {
                if let Some(song) = self.restore_catalog_metadata(&uri, id).await {
                    return Ok(song);
                }
                return Err(failure(
                    "This song is no longer available. Open its album or search for it again.",
                ));
            }
            other => other?,
        };
        let song: MusicSong = decode(value)?;
        Ok(self.remember(song))
    }

    async fn restore_catalog_metadata(&self, uri: &str, id: &str) -> Option<MusicSong> {
        let (liked, history) = tokio::join!(self.get("/api/liked"), self.get("/api/stats/home"));
        let mut candidates = Vec::new();
        if let Ok(value) = liked {
            if let Ok(songs) = self.songs(&value) {
                candidates.extend(songs);
            }
        }
        if let Ok(value) = history {
            let recent = value
                .get("recentlyPlayed")
                .cloned()
                .unwrap_or_else(|| json!([]));
            if let Ok(songs) = self.songs(&recent) {
                candidates.extend(songs);
            }
            let top: Vec<Value> = value
                .get("mostPlayed")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.get("song").cloned())
                .collect();
            if let Ok(songs) = self.songs(&json!(top)) {
                candidates.extend(songs);
            }
        }
        let catalog_id = id
            .strip_prefix("discover:")
            .or_else(|| id.strip_prefix("catalog:"));
        let song = candidates.into_iter().find(|song| {
            song.id == id
                || song.canonical_id.as_deref() == Some(id)
                || catalog_id
                    .is_some_and(|catalog| song.discover_track_id.as_deref() == Some(catalog))
        })?;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .songs
            .insert(uri.into(), song.clone());
        Some(song)
    }

    async fn stage(&self, song: &MusicSong, preview: bool) -> Result<MusicSong> {
        let track_id = song
            .discover_track_id
            .as_deref()
            .ok_or_else(|| failure("This track has no playback source."))?;
        let mut body = json!({ "title":song.title, "artist":song.artist, "album":song.album,
            "durationMs":song.duration_ms, "imageUrl":song.image_url, "preview":preview, "qualityProfile":"max", "region":"US" });
        if let Some(video) = &song.youtube_video_id {
            body["trackId"] = json!(track_id);
            body["youtubeVideoId"] = json!(video);
            body["preview"] = json!(true);
        } else {
            body["spotifyUrl"] = json!(format!("https://open.spotify.com/track/{track_id}"));
        }
        let mut staged: MusicSong = decode(
            self.request(Method::POST, "/api/discover/stage", Some(body))
                .await?,
        )?;
        if staged.duration_ms == 0 && !staged.duration.is_some_and(|duration| duration > 0.0) {
            staged.duration_ms = song.duration_ms;
            staged.duration = song.duration;
        }
        staged.discover_track_id = song.discover_track_id.clone();
        staged.youtube_video_id = song.youtube_video_id.clone();
        staged.preview = preview || song.youtube_video_id.is_some();
        staged.staged = true;
        if song.id.starts_with("catalog:") {
            staged.id = song.id.clone();
        }
        let staged = self.remember(staged);
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .songs
            .insert(song.uri(), staged.clone());
        Ok(staged)
    }

    /// Read existing song metadata without staging audio or requiring playback.
    /// Missing registry entries are hydrated from saved songs or listening history.
    pub async fn song_metadata(&self, uri: &str) -> std::result::Result<MusicSong, String> {
        self.track(uri, false).await.map_err(|e| e.to_string())
    }

    pub async fn resolve_song(&self, uri: &str) -> std::result::Result<MusicSong, String> {
        self.resolve_song_inner(uri, false)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn refresh_song(&self, uri: &str) -> std::result::Result<MusicSong, String> {
        self.resolve_song_inner(uri, true)
            .await
            .map_err(|e| e.to_string())
    }
    async fn resolve_song_inner(&self, uri: &str, force: bool) -> Result<MusicSong> {
        let mut song = self.track(uri, false).await?;
        let expiring = Url::parse(&song.audio_url)
            .ok()
            .and_then(|u| {
                u.query_pairs()
                    .find(|(k, _)| k == "spotify_exp")
                    .and_then(|(_, v)| v.parse::<u64>().ok())
            })
            .is_some_and(|expiry| {
                expiry
                    <= SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                        + 60
            });
        // A staged preview is the full track in our media cache. Replay/seek can
        // use it directly; only unresolved provider previews need staging again.
        // The media bridge refreshes a stale or pruned cache entry on failure.
        let staged_media = song.staged
            && Url::parse(&song.audio_url).is_ok_and(|url| {
                url.origin() == self.origin.origin() && url.path().starts_with("/api/files/local/")
            });
        if song.discover_track_id.is_some()
            && (force || expiring || song.audio_url.is_empty() || (song.preview && !staged_media))
        {
            song = self.stage(&song, song.preview).await?;
        } else if force || expiring {
            song = self.track(&song.id, true).await?;
        }
        if song.audio_url.is_empty() {
            return Err(failure("No audio is available for this song."));
        }
        Ok(song)
    }

    pub async fn resolve_context(&self, uri: &str) -> std::result::Result<Vec<String>, String> {
        self.context(uri)
            .await
            .map(|songs| songs.iter().map(MusicSong::uri).collect())
            .map_err(|e| e.to_string())
    }
    async fn context(&self, uri: &str) -> Result<Vec<MusicSong>> {
        if uri == "spotify:collection:tracks" || uri.ends_with(":collection") {
            return self.songs(&self.get("/api/liked").await?);
        }
        if uri.starts_with("spotify:episode:") {
            return Ok(vec![self.track(uri, false).await?]);
        }
        if let Some(id) = uri.strip_prefix("spotify:track:") {
            return Ok(vec![self.track(id, false).await?]);
        }
        if let Some(id) = uri.strip_prefix("spotify:album:") {
            return Ok(self.album_collection(id).await?.songs);
        }
        if let Some(id) = uri.strip_prefix("spotify:artist:") {
            return self.songs(
                &self
                    .get(&format!("/api/catalog/spotify/artists/{}", segment(id)))
                    .await?,
            );
        }
        if let Some(id) = uri.strip_prefix("spotify:playlist:") {
            let mut songs = Vec::new();
            let mut offset = 0;
            loop {
                let result = self.collection(id, offset).await?;
                songs.extend(result.songs);
                match result.page.and_then(|p| p.next_offset) {
                    Some(next) if next > offset && next <= 10_000 => offset = next,
                    _ => break,
                }
            }
            return Ok(songs);
        }
        Err(unsupported())
    }

    async fn search(&self, query: &str) -> Result<view::SearchResults> {
        let library_path = format!("{}&limit=50", query_path("/api/search-index", query));
        let catalog_path = query_path("/api/search/catalog", query);
        let albums_path = query_path("/api/search/albums", query);
        let (library, catalog, albums) = tokio::join!(
            self.get(&library_path),
            self.get(&catalog_path),
            self.get(&albums_path)
        );
        if library.is_err() && catalog.is_err() && albums.is_err() {
            return Err(library.err().unwrap_or_else(unsupported));
        }
        let mut songs = self.songs(&library.unwrap_or_else(|_| json!({"songs":[]})))?;
        let catalog = catalog.unwrap_or_else(|_| json!({}));
        let extra = self.songs(
            &json!({"songs":catalog.get("results").cloned().unwrap_or_else(|| json!([]))}),
        )?;
        let mut seen = HashSet::new();
        songs.extend(extra);
        songs.retain(|s| {
            seen.insert((
                s.title.trim().to_lowercase(),
                s.artist.trim().to_lowercase(),
            ))
        });
        let tracks: Vec<_> = songs.iter().map(MusicSong::track).collect();
        let artists =
            self.artist_list(catalog.get("artists").cloned().unwrap_or_else(|| json!([])))?;
        let playlists = self.playlist_list(
            catalog
                .get("playlists")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let albums: Vec<MusicAlbum> = decode(
            albums
                .ok()
                .and_then(|v| v.get("albums").cloned())
                .unwrap_or_else(|| json!([])),
        )?;
        let albums: Vec<_> = albums
            .into_iter()
            .map(|mut a| {
                a.image_url = a.image_url.map(|s| self.absolute(&s));
                mapping::album(a)
            })
            .collect();
        Ok(view::SearchResults {
            tracks: Some(mapping::page(&tracks, 0, tracks.len() as u32)),
            artists: Some(mapping::page(&artists, 0, artists.len() as u32)),
            albums: Some(mapping::page(&albums, 0, albums.len() as u32)),
            playlists: Some(mapping::page(&playlists, 0, playlists.len() as u32)),
            ..Default::default()
        })
    }

    fn artist_list(&self, value: Value) -> Result<Vec<view::Artist>> {
        let artists: Vec<MusicArtist> = decode(value)?;
        Ok(artists
            .into_iter()
            .map(|mut a| {
                a.image_url = a.image_url.map(|s| self.absolute(&s));
                mapping::artist(a)
            })
            .collect())
    }
    fn playlist_list(&self, value: Value) -> Result<Vec<view::Playlist>> {
        let playlists: Vec<MusicPlaylist> = decode(value)?;
        Ok(playlists
            .into_iter()
            .map(|mut p| {
                p.image_url = p.image_url.map(|s| self.absolute(&s));
                p.cover_image_urls = p
                    .cover_image_urls
                    .iter()
                    .map(|s| self.absolute(s))
                    .collect();
                mapping::playlist(p, None, None)
            })
            .collect())
    }

    async fn playlist_items(
        &self,
        id: &str,
        offset: u32,
    ) -> Result<view::Page<view::PlaylistItem>> {
        let collection = self.collection(id, offset).await?;
        let items = mapping::playlist_items(&collection.songs);
        if let Some(server_page) = collection.page {
            Ok(view::Page {
                items,
                total: server_page.total_count,
                offset,
                limit: PAGE_SIZE,
                next: server_page.next_offset.map(|n| format!("music:offset:{n}")),
            })
        } else {
            Ok(mapping::page(&items, offset, PAGE_SIZE))
        }
    }

    async fn album(&self, id: &str) -> Result<view::Album> {
        let collection = self.album_collection(id).await?;
        let meta = collection.album.ok_or_else(|| failure("Album not found"))?;
        let mut album = mapping::album(meta);
        let tracks: Vec<_> = collection.songs.iter().map(MusicSong::track).collect();
        album.tracks = Some(mapping::page(&tracks, 0, PAGE_SIZE));
        Ok(album)
    }

    async fn album_tracks(&self, id: &str, offset: u32) -> Result<view::Page<view::Track>> {
        let collection = self.album_collection(id).await?;
        let tracks: Vec<_> = collection.songs.iter().map(MusicSong::track).collect();
        Ok(mapping::page(&tracks, offset, PAGE_SIZE))
    }

    async fn liked_ids(&self) -> Result<HashSet<String>> {
        let value = self.get("/api/likes").await?;
        decode(
            value
                .get("likedSongIds")
                .or_else(|| value.get("likes"))
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
    }

    async fn promote(&self, song: &MusicSong) -> Result<MusicSong> {
        if song.discover_track_id.is_none() {
            return Ok(song.clone());
        }
        let body = |s: &MusicSong| json!({"trackId":s.discover_track_id,"finalId":s.id});
        let mut result = self
            .request(Method::POST, "/api/discover/promote", Some(body(song)))
            .await;
        if matches!(
            &result,
            Err(ApiError::Status {
                status: 404 | 409,
                ..
            })
        ) {
            let staged = self.stage(song, false).await?;
            result = self
                .request(Method::POST, "/api/discover/promote", Some(body(&staged)))
                .await;
        }
        let promoted: MusicSong = decode(result?)?;
        if promoted.id.is_empty() || promoted.audio_url.is_empty() {
            return Err(failure("The server did not save this song."));
        }
        let promoted = self.remember(promoted);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(catalog_id) = &song.discover_track_id {
            state.promoted.insert(catalog_id.clone(), promoted.clone());
            for known in state.songs.values_mut() {
                if known.discover_track_id.as_ref() == Some(catalog_id) {
                    *known = promoted.clone();
                }
            }
        }
        state.songs.insert(song.uri(), promoted.clone());
        Ok(promoted)
    }

    async fn set_saved(&self, uris: &[String], saved: bool) -> Result<()> {
        for uri in uris {
            if !uri.starts_with("spotify:track:") {
                return Err(unsupported());
            }
            // A slow provider download in Like must finish before a subsequent
            // Unlike reaches the server. Serializing only HTTP writes is too
            // late: promotion is part of this logical mutation.
            let key = {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state
                    .songs
                    .get(uri)
                    .and_then(|song| {
                        song.discover_track_id
                            .clone()
                            .or_else(|| {
                                state
                                    .promoted
                                    .iter()
                                    .find(|(_, target)| target.id == song.id)
                                    .map(|(id, _)| id.clone())
                            })
                            .or_else(|| song.canonical_id.clone())
                    })
                    .unwrap_or_else(|| uri.clone())
            };
            let lock = self
                .like_writes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone();
            let _write = lock.lock().await;
            let likes = self.liked_ids().await?;
            let mut song = self.track(uri, false).await?;
            let original_uri = song.uri();
            let mut catalog_fallback = false;
            if saved && song.discover_track_id.is_some() {
                match self.promote(&song).await {
                    Ok(promoted) => song = promoted,
                    Err(_) => catalog_fallback = true,
                }
            }
            let catalog_id = song.catalog_like_id();
            let id = catalog_id
                .as_ref()
                .filter(|id| likes.contains(*id))
                .cloned()
                // The server owns the canonical-likes feature flag. Sending
                // raw IDs also preserves per-file likes while that flag is off.
                .unwrap_or_else(|| song.id.clone());
            let mut body = json!({"songId":id});
            if catalog_fallback {
                body["song"] =
                    serde_json::to_value(&song).map_err(|_| failure("Invalid song metadata"))?;
            }
            let value = self
                .write(
                    if saved { Method::POST } else { Method::DELETE },
                    "/api/likes",
                    body,
                )
                .await?;
            if let Some(value) = value.get("song") {
                let replacement: MusicSong = decode(value.clone())?;
                let replacement = self.remember(replacement);
                self.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .songs
                    .insert(original_uri, replacement);
            }
        }
        Ok(())
    }

    async fn editable_playlist(&self, id: &str) -> Result<Collection> {
        let collection = self.collection(id, 0).await?;
        if collection
            .playlist
            .as_ref()
            .is_none_or(|p| p.editable != Some(true))
            || matches!(collection.kind.as_deref(), Some("curated" | "catalog"))
        {
            return Err(failure("This playlist is read-only."));
        }
        Ok(collection)
    }

    async fn add_to_playlist(
        &self,
        id: &str,
        uris: &[String],
        position: Option<u32>,
    ) -> Result<Option<String>> {
        let mut ordered: Vec<String> = self
            .editable_playlist(id)
            .await?
            .songs
            .iter()
            .map(|s| s.id.clone())
            .collect();
        let mut added = Vec::new();
        for uri in uris {
            let song = self.track(uri, false).await?;
            let song = self.promote(&song).await?;
            self.write(
                Method::POST,
                &format!("/api/playlist/{}/songs", segment(id)),
                json!({"song":song}),
            )
            .await?;
            if !ordered.contains(&song.id) && !added.contains(&song.id) {
                added.push(song.id);
            }
        }
        if let Some(position) = position {
            let index = (position as usize).min(ordered.len());
            ordered.splice(index..index, added);
            self.write(
                Method::POST,
                &format!("/api/playlist/{}/reorder", segment(id)),
                json!({"songIds":ordered}),
            )
            .await?;
        }
        Ok(None)
    }

    async fn remove_from_playlist(&self, id: &str, uris: &[String]) -> Result<Option<String>> {
        self.editable_playlist(id).await?;
        for uri in uris {
            let song = self.track(uri, false).await?;
            self.write(
                Method::DELETE,
                &format!("/api/playlist/{}/songs/{}", segment(id), segment(&song.id)),
                json!({}),
            )
            .await?;
        }
        Ok(None)
    }

    async fn reorder(&self, id: &str, from: u32, before: u32) -> Result<Option<String>> {
        let collection = self.editable_playlist(id).await?;
        let mut ids: Vec<_> = collection.songs.iter().map(|s| s.id.clone()).collect();
        if from as usize >= ids.len() || before as usize > ids.len() {
            return Err(failure("Playlist order changed; reload before reordering."));
        }
        let id_to_move = ids.remove(from as usize);
        let target = if before > from { before - 1 } else { before } as usize;
        ids.insert(target, id_to_move);
        self.write(
            Method::POST,
            &format!("/api/playlist/{}/reorder", segment(id)),
            json!({"songIds":ids}),
        )
        .await?;
        Ok(None)
    }

    /// Converts each request into the existing UI response shape. Generation,
    /// serial and paging metadata remain owned by the original caller.
    pub async fn handle(&self, request: ApiRequest) -> Vec<ApiResponse> {
        use ApiRequest as Q;
        use ApiResponse as R;
        let response = match request {
            Q::Me => R::Me(
                self.session()
                    .await
                    .map_err(ApiError::Network)
                    .and_then(|u| u.ok_or(ApiError::NotSignedIn)),
            ),
            Q::RecentlyPlayed {
                who,
                generation,
                before,
                limit,
            } => {
                let result = if before.is_some() {
                    Err(unsupported())
                } else {
                    async { let value = self.get("/api/stats/home").await?;
                        let songs = self.songs(&json!({"songs":value.get("recentlyPlayed").cloned().unwrap_or_else(|| json!([]))}))?;
                        Ok(view::CursorPage { items: songs.into_iter().take(limit as usize).map(|s| view::PlayHistory { track:s.track(), ..Default::default() }).collect(), ..Default::default() }) }.await
                };
                R::RecentlyPlayed {
                    who,
                    generation,
                    limit,
                    result,
                }
            }
            Q::TopTracks {
                offset,
                full,
                generation,
            } => {
                let result = async {
                    let value = self.get("/api/stats/home").await?;
                    let songs: Vec<Value> = value
                        .get("mostPlayed")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e.get("song").cloned())
                        .collect();
                    let tracks: Vec<_> = self
                        .songs(&json!({"songs":songs}))?
                        .iter()
                        .map(MusicSong::track)
                        .collect();
                    Ok(mapping::page(&tracks, offset, PAGE_SIZE))
                }
                .await;
                R::TopTracks {
                    offset,
                    full,
                    generation,
                    result,
                }
            }
            Q::Discover { term, generation } => {
                let result = async {
                    let value = self.get("/api/discover/playlists").await?;
                    self.playlist_list(value.get("playlists").cloned().unwrap_or_else(|| json!([])))
                }
                .await;
                R::Discover {
                    term,
                    generation,
                    result,
                }
            }
            Q::MyPlaylists { offset, generation } => {
                let result = async {
                    let value = self.get("/api/library").await?;
                    let playlists = self.playlist_list(
                        value.get("playlists").cloned().unwrap_or_else(|| json!([])),
                    )?;
                    Ok(mapping::page(&playlists, offset, PAGE_SIZE))
                }
                .await;
                R::MyPlaylists {
                    offset,
                    generation,
                    result,
                }
            }
            Q::Playlist { id, generation } => {
                let result = self.collection(&id, 0).await.and_then(|c| {
                    c.playlist
                        .map(|p| {
                            mapping::playlist(
                                p,
                                Some(&id),
                                Some(
                                    c.page
                                        .map(|p| p.total_count)
                                        .unwrap_or(c.songs.len() as u32),
                                ),
                            )
                        })
                        .ok_or_else(|| failure("Playlist not found"))
                });
                R::Playlist {
                    id,
                    generation,
                    result,
                }
            }
            Q::PlaylistItems {
                id,
                offset,
                generation,
            } => {
                let result = self.playlist_items(&id, offset).await;
                R::PlaylistItems {
                    id,
                    offset,
                    generation,
                    result,
                }
            }
            Q::PlaylistSample {
                id,
                offset,
                generation,
            } => {
                let result = self.playlist_items(&id, offset).await;
                R::PlaylistSample {
                    id,
                    generation,
                    result,
                }
            }
            Q::SavedTracks { offset, generation } => {
                let result = async {
                    let songs = self.songs(&self.get("/api/liked").await?)?;
                    let tracks: Vec<_> = songs
                        .iter()
                        .map(|s| view::SavedTrack {
                            track: s.track(),
                            added_at: s.liked_at.clone(),
                        })
                        .collect();
                    Ok(mapping::page(&tracks, offset, PAGE_SIZE))
                }
                .await;
                let account_id = self
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .user
                    .as_ref()
                    .map(|u| u.id.clone());
                R::SavedTracks {
                    offset,
                    generation,
                    account_id,
                    result,
                }
            }
            Q::Contains { uris } => {
                let result = async {
                    let likes = self.liked_ids().await?;
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    Ok(uris
                        .iter()
                        .map(|uri| {
                            let Some(id) = uri.strip_prefix("spotify:track:") else {
                                return false;
                            };
                            likes.contains(id)
                                || state.songs.get(uri).is_some_and(|s| {
                                    likes.contains(&s.id)
                                        || s.canonical_id
                                            .as_ref()
                                            .is_some_and(|id| likes.contains(id))
                                        || s.catalog_like_id().is_some_and(|id| likes.contains(&id))
                                })
                        })
                        .collect())
                }
                .await;
                R::Contains { uris, result }
            }
            Q::SetSaved { uris, saved } => {
                let result = self.set_saved(&uris, saved).await;
                R::SavedChanged {
                    uris,
                    saved,
                    result,
                }
            }
            Q::Search { query, serial } | Q::SearchCatalogue { query, serial } => {
                let result = self.search(&query).await;
                R::Search {
                    query,
                    serial,
                    result,
                }
            }
            Q::SearchPlaylists { query, serial } => {
                let path = format!(
                    "{}&include=youtube-playlists",
                    query_path("/api/search/catalog", &query)
                );
                let result = async {
                    let value = self.get(&path).await?;
                    let lists = self.playlist_list(
                        value.get("playlists").cloned().unwrap_or_else(|| json!([])),
                    )?;
                    Ok(mapping::page(&lists, 0, lists.len() as u32))
                }
                .await;
                R::SearchPlaylists {
                    query,
                    serial,
                    result,
                }
            }
            Q::Album { id } => {
                let result = self.album(&id).await;
                R::Album { id, result }
            }
            Q::AlbumTracks {
                id,
                offset,
                generation,
            } => {
                let result = self.album_tracks(&id, offset).await;
                R::AlbumTracks {
                    id,
                    offset,
                    generation,
                    result,
                }
            }
            Q::AlbumQueueTracks {
                id,
                offset,
                request,
            } => {
                let result = self.album_tracks(&id, offset).await;
                R::AlbumQueueTracks {
                    offset,
                    request,
                    result,
                }
            }
            Q::Artist { id } => {
                let result = async {
                    let value = self
                        .get(&format!("/api/catalog/spotify/artists/{}", segment(&id)))
                        .await?;
                    self.songs(&value)?;
                    self.artist_list(json!([value.get("artist").cloned().unwrap_or(Value::Null)]))?
                        .into_iter()
                        .next()
                        .ok_or_else(|| failure("Artist not found"))
                }
                .await;
                R::Artist { id, result }
            }
            Q::ArtistTopTracks { id } => {
                let result = async {
                    let value = self
                        .get(&format!("/api/catalog/spotify/artists/{}", segment(&id)))
                        .await?;
                    Ok(self.songs(&value)?.iter().map(MusicSong::track).collect())
                }
                .await;
                R::ArtistTopTracks { id, result }
            }
            Q::Track { id } => {
                let result = self.track(&id, false).await.map(|s| s.track());
                R::Track { id, result }
            }
            Q::CreatePlaylist {
                name,
                public,
                description,
            } => {
                let result = if public || !description.is_empty() {
                    Err(unsupported())
                } else {
                    self.write(Method::POST, "/api/playlists", json!({"name":name}))
                        .await
                        .and_then(decode::<MusicPlaylist>)
                        .map(|p| mapping::playlist(p, None, None))
                };
                R::PlaylistCreated(result)
            }
            Q::UpdatePlaylist {
                id,
                name,
                public,
                description,
            } => {
                let result = if public.is_some() || description.is_some() {
                    Err(unsupported())
                } else {
                    async {
                        self.editable_playlist(&id).await?;
                        self.write(
                            Method::PATCH,
                            &format!("/api/playlist/{}", segment(&id)),
                            json!({"name":name}),
                        )
                        .await
                        .map(|_| ())
                    }
                    .await
                };
                R::PlaylistUpdated { id, result }
            }
            Q::CheckPlaylistDuplicates {
                playlist_id,
                playlist_name,
                items,
                position,
            } => {
                let result = async {
                    let existing: HashSet<String> = self
                        .collection(&playlist_id, 0)
                        .await?
                        .songs
                        .iter()
                        .map(MusicSong::uri)
                        .collect();
                    Ok(items
                        .iter()
                        .filter(|item| existing.contains(item.uri()))
                        .map(|item| item.uri().to_string())
                        .collect())
                }
                .await;
                R::PlaylistDuplicatesChecked {
                    playlist_id,
                    playlist_name,
                    items,
                    position,
                    result,
                }
            }
            Q::AddToPlaylist {
                playlist_id,
                playlist_name,
                uris,
                position,
            } => {
                let result = self.add_to_playlist(&playlist_id, &uris, position).await;
                R::PlaylistItemsChanged {
                    id: playlist_id,
                    message: format!("Added to {playlist_name}"),
                    result,
                }
            }
            Q::RemoveFromPlaylist {
                playlist_id, uris, ..
            } => {
                let result = self.remove_from_playlist(&playlist_id, &uris).await;
                R::PlaylistItemsChanged {
                    id: playlist_id,
                    message: "Removed from playlist".into(),
                    result,
                }
            }
            Q::ReorderPlaylist {
                playlist_id,
                range_start,
                insert_before,
                ..
            } => {
                let result = self.reorder(&playlist_id, range_start, insert_before).await;
                R::PlaylistItemsChanged {
                    id: playlist_id,
                    message: "Playlist reordered".into(),
                    result,
                }
            }
            Q::FollowPlaylist { id, follow } => {
                let result = if follow {
                    Err(unsupported())
                } else {
                    async {
                        let collection = self.editable_playlist(&id).await?;
                        if collection
                            .playlist
                            .as_ref()
                            .is_some_and(|p| p.deletable == Some(false))
                        {
                            return Err(failure("This playlist cannot be deleted."));
                        }
                        self.write(
                            Method::DELETE,
                            &format!("/api/playlist/{}", segment(&id)),
                            json!({}),
                        )
                        .await
                        .map(|_| ())
                    }
                    .await
                };
                R::PlaylistFollowChanged {
                    id,
                    followed: follow,
                    result,
                }
            }
            Q::UploadPlaylistCover {
                id,
                request,
                previous_urls,
                cover,
            } => R::PlaylistCoverUploaded {
                id,
                request,
                previous_urls,
                cover,
                result: Err(unsupported()),
            },
            Q::Devices => R::Devices(Err(unsupported())),
            Q::PlaybackState { seq } => R::PlaybackState {
                seq,
                result: Err(unsupported()),
            },
            Q::Queue { seq } => R::Queue {
                seq,
                result: Err(unsupported()),
            },
            Q::TopArtists { generation } => R::TopArtists {
                generation,
                result: Err(unsupported()),
            },
            Q::Recommendations { generation, .. } => R::Recommendations {
                generation,
                result: Err(unsupported()),
            },
            Q::SavedAlbums { offset } => R::SavedAlbums {
                offset,
                result: Err(unsupported()),
            },
            Q::FollowedArtists { after } => R::FollowedArtists {
                after,
                result: Err(unsupported()),
            },
            Q::SavedShows { offset } => R::SavedShows {
                result: self.podcast_shows(offset).await,
                offset,
            },
            Q::SavedEpisodes { offset } => R::SavedEpisodes {
                offset,
                result: Err(unsupported()),
            },
            Q::ArtistAlbums { id, groups, offset } => R::ArtistAlbums {
                id,
                groups,
                offset,
                result: Err(unsupported()),
            },
            Q::RelatedArtists { id } => R::RelatedArtists {
                id,
                result: Err(unsupported()),
            },
            Q::Show { id } => R::Show {
                result: self.podcast_show(&id).await,
                id,
            },
            Q::ShowEpisodes { id, offset } => R::ShowEpisodes {
                result: self.podcast_episodes(&id, offset).await,
                id,
                offset,
            },
            Q::HomeEpisodes { generation, .. } => R::HomeEpisodes {
                generation,
                result: Err(unsupported()),
            },
            Q::Episode { id } => R::Episode {
                result: self.podcast_episode(&id).await,
                id,
            },
            Q::Remote { action, .. } => R::Remote {
                action,
                result: Err(unsupported()),
            },
            Q::ShufflePlay { .. } => R::Remote {
                action: crate::backend::RemoteAction::Play,
                result: Err(unsupported()),
            },
            Q::Transfer { device_id, .. } => R::Transferred {
                device_id,
                result: Err(unsupported()),
            },
            Q::AddToQueue { label, .. } => R::QueueAdded {
                label,
                result: Err(unsupported()),
            },
            Q::AddManyToQueue { request, .. } => R::QueueBatchAdded {
                request,
                added: 0,
                result: Err(unsupported()),
            },
        };
        vec![response]
    }
}
