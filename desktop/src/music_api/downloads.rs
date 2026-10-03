//! Authenticated catalog and audio access for the native Downloads workspace.
//! Queue records contain provider identities and public metadata, never expiring
//! audio URLs, session cookies or provider credentials.
use super::{MusicApi, MusicSong};
use crate::music_downloads::{LyricsOptions, ProviderOptions};
use reqwest::{Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct DownloadSourceCheck {
    pub source: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogKind {
    #[default]
    Track,
    Album,
    Artist,
    Playlist,
}
impl CatalogKind {
    pub const ALL: [Self; 4] = [Self::Track, Self::Album, Self::Artist, Self::Playlist];
    pub fn label(self) -> &'static str {
        match self {
            Self::Track => "Songs",
            Self::Album => "Albums",
            Self::Artist => "Artists",
            Self::Playlist => "Playlists",
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub cover_url: String,
    pub source_url: String,
    pub track_count: Option<u32>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<CatalogItem>,
    pub offset: u32,
    pub limit: u32,
    pub total: u32,
    pub total_exact: bool,
    pub has_more: bool,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadImage {
    pub kind: String,
    pub url: String,
    pub label: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceAvailability {
    pub source: String,
    pub status: String,
    pub message: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrackAvailability {
    pub sources: Vec<SourceAvailability>,
    pub checked_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadTrack {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub release_type: String,
    pub album_artist: String,
    pub track_number: u32,
    pub track_total: u32,
    pub disc_number: u32,
    pub disc_total: u32,
    pub release_date: String,
    pub isrc: String,
    pub upc: String,
    pub cover_url: String,
    pub genre: String,
    pub composer: String,
    pub copyright: String,
    pub label: String,
    pub source_url: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadCollection {
    pub title: String,
    pub kind: String,
    pub tracks: Vec<DownloadTrack>,
    pub cover_url: String,
    pub owner: String,
    pub images: Vec<DownloadImage>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadSource {
    #[default]
    Auto,
    Tidal,
    Qobuz,
    Amazon,
    Deezer,
    Apple,
    YouTube,
}
impl DownloadSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::Tidal => "Tidal",
            Self::Qobuz => "Qobuz",
            Self::Amazon => "Amazon Music",
            Self::Deezer => "Deezer",
            Self::Apple => "Apple Music",
            Self::YouTube => "YouTube",
        }
    }
    pub fn service(self) -> &'static str {
        match self {
            Self::Auto => "",
            Self::Tidal => "tidal",
            Self::Qobuz => "qobuz",
            Self::Amazon => "amazon",
            Self::Deezer => "deezer",
            Self::Apple => "apple",
            Self::YouTube => "youtube",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadQuality {
    Cd,
    HiRes48,
    #[default]
    Max,
    Atmos,
}
impl DownloadQuality {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cd => "CD quality",
            Self::HiRes48 => "Hi-Res 48 kHz",
            Self::Max => "Highest available",
            Self::Atmos => "Dolby Atmos",
        }
    }
    pub fn profile(self) -> &'static str {
        match self {
            Self::Cd => "cd",
            Self::HiRes48 => "hires48",
            Self::Max => "max",
            Self::Atmos => "atmos",
        }
    }
}

pub struct DownloadAudio {
    pub response: Response,
    pub source: String,
    /// Actual container, without a dot. Exporters must still probe the audio.
    pub extension: String,
}

fn track_payload(track: &DownloadTrack, source: DownloadSource, quality: DownloadQuality) -> Value {
    json!({"mode":"spotify", "spotifyUrl":track.source_url, "trackId":track.id,
      "title":track.title, "artist":track.artists.join(", "), "album":track.album,
      "imageUrl":track.cover_url, "durationMs":track.duration_ms, "region":"US",
      "qualityProfile":quality.profile(), "service":source.service(), "outputFormat":if quality==DownloadQuality::Atmos { "m4a" } else { "flac" }})
}

struct DownloadAttempt {
    source: DownloadSource,
    quality: DownloadQuality,
    providers: ProviderOptions,
}

/// Keep cross-provider fallback lazy: the server resolves and validates media
/// from one provider before we ask the next one. Custom/built-in alternatives
/// within that provider remain available. Atmos gets a complete spatial pass
/// before any explicitly permitted stereo fallback.
fn download_attempts(
    source: DownloadSource,
    quality: DownloadQuality,
    allow_youtube_fallback: bool,
    providers: &ProviderOptions,
) -> Result<Vec<DownloadAttempt>, String> {
    providers.validate()?;
    let mut order = Vec::new();
    if !matches!(source, DownloadSource::Auto | DownloadSource::YouTube) {
        order.push(source);
    }
    if source != DownloadSource::YouTube {
        for name in &providers.provider_order {
            let provider = match name.as_str() {
                "tidal" => DownloadSource::Tidal,
                "qobuz" => DownloadSource::Qobuz,
                "amazon" => DownloadSource::Amazon,
                "deezer" => DownloadSource::Deezer,
                "apple" => DownloadSource::Apple,
                _ => return Err("Unknown download provider".into()),
            };
            if !order.contains(&provider) {
                order.push(provider);
            }
        }
        if !providers.provider_fallback {
            order.truncate(1);
        }
    }
    let stereo_quality = if quality == DownloadQuality::Atmos {
        if providers.atmos_fallback_quality == "cd" {
            DownloadQuality::Cd
        } else {
            DownloadQuality::Max
        }
    } else {
        quality
    };
    let mut attempts = Vec::new();
    let mut add = |source: DownloadSource, quality: DownloadQuality| {
        let mut single = providers.clone();
        if source != DownloadSource::YouTube {
            single.provider_order = vec![source.service().into()];
        }
        // Native code owns the stereo pass so another provider's real Atmos
        // always takes priority over a preceding provider's stereo recording.
        single.atmos_fallback = false;
        attempts.push(DownloadAttempt {
            source,
            quality,
            providers: single,
        });
    };
    if quality == DownloadQuality::Atmos {
        for &provider in &order {
            if matches!(provider, DownloadSource::Tidal | DownloadSource::Amazon) {
                add(provider, DownloadQuality::Atmos);
            }
        }
    }
    if quality != DownloadQuality::Atmos || providers.atmos_fallback {
        for provider in order {
            add(provider, stereo_quality);
        }
        if source == DownloadSource::YouTube || allow_youtube_fallback {
            add(DownloadSource::YouTube, stereo_quality);
        }
    }
    if attempts.is_empty() {
        return Err("The selected providers cannot supply Dolby Atmos. Choose Tidal or Amazon, or allow a stereo fallback.".into());
    }
    Ok(attempts)
}

impl MusicApi {
    pub async fn search_download_catalog(
        &self,
        query: &str,
        kind: CatalogKind,
        offset: u32,
    ) -> Result<CatalogPage, String> {
        self.download_request(
            Method::POST,
            "/api/downloads/search",
            Some(json!({"query":query,"type":kind,"offset":offset,"limit":25})),
        )
        .await?
        .json()
        .await
        .map_err(|_| "Invalid catalog search response".into())
    }
    pub async fn download_availability(
        &self,
        track: &DownloadTrack,
        source: DownloadSource,
        quality: DownloadQuality,
        providers: &ProviderOptions,
    ) -> Result<TrackAvailability, String> {
        self.download_request(Method::POST,"/api/downloads/availability",Some(json!({"track":track,"source":source.service(),"qualityProfile":quality.profile(),"downloadPreferences":providers}))).await?
            .json().await.map_err(|_| "Invalid provider availability response".into())
    }
    pub async fn check_download_sources(
        &self,
        preferences: &ProviderOptions,
    ) -> Result<Vec<DownloadSourceCheck>, String> {
        #[derive(Deserialize)]
        struct Checks {
            sources: Vec<DownloadSourceCheck>,
        }
        self.download_request(
            Method::POST,
            "/api/downloads/check-sources",
            Some(json!({"downloadPreferences":preferences})),
        )
        .await?
        .json::<Checks>()
        .await
        .map(|checks| checks.sources)
        .map_err(|_| "Invalid instance check response".into())
    }

    async fn download_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, String> {
        let url = self
            .origin
            .join(path)
            .map_err(|_| "Invalid download API path")?;
        if !path.starts_with("/api/") || url.origin() != self.origin.origin() {
            return Err("Invalid download API path".into());
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let mut request = self
            .client()
            .request(method, url)
            .timeout(Duration::from_secs(240));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Account changed during download".into());
        }
        if response.url().origin() != self.origin.origin() {
            return Err("Music server redirected outside its origin".into());
        }
        if response.status().as_u16() == 401 {
            self.expired.store(true, Ordering::SeqCst);
            return Err("Sign in again to download music".into());
        }
        if !response.status().is_success() {
            let status = response.status();
            let data: Value = response.json().await.unwrap_or_default();
            return Err(data
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Music server returned {status}")));
        }
        Ok(response)
    }

    pub async fn resolve_download_input(&self, input: &str) -> Result<DownloadCollection, String> {
        self.resolve_download_input_with_artwork(input, true).await
    }

    pub async fn resolve_download_input_with_artwork(
        &self,
        input: &str,
        maximum: bool,
    ) -> Result<DownloadCollection, String> {
        let input = input.trim();
        if input.len() < 2 || input.len() > 2048 {
            return Err("Enter a music search or Spotify link".into());
        }
        self.download_request(
            Method::POST,
            "/api/downloads/resolve",
            Some(json!({"input":input,"maxQualityArtwork":maximum})),
        )
        .await?
        .json()
        .await
        .map_err(|_| "Invalid catalog response".into())
    }

    pub async fn download_artist_images(
        &self,
        input: &str,
        maximum: bool,
    ) -> Result<Vec<DownloadImage>, String> {
        #[derive(Deserialize)]
        struct Images {
            images: Vec<DownloadImage>,
        }
        self.download_request(
            Method::POST,
            "/api/downloads/images",
            Some(json!({"input":input,"maxQualityArtwork":maximum})),
        )
        .await?
        .json::<Images>()
        .await
        .map(|value| value.images)
        .map_err(|_| "Invalid artist image response".into())
    }

    /// Fill sparse playlist/search metadata immediately before export. Catalog
    /// lookup never needs playback or a signed media URL.
    pub async fn enrich_download_track(
        &self,
        track: &DownloadTrack,
    ) -> Result<DownloadTrack, String> {
        let collection = self.resolve_download_input(&track.source_url).await?;
        collection
            .tracks
            .into_iter()
            .find(|candidate| candidate.id == track.id)
            .ok_or_else(|| "Spotify returned a different recording".into())
    }

    pub async fn download_audio(
        &self,
        track: &DownloadTrack,
        source: DownloadSource,
        quality: DownloadQuality,
        allow_youtube_fallback: bool,
        providers: &ProviderOptions,
    ) -> Result<DownloadAudio, String> {
        let attempts = download_attempts(source, quality, allow_youtube_fallback, providers)?;
        let generation = self.generation.load(Ordering::SeqCst);
        let mut last_error = "No download provider succeeded".to_owned();
        for attempt in attempts {
            self.check_download_account(generation)?;
            match self.download_audio_attempt(track, &attempt).await {
                Ok(audio) => return Ok(audio),
                Err(error) => last_error = error,
            }
            self.check_download_account(generation)?;
        }
        Err(last_error)
    }

    fn check_download_account(&self, generation: u64) -> Result<(), String> {
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Account changed during download".into());
        }
        if self.session_expired() {
            return Err("Sign in again to download music".into());
        }
        Ok(())
    }

    async fn download_audio_attempt(
        &self,
        track: &DownloadTrack,
        attempt: &DownloadAttempt,
    ) -> Result<DownloadAudio, String> {
        let mut body = track_payload(track, attempt.source, attempt.quality);
        body["downloadPreferences"] = json!(attempt.providers);
        if attempt.source != DownloadSource::YouTube {
            let response = self
                .download_request(Method::POST, "/api/songs/spotify/file", Some(body))
                .await?;
            let source = response
                .headers()
                .get("x-audio-source")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(attempt.source.label())
                .to_owned();
            let extension = response_extension(&response)?;
            return Ok(DownloadAudio {
                response,
                source,
                extension,
            });
        }
        body["preview"] = json!(true);
        body["trackId"] = json!(format!("download-youtube-{}", track.id));
        body.as_object_mut()
            .expect("track payload")
            .remove("spotifyUrl");
        let song: MusicSong = self
            .download_request(Method::POST, "/api/discover/stage", Some(body))
            .await?
            .json()
            .await
            .map_err(|_| "Invalid fallback audio response")?;
        let url = self
            .origin
            .join(&song.audio_url)
            .map_err(|_| "Invalid fallback audio location")?;
        if url.origin() != self.origin.origin() || !url.path().starts_with("/api/files/") {
            return Err("Fallback audio is outside the music server".into());
        }
        let path = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let response = self.download_request(Method::GET, &path, None).await?;
        let extension = response_extension(&response)?;
        Ok(DownloadAudio {
            response,
            source: "YouTube".into(),
            extension,
        })
    }

    pub async fn download_lyrics(&self, track: &DownloadTrack) -> Result<Option<String>, String> {
        self.download_lyrics_with_options(track, &LyricsOptions::default())
            .await
    }

    pub async fn download_lyrics_with_options(
        &self,
        track: &DownloadTrack,
        preferences: &LyricsOptions,
    ) -> Result<Option<String>, String> {
        let mut body = track_payload(track, DownloadSource::Auto, DownloadQuality::Max);
        body["action"] = json!("lyrics");
        body["lyricsPreferences"] = json!({"titleFallback":preferences.title_fallback});
        let response = self
            .download_request(Method::POST, "/api/songs/spotify", Some(body))
            .await;
        match response {
            Ok(response) => {
                let value: Value = response
                    .json()
                    .await
                    .map_err(|_| "Invalid lyrics response")?;
                Ok(value
                    .get("lyrics")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned))
            }
            Err(error) if error.to_lowercase().contains("lyrics not found") => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn download_cover(&self, cover_url: &str) -> Result<Vec<u8>, String> {
        if cover_url.is_empty() {
            return Ok(Vec::new());
        }
        self.download_public_cover(allowed_cover_url(cover_url)?)
            .await
    }

    pub async fn download_cover_with_size(
        &self,
        cover_url: &str,
        maximum: bool,
    ) -> Result<Vec<u8>, String> {
        let (url, fallback) = artwork_urls(cover_url, maximum)?;
        match self.download_public_cover(url.clone()).await {
            Ok(bytes) => Ok(bytes),
            Err(_) if fallback != url => self.download_public_cover(fallback).await,
            Err(error) => Err(error),
        }
    }

    async fn download_public_cover(&self, url: Url) -> Result<Vec<u8>, String> {
        // Public artwork comes straight from its CDN. This dedicated client has
        // no cookie jar or authorization headers and never follows redirects.
        let generation = self.generation.load(Ordering::SeqCst);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "Could not create artwork client")?;
        let mut response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "image/jpeg,image/png,image/webp")
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if !response.status().is_success() {
            return Err(format!("Artwork server returned {}", response.status()));
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if !["image/jpeg", "image/png", "image/webp"].contains(&mime) {
            return Err("Artwork server did not return a supported image".into());
        }
        const LIMIT: usize = 16 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
        {
            return Err("Cover image exceeds 16 MB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if bytes.len() + chunk.len() > LIMIT {
                return Err("Cover image exceeds 16 MB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Account changed during download".into());
        }
        Ok(bytes)
    }

    pub async fn save_download_to_library(
        &self,
        track: &DownloadTrack,
        source: DownloadSource,
        quality: DownloadQuality,
        allow_youtube_fallback: bool,
        providers: &ProviderOptions,
    ) -> Result<String, String> {
        let attempts = download_attempts(source, quality, allow_youtube_fallback, providers)?;
        let generation = self.generation.load(Ordering::SeqCst);
        let mut staged = None;
        let mut last_error = "No download provider succeeded".to_owned();
        for attempt in attempts {
            self.check_download_account(generation)?;
            match self.stage_download_attempt(track, &attempt).await {
                Ok(song) => {
                    staged = Some(song);
                    break;
                }
                Err(error) => last_error = error,
            }
            self.check_download_account(generation)?;
        }
        let (song, fallback_stage_id) = staged.ok_or(last_error)?;
        self.check_download_account(generation)?;
        let stage_id = song
            .discover_track_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .unwrap_or(&fallback_stage_id);
        self.invalidate_reads();
        // Promotion may already have committed if the connection fails. Never
        // retry it through another provider and risk creating a duplicate save.
        let response = self
            .download_request(
                Method::POST,
                "/api/discover/promote",
                Some(json!({"trackId":stage_id,"finalId":song.id})),
            )
            .await;
        self.invalidate_reads();
        let saved: MusicSong = response?
            .json()
            .await
            .map_err(|_| "Invalid library save response")?;
        if saved.id.is_empty() || saved.audio_url.is_empty() {
            return Err("Music server did not save this song".into());
        }
        self.check_download_account(generation)?;
        let saved = self.remember(saved);
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .promoted
            .insert(track.id.clone(), saved.clone());
        Ok(saved.id)
    }

    async fn stage_download_attempt(
        &self,
        track: &DownloadTrack,
        attempt: &DownloadAttempt,
    ) -> Result<(MusicSong, String), String> {
        let mut body = track_payload(track, attempt.source, attempt.quality);
        body["downloadPreferences"] = json!(attempt.providers);
        body["preview"] = json!(attempt.source == DownloadSource::YouTube);
        // The native attempt list owns cross-provider and YouTube fallback.
        body["allowYouTubeFallback"] = json!(false);
        body["downloadRequest"] = json!(true);
        // Direct YouTube selection is explicitly eligible for keeping, unlike
        // ordinary low-latency playback previews.
        body["libraryFallback"] = json!(attempt.source == DownloadSource::YouTube);
        let stage_id = if attempt.source == DownloadSource::YouTube {
            let id = format!("download-youtube-{}", track.id);
            body["trackId"] = json!(id);
            body.as_object_mut()
                .expect("track payload")
                .remove("spotifyUrl");
            id
        } else {
            track.id.clone()
        };
        let song: MusicSong = self
            .download_request(Method::POST, "/api/discover/stage", Some(body))
            .await?
            .json()
            .await
            .map_err(|_| "Invalid library staging response")?;
        if song.id.is_empty() || song.audio_url.is_empty() {
            return Err("Music server did not stage audio for this song".into());
        }
        Ok((song, stage_id))
    }
}

fn artwork_urls(input: &str, maximum: bool) -> Result<(Url, Url), String> {
    let original = allowed_cover_url(input)?;
    let mut selected = original.clone();
    let mut fallback = original.clone();
    if original.host_str() == Some("i.scdn.co") {
        let path = original.path();
        if maximum {
            let path = path
                .replace("ab67616d00001e02", "ab67616d000082c1")
                .replace("ab67616d00004851", "ab67616d000082c1")
                .replace("ab67616d0000b273", "ab67616d000082c1");
            selected.set_path(&path);
            fallback.set_path(
                &original
                    .path()
                    .replace("ab67616d000082c1", "ab67616d0000b273"),
            );
        } else {
            selected.set_path(&path.replace("ab67616d000082c1", "ab67616d0000b273"));
        }
    }
    Ok((selected, fallback))
}

fn allowed_cover_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "Invalid artwork URL")?;
    let hosts = [
        "scdn.co",
        "spotifycdn.com",
        "dzcdn.net",
        "ytimg.com",
        "mzstatic.com",
        "qobuz.com",
        "tidal.com",
    ];
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !hosts
            .iter()
            .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
    {
        return Err("Unsupported artwork host".into());
    }
    Ok(url)
}

fn response_extension(response: &Response) -> Result<String, String> {
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    let ext = match mime {
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" | "application/ogg" | "audio/opus" => "opus",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/octet-stream" => "audio",
        _ => return Err("Music server did not return an audio file".into()),
    };
    Ok(ext.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_api::tests::{Server, error, reply};
    use std::sync::{Arc, atomic::AtomicUsize};

    #[test]
    fn maximum_artwork_has_a_standard_cdn_fallback_even_for_resolved_max_urls() {
        for code in ["ab67616d00001e02", "ab67616d0000b273", "ab67616d000082c1"] {
            let input = format!("https://i.scdn.co/image/{code}recording");
            let (selected, fallback) = artwork_urls(&input, true).unwrap();
            assert!(selected.path().contains("ab67616d000082c1"));
            assert!(!fallback.path().contains("ab67616d000082c1"));
        }
        let artist = "https://i.scdn.co/image/ab6761610000e5ebartist";
        let (selected, fallback) = artwork_urls(artist, true).unwrap();
        assert_eq!(selected.as_str(), artist);
        assert_eq!(fallback, selected);
    }

    #[tokio::test]
    async fn catalog_search_availability_and_lyrics_use_typed_api_contracts() {
        let server = Server::new(|request| match request.path.as_str() {
            "/api/downloads/search" => {
                assert_eq!(request.body["type"], "album");
                assert_eq!(request.body["offset"], 25);
                assert_eq!(request.body["limit"], 25);
                reply(
                    json!({"items":[{"id":"album-id","kind":"album","title":"Album","sourceUrl":"spotify:album:album-id"}],"offset":25,"limit":25,"total":26,"totalExact":false,"hasMore":true}),
                )
            }
            "/api/downloads/availability" => {
                assert_eq!(request.body["track"]["id"], "track-id");
                assert_eq!(request.body["source"], "qobuz");
                assert_eq!(request.body["qualityProfile"], "hires48");
                reply(
                    json!({"sources":[{"source":"qobuz","status":"unknown","message":"Verify on download"}],"checkedAt":"2026-10-03T00:00:00Z"}),
                )
            }
            "/api/songs/spotify" => {
                assert_eq!(request.body["lyricsPreferences"]["titleFallback"], false);
                assert!(
                    request.body["lyricsPreferences"]
                        .get("translationProvider")
                        .is_none()
                );
                reply(json!({"lyrics":"A synthetic lyric line"}))
            }
            _ => panic!("Unexpected route: {}", request.path),
        });
        let api = server.api();
        let page = api
            .search_download_catalog("Album", CatalogKind::Album, 25)
            .await
            .unwrap();
        assert_eq!(page.items[0].kind, "album");
        assert!(!page.total_exact);
        assert!(page.has_more);
        let track = DownloadTrack {
            id: "track-id".into(),
            ..Default::default()
        };
        let check = api
            .download_availability(
                &track,
                DownloadSource::Qobuz,
                DownloadQuality::HiRes48,
                &ProviderOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(check.sources[0].status, "unknown");
        let lyrics = LyricsOptions {
            title_fallback: false,
            ..Default::default()
        };
        assert_eq!(
            api.download_lyrics_with_options(&track, &lyrics)
                .await
                .unwrap()
                .as_deref(),
            Some("A synthetic lyric line")
        );
    }

    fn artwork_server(response: &'static str) -> (Url, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/cover.jpg",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..end]);
                    let length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, thread)
    }

    #[test]
    fn public_cover_allowlist_rejects_credentials_and_impostor_hosts() {
        for url in [
            "https://i.scdn.co/image/abc",
            "https://image-cdn-ak.spotifycdn.com/image/abc",
        ] {
            assert!(allowed_cover_url(url).is_ok());
        }
        for url in [
            "http://i.scdn.co/image/abc",
            "https://127.0.0.1/x",
            "https://i.scdn.co.attacker.invalid/x",
            "https://user:pass@i.scdn.co/x",
            "https://i.scdn.co:444/x",
        ] {
            assert!(allowed_cover_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn public_cover_uses_no_session_cookie_or_authorization() {
        let (url, server) = artwork_server(
            "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDATA",
        );
        let api = MusicApi::new(
            url.origin().ascii_serialization().as_str(),
            crate::http::Http::default(),
        )
        .unwrap();
        api.restore_session_cookie("must-not-reach-artwork")
            .unwrap();
        assert_eq!(api.download_public_cover(url).await.unwrap(), b"DATA");
        let headers = server.join().unwrap().to_ascii_lowercase();
        assert!(!headers.contains("cookie:"));
        assert!(!headers.contains("authorization:"));
    }

    #[tokio::test]
    async fn public_cover_refuses_redirects_wrong_types_and_oversized_files() {
        let api = MusicApi::new("https://music.example", crate::http::Http::default()).unwrap();
        for (response, error) in [
            (
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "302",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDATA",
                "supported image",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n",
                "16 MB",
            ),
        ] {
            let (url, server) = artwork_server(response);
            assert!(
                api.download_public_cover(url)
                    .await
                    .unwrap_err()
                    .contains(error)
            );
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn download_catalog_uses_existing_origin_scoped_session() {
        let server = Server::new(|request| {
            assert_eq!(request.path, "/api/downloads/resolve");
            assert!(
                request
                    .cookie
                    .contains("spotify_session=test-download-session")
            );
            assert_eq!(request.body["input"], "Artist track");
            reply(
                json!({"title":"Found", "kind":"search", "tracks":[{"id":"id","title":"Track","artists":["Artist"]}]}),
            )
        });
        let api = server.api();
        api.restore_session_cookie("test-download-session").unwrap();
        let result = api.resolve_download_input("Artist track").await.unwrap();
        assert_eq!(result.tracks[0].artists, vec!["Artist"]);
        assert_eq!(result.tracks[0].track_number, 0);
    }

    #[tokio::test]
    async fn auth_failure_never_triggers_youtube_fallback() {
        let count = Arc::new(AtomicUsize::new(0));
        let captured = count.clone();
        let server = Server::new(move |request| {
            captured.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.path, "/api/songs/spotify/file");
            error(401)
        });
        let api = server.api();
        assert!(
            api.download_audio(
                &DownloadTrack::default(),
                DownloadSource::Auto,
                DownloadQuality::Max,
                true,
                &ProviderOptions::default(),
            )
            .await
            .is_err()
        );
        assert!(api.session_expired());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn disabled_fallback_preserves_provider_failure() {
        let server = Server::new(|request| {
            assert_eq!(request.path, "/api/songs/spotify/file");
            assert_eq!(request.body["service"], "qobuz");
            assert_eq!(request.body["qualityProfile"], "cd");
            error(503)
        });
        let result = server
            .api()
            .download_audio(
                &DownloadTrack::default(),
                DownloadSource::Qobuz,
                DownloadQuality::Cd,
                false,
                &ProviderOptions {
                    provider_fallback: false,
                    ..Default::default()
                },
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn first_provider_audio_success_does_not_request_other_sources() {
        let (url, server) = artwork_server(
            "HTTP/1.1 200 OK\r\nContent-Type: audio/flac\r\nX-Audio-Source: Tidal\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfLaC",
        );
        let api = MusicApi::new(
            &url.origin().ascii_serialization(),
            crate::http::Http::default(),
        )
        .unwrap();
        let audio = api
            .download_audio(
                &DownloadTrack::default(),
                DownloadSource::Auto,
                DownloadQuality::Max,
                true,
                &ProviderOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(audio.source, "Tidal");
        assert_eq!(audio.response.bytes().await.unwrap().as_ref(), b"fLaC");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /api/songs/spotify/file "));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["service"], "tidal");
        assert_eq!(
            body["downloadPreferences"]["providerOrder"],
            json!(["tidal"])
        );
        assert_eq!(body["downloadPreferences"]["providerFallback"], true);
    }

    #[tokio::test]
    async fn library_fallback_is_lazy_and_promotes_only_the_successful_stage() {
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = Server::new(move |request| {
            captured
                .lock()
                .unwrap()
                .push((request.path.clone(), request.body.clone()));
            match request.path.as_str() {
                "/api/discover/stage" if request.body["service"] == "tidal" => error(502),
                "/api/discover/stage" => {
                    assert_eq!(request.body["service"], "qobuz");
                    assert_eq!(request.body["allowYouTubeFallback"], false);
                    assert_eq!(
                        request.body["downloadPreferences"]["providerOrder"],
                        json!(["qobuz"])
                    );
                    reply(
                        json!({"id":"stage", "discoverTrackId":"qobuz-stage", "audioUrl":"/api/files/local/track.flac"}),
                    )
                }
                "/api/discover/promote" => {
                    assert_eq!(request.body["trackId"], "qobuz-stage");
                    reply(json!({"id":"saved", "audioUrl":"/api/files/local/track.flac"}))
                }
                _ => panic!("Unexpected request"),
            }
        });
        let result = server
            .api()
            .save_download_to_library(
                &DownloadTrack::default(),
                DownloadSource::Auto,
                DownloadQuality::Max,
                true,
                &ProviderOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(result, "saved");
        assert_eq!(requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn library_promotion_failure_does_not_restart_with_another_provider() {
        let count = Arc::new(AtomicUsize::new(0));
        let captured = count.clone();
        let server = Server::new(move |request| {
            captured.fetch_add(1, Ordering::SeqCst);
            match request.path.as_str() {
                "/api/discover/stage" => {
                    reply(json!({"id":"stage", "audioUrl":"/api/files/local/track.flac"}))
                }
                "/api/discover/promote" => error(503),
                _ => panic!("Unexpected request"),
            }
        });
        assert!(
            server
                .api()
                .save_download_to_library(
                    &DownloadTrack::default(),
                    DownloadSource::Auto,
                    DownloadQuality::Max,
                    true,
                    &ProviderOptions::default(),
                )
                .await
                .is_err()
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn atmos_checks_all_spatial_sources_before_any_stereo_stage() {
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = Server::new(move |request| {
            captured.lock().unwrap().push((
                request.body["service"].clone(),
                request.body["qualityProfile"].clone(),
            ));
            if request.path == "/api/discover/promote" {
                return reply(json!({"id":"saved", "audioUrl":"/api/files/local/track.flac"}));
            }
            assert_eq!(request.body["downloadPreferences"]["atmosFallback"], false);
            if request.body["qualityProfile"] == "atmos" {
                return error(502);
            }
            assert_eq!(request.body["service"], "tidal");
            assert_eq!(request.body["qualityProfile"], "cd");
            reply(json!({"id":"stage", "audioUrl":"/api/files/local/track.flac"}))
        });
        server
            .api()
            .save_download_to_library(
                &DownloadTrack::default(),
                DownloadSource::Auto,
                DownloadQuality::Atmos,
                true,
                &ProviderOptions {
                    atmos_fallback_quality: "cd".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(
            &requests[..3],
            &[
                (json!("tidal"), json!("atmos")),
                (json!("amazon"), json!("atmos")),
                (json!("tidal"), json!("cd"))
            ]
        );
        assert_eq!(requests.len(), 4);
    }

    #[test]
    fn attempt_order_honors_explicit_provider_and_strict_atmos() {
        let options = ProviderOptions::default();
        let attempts =
            download_attempts(DownloadSource::Qobuz, DownloadQuality::Max, true, &options).unwrap();
        assert_eq!(
            attempts.iter().map(|a| a.source).collect::<Vec<_>>(),
            vec![
                DownloadSource::Qobuz,
                DownloadSource::Tidal,
                DownloadSource::Amazon,
                DownloadSource::YouTube
            ]
        );
        let strict = ProviderOptions {
            atmos_fallback: false,
            ..options
        };
        let attempts =
            download_attempts(DownloadSource::Auto, DownloadQuality::Atmos, true, &strict).unwrap();
        assert_eq!(
            attempts.iter().map(|a| a.source).collect::<Vec<_>>(),
            vec![DownloadSource::Tidal, DownloadSource::Amazon]
        );
        assert!(
            attempts
                .iter()
                .all(|a| a.quality == DownloadQuality::Atmos && !a.providers.atmos_fallback)
        );
        assert!(
            download_attempts(
                DownloadSource::YouTube,
                DownloadQuality::Atmos,
                true,
                &strict
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn download_requests_reject_off_origin_paths_before_io() {
        let api = MusicApi::new("https://music.example", crate::http::Http::default()).unwrap();
        for path in [
            "https://other.example/api/cover",
            "//other.example/api/cover",
            "/auth",
        ] {
            assert!(api.download_request(Method::GET, path, None).await.is_err());
        }
    }
    #[tokio::test]
    async fn library_promotion_reads_bare_song_and_invalidates_cached_library() {
        let reads = Arc::new(AtomicUsize::new(0));
        let captured = reads.clone();
        let server = Server::new(move |request| match request.path.as_str() {
            "/api/songs" => {
                captured.fetch_add(1, Ordering::SeqCst);
                reply(json!({"songs":[]}))
            }
            "/api/discover/stage" => {
                assert_eq!(request.body["downloadRequest"], true);
                reply(
                    json!({"id":"staged","title":"Song","artist":"Artist", "discoverTrackId":"download-staged-id", "audioUrl":"/api/files/local/staged.flac"}),
                )
            }
            "/api/discover/promote" => {
                assert_eq!(request.body["trackId"], "download-staged-id");
                reply(
                    json!({"id":"saved","title":"Song","artist":"Artist","audioUrl":"/api/files/local/saved.flac"}),
                )
            }
            _ => panic!("Unexpected API request"),
        });
        let api = server.api();
        api.get("/api/songs").await.unwrap();
        api.get("/api/songs").await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let saved = api
            .save_download_to_library(
                &DownloadTrack {
                    id: "original".into(),
                    ..Default::default()
                },
                DownloadSource::Auto,
                DownloadQuality::Max,
                true,
                &ProviderOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(saved, "saved");
        api.get("/api/songs").await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(api.state.lock().unwrap().promoted["original"].id, "saved");
    }
}
