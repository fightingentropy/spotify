//! Durable download jobs and local exports. Provider resolution stays in the
//! music API; this module only handles explicit local files and local tools.

mod export;
mod library_index;
pub mod lyrics;
mod options;
mod preferences;
pub mod tools;
use crate::music_api::{
    MusicApi,
    downloads::{DownloadQuality, DownloadSource, DownloadTrack},
};
pub use export::{export_file, tool_available, write_playlist};
pub use options::*;
pub use preferences::{read_preferences, write_preferences};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_HISTORY_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutputFormat {
    #[default]
    Original,
    Flac,
    Alac,
    Mp3,
    Opus,
    Wav,
    Aac,
    Aiff,
}
impl OutputFormat {
    pub const ALL: [Self; 8] = [
        Self::Original,
        Self::Flac,
        Self::Alac,
        Self::Mp3,
        Self::Opus,
        Self::Wav,
        Self::Aac,
        Self::Aiff,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Self::Original => "Original quality",
            Self::Flac => "FLAC",
            Self::Alac => "ALAC",
            Self::Mp3 => "MP3",
            Self::Opus => "Opus",
            Self::Wav => "WAV",
            Self::Aac => "AAC (M4A)",
            Self::Aiff => "AIFF",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DuplicatePolicy {
    #[default]
    Skip,
    Rename,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Destination {
    #[default]
    Mac,
    Library,
    Both,
}
impl Destination {
    pub const ALL: [Self; 3] = [Self::Mac, Self::Library, Self::Both];
    pub fn label(self) -> &'static str {
        match self {
            Self::Mac => "This Mac",
            Self::Library => "Music library",
            Self::Both => "Mac and library",
        }
    }
    pub fn local(self) -> bool {
        matches!(self, Self::Mac | Self::Both)
    }
    pub fn library(self) -> bool {
        matches!(self, Self::Library | Self::Both)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExportOptions {
    pub output_dir: PathBuf,
    pub destination: Destination,
    pub source: DownloadSource,
    pub quality: DownloadQuality,
    pub allow_youtube_fallback: bool,
    pub format: OutputFormat,
    pub bitrate_kbps: u32,
    pub sample_rate: Option<u32>,
    pub replay_gain: bool,
    pub embed_tags: bool,
    pub embed_artwork: bool,
    pub embed_lyrics: bool,
    pub cover_sidecar: bool,
    pub lyrics_sidecar: bool,
    pub lyrics: LyricsOptions,
    pub max_artwork: bool,
    pub create_playlist: bool,
    pub folder_template: String,
    pub filename_template: String,
    pub duplicates: DuplicatePolicy,
    pub metadata_tags: MetadataTags,
    pub providers: ProviderOptions,
    pub artist_separator: ArtistSeparator,
    pub first_artist_only: bool,
    pub single_genre: bool,
    pub year_only: bool,
    pub bit_depth: Option<u32>,
    pub existing_file_check: ExistingFileCheck,
    pub replay_gain_mode: ReplayGainMode,
    pub album_filename_template: String,
    pub separate_album_filename: bool,
    pub keep_original: bool,
    pub export_log: bool,
    pub log_failures_only: bool,
    pub apply_folder_to_single_track: bool,
    pub create_playlist_folder: bool,
    pub playlist_owner_folder: bool,
}
impl Default for ExportOptions {
    fn default() -> Self {
        let base = directories::UserDirs::new()
            .map(|dirs| dirs.audio_dir().unwrap_or(dirs.home_dir()).to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            output_dir: base.join("Spotify Downloads"),
            destination: Destination::Mac,
            source: DownloadSource::Auto,
            quality: DownloadQuality::Max,
            allow_youtube_fallback: true,
            format: OutputFormat::Original,
            bitrate_kbps: 320,
            sample_rate: None,
            replay_gain: false,
            embed_tags: true,
            embed_artwork: true,
            embed_lyrics: true,
            cover_sidecar: false,
            lyrics_sidecar: true,
            lyrics: LyricsOptions::default(),
            max_artwork: true,
            create_playlist: false,
            folder_template: "{artist}/{album}".into(),
            filename_template: "{artist} - {title}".into(),
            duplicates: DuplicatePolicy::Skip,
            metadata_tags: MetadataTags::default(),
            providers: ProviderOptions::default(),
            artist_separator: ArtistSeparator::default(),
            first_artist_only: false,
            single_genre: false,
            year_only: false,
            bit_depth: None,
            existing_file_check: ExistingFileCheck::default(),
            replay_gain_mode: ReplayGainMode::default(),
            album_filename_template: "{track} - {title}".into(),
            separate_album_filename: false,
            keep_original: false,
            export_log: false,
            log_failures_only: false,
            apply_folder_to_single_track: true,
            create_playlist_folder: false,
            playlist_owner_folder: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TrackMetadata {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub disc_total: Option<u32>,
    pub year: String,
    pub genre: String,
    pub isrc: String,
    pub upc: String,
    pub composer: String,
    pub copyright: String,
    pub label: String,
    pub duration_ms: u64,
    pub source_url: String,
    pub artists: Vec<String>,
    pub collection: String,
    pub collection_owner: String,
    pub category: String,
}
impl From<&DownloadTrack> for TrackMetadata {
    fn from(track: &DownloadTrack) -> Self {
        Self {
            id: track.id.clone(),
            title: track.title.clone(),
            artist: track.artists.join(", "),
            album: track.album.clone(),
            album_artist: if track.album_artist.is_empty() {
                track.artists.join(", ")
            } else {
                track.album_artist.clone()
            },
            track_number: (track.track_number > 0).then_some(track.track_number),
            track_total: (track.track_total > 0).then_some(track.track_total),
            disc_number: (track.disc_number > 0).then_some(track.disc_number),
            disc_total: (track.disc_total > 0).then_some(track.disc_total),
            year: track.release_date.clone(),
            genre: track.genre.clone(),
            isrc: track.isrc.clone(),
            upc: track.upc.clone(),
            composer: track.composer.clone(),
            copyright: track.copyright.clone(),
            label: track.label.clone(),
            duration_ms: track.duration_ms,
            source_url: track.source_url.clone(),
            artists: track.artists.clone(),
            collection: String::new(),
            collection_owner: String::new(),
            category: match track.release_type.to_ascii_lowercase().as_str() {
                "single" => "Singles",
                "compilation" => "Compilations",
                _ => "Albums",
            }
            .into(),
        }
    }
}

/// Short-lived provider response. Never serialize this: signed media links and
/// session-bearing URLs do not belong in the durable queue.
#[derive(Debug)]
pub struct ExportInput {
    pub metadata: TrackMetadata,
    pub response: reqwest::Response,
    pub cover: Option<Vec<u8>>,
    pub lyrics: Option<String>,
    pub source: Option<String>,
    pub extension: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioQuality {
    pub codec: String,
    pub container: String,
    pub sample_rate: u32,
    pub bit_depth: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub channels: u32,
    pub lossless: bool,
}
impl AudioQuality {
    pub fn label(&self) -> String {
        let mut parts = vec![self.codec.to_uppercase()];
        if let Some(bits) = self.bit_depth.filter(|_| self.lossless) {
            parts.push(format!("{bits}-bit"));
        }
        if self.sample_rate > 0 {
            parts.push(format!("{} kHz", self.sample_rate as f64 / 1000.0));
        }
        if let Some(rate) = self.bitrate_kbps.filter(|_| !self.lossless) {
            parts.push(format!("{rate} kbps"));
        }
        parts.join(" · ")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportReceipt {
    pub path: PathBuf,
    pub bytes: u64,
    #[serde(default)]
    pub album_gain_applied: bool,
    pub quality: AudioQuality,
    pub source_quality: AudioQuality,
    pub source: Option<String>,
    pub skipped: bool,
    pub sidecars: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct JobReceipt {
    pub file: Option<ExportReceipt>,
    pub library_song_id: Option<String>,
    pub file_error: Option<String>,
    pub library_error: Option<String>,
    pub cancelled: bool,
}
impl JobReceipt {
    pub fn succeeded(&self) -> bool {
        self.file.is_some() || self.library_song_id.is_some()
    }
    pub fn stage(&self) -> JobStage {
        if self.cancelled {
            JobStage::Cancelled
        } else if self.file_error.is_some() || self.library_error.is_some() {
            JobStage::Failed
        } else if self.succeeded() {
            JobStage::Completed
        } else {
            JobStage::Failed
        }
    }
    pub fn error_summary(&self) -> Option<String> {
        let errors: Vec<String> = [("Mac", &self.file_error), ("Library", &self.library_error)]
            .into_iter()
            .filter_map(|(kind, error)| error.as_ref().map(|error| format!("{kind}: {error}")))
            .collect();
        (!errors.is_empty()).then(|| errors.join(" · "))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobStage {
    #[default]
    Queued,
    Resolving,
    Downloading,
    Processing,
    SavingLibrary,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl JobStage {
    pub fn label(self) -> &'static str {
        match self {
            Self::Queued => "Queued",
            Self::Resolving => "Finding audio",
            Self::Downloading => "Downloading",
            Self::Processing => "Finishing file",
            Self::SavingLibrary => "Saving to library",
            Self::Completed => "Completed",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
            Self::Interrupted => "Interrupted",
        }
    }
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Resolving | Self::Downloading | Self::Processing | Self::SavingLibrary
        )
    }
    pub fn retryable(self) -> bool {
        matches!(self, Self::Failed | Self::Cancelled | Self::Interrupted)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TransferProgress {
    pub stage: JobStage,
    pub received: u64,
    pub total: Option<u64>,
}
impl TransferProgress {
    pub fn fraction(&self) -> Option<f32> {
        self.total
            .filter(|total| *total > 0)
            .map(|total| (self.received as f64 / total as f64).clamp(0.0, 1.0) as f32)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: u64,
    #[serde(default)]
    pub batch_id: u64,
    #[serde(default)]
    pub collection_title: String,
    #[serde(default)]
    pub collection_kind: String,
    #[serde(default)]
    pub collection_owner: String,
    pub track: DownloadTrack,
    pub options: ExportOptions,
    pub stage: JobStage,
    pub progress: TransferProgress,
    pub receipt: Option<JobReceipt>,
    pub error: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QueueState {
    pub account_id: String,
    #[serde(default)]
    pub revision: u64,
    pub jobs: Vec<DownloadJob>,
    pub next_id: u64,
    #[serde(default)]
    pub options: ExportOptions,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub recent_inputs: Vec<String>,
}
impl QueueState {
    pub fn for_account(account_id: impl Into<String>) -> Self {
        Self {
            account_id: account_id.into(),
            next_id: 1,
            ..Self::default()
        }
    }
    pub fn enqueue(&mut self, track: DownloadTrack, options: ExportOptions) -> Option<u64> {
        if self.jobs.iter().any(|job| {
            job.track.id == track.id
                && job.options == options
                && (job.stage == JobStage::Queued || job.stage.active())
        }) {
            return None;
        }
        let id = self.next_id.max(1);
        self.next_id = id.saturating_add(1);
        self.jobs.push(DownloadJob {
            id,
            batch_id: 0,
            collection_title: String::new(),
            collection_kind: String::new(),
            collection_owner: String::new(),
            track,
            options,
            stage: JobStage::Queued,
            progress: TransferProgress::default(),
            receipt: None,
            error: None,
            created_at: now(),
        });
        Some(id)
    }
    pub fn retry(&mut self, id: u64) -> bool {
        let Some(job) = self
            .jobs
            .iter_mut()
            .find(|job| job.id == id && job.stage.retryable())
        else {
            return false;
        };
        job.stage = JobStage::Queued;
        job.progress = TransferProgress::default();
        job.error = None;
        true
    }
    pub fn update(&mut self, id: u64, progress: TransferProgress) {
        if let Some(job) = self
            .jobs
            .iter_mut()
            .find(|job| job.id == id && (job.stage == JobStage::Queued || job.stage.active()))
        {
            job.stage = progress.stage;
            job.progress = progress;
        }
    }
    pub fn finish(&mut self, id: u64, receipt: JobReceipt) {
        if let Some(job) = self.jobs.iter_mut().find(|job| job.id == id) {
            job.stage = receipt.stage();
            job.error = receipt.error_summary();
            job.receipt = Some(receipt);
        }
    }
    pub fn path(state_dir: &Path, account_id: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        state_dir
            .join("downloads")
            .join(format!("{:x}.json", Sha256::digest(account_id.as_bytes())))
    }
    pub fn load(state_dir: &Path, account_id: &str) -> Result<Self, String> {
        let path = Self::path(state_dir, account_id);
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::for_account(account_id));
            }
            Err(error) => return Err(format!("Could not read download history: {error}")),
        };
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_HISTORY_BYTES {
            return Err("Download history is too large to load.".into());
        }
        let mut state: Self = serde_json::from_reader(file)
            .map_err(|_| "Download history could not be read.".to_owned())?;
        if state.account_id != account_id {
            return Err("Download history belongs to a different account.".into());
        }
        for job in &mut state.jobs {
            if job.stage.active() || job.stage == JobStage::Queued {
                job.stage = JobStage::Interrupted;
                job.error =
                    Some("The app closed before this download finished. Retry to continue.".into());
            }
        }
        state.next_id = state.next_id.max(
            state
                .jobs
                .iter()
                .map(|job| job.id)
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        );
        Ok(state)
    }
    pub fn save(&self, state_dir: &Path) -> Result<(), String> {
        static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _write = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = Self::path(state_dir, &self.account_id);
        match std::fs::File::open(&path) {
            Ok(file) => {
                if file.metadata().map_err(|error| error.to_string())?.len() > MAX_HISTORY_BYTES {
                    return Err("Existing download history is too large to update safely.".into());
                }
                let current: Self = serde_json::from_reader(file).map_err(|_| {
                    "Existing download history is unreadable; it was preserved.".to_owned()
                })?;
                if current.account_id != self.account_id {
                    return Err("Existing download history belongs to a different account; it was preserved.".into());
                }
                if current.revision > self.revision {
                    return Ok(());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not read existing download history: {error}")),
        }
        std::fs::create_dir_all(path.parent().expect("download history directory"))
            .map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_HISTORY_BYTES {
            return Err("Download history exceeds 64 MB. Clear finished history before adding more downloads.".into());
        }
        let temporary = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
        let write = || -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()
        };
        write()
            .and_then(|()| crate::util::replace_file(&temporary, &path))
            .map_err(|error| {
                let _ = std::fs::remove_file(&temporary);
                format!("Could not save download history: {error}")
            })
    }
}

pub const CANCELLED: &str = "Download cancelled.";
#[derive(Clone, Default, Debug)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}
pub type ProgressCallback = Arc<dyn Fn(TransferProgress) + Send + Sync>;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn cancellable<T>(
    cancel: &Cancellation,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        tokio::select! { result = &mut future => return result, _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => cancel.check()?, }
    }
}

fn optional_download_asset<T>(
    result: Result<Option<T>, String>,
    unavailable: &str,
    warnings: &mut Vec<String>,
) -> Result<Option<T>, String> {
    match result {
        Ok(Some(asset)) => Ok(Some(asset)),
        Err(error) if error == CANCELLED => Err(error),
        Ok(None) | Err(_) => {
            warnings.push(unavailable.into());
            Ok(None)
        }
    }
}

/// A library failure must not hide a successfully exported local file, and a
/// local disk failure must not discard a successful library save.
pub async fn execute_job(
    api: MusicApi,
    job: DownloadJob,
    cancel: Cancellation,
    progress: ProgressCallback,
) -> JobReceipt {
    let mut receipt = job.receipt.clone().unwrap_or_default();
    receipt.cancelled = false;
    let options = &job.options;
    if options.destination.local() && receipt.file.is_none() {
        receipt.file_error = None;
        let result = async {
            cancel.check()?;
            progress(TransferProgress {
                stage: JobStage::Resolving,
                ..Default::default()
            });
            let mut warnings = Vec::new();
            let needs_recording_identity = options.duplicates == DuplicatePolicy::Skip
                && options.existing_file_check != ExistingFileCheck::Filename
                && job.track.isrc.is_empty();
            let track = if options.embed_tags || needs_recording_identity {
                match cancellable(&cancel, api.enrich_download_track(&job.track)).await {
                    Ok(track) => track,
                    Err(error) if error == CANCELLED => return Err(error),
                    Err(_) => {
                        warnings.push("Some additional album metadata was unavailable.".into());
                        job.track.clone()
                    }
                }
            } else {
                job.track.clone()
            };
            let existing_options = options.clone();
            let existing_metadata = TrackMetadata::from(&track);
            let existing_cancel = cancel.clone();
            if let Some(existing) = tokio::task::spawn_blocking(move || {
                export::find_existing_recording(
                    &existing_options,
                    &existing_metadata,
                    &existing_cancel,
                )
            })
            .await
            .map_err(|_| "Duplicate check was interrupted.")??
            {
                return Ok(existing);
            }
            let audio = cancellable(
                &cancel,
                api.download_audio(
                    &track,
                    options.source,
                    options.quality,
                    options.allow_youtube_fallback,
                    &options.providers,
                ),
            )
            .await?;
            let cover = if options.embed_artwork || options.cover_sidecar {
                let result = cancellable(
                    &cancel,
                    api.download_cover_with_size(&track.cover_url, options.max_artwork),
                )
                .await
                .map(|bytes| (!bytes.is_empty()).then_some(bytes));
                optional_download_asset(result, "Artwork was unavailable.", &mut warnings)?
            } else {
                None
            };
            let lyrics = if options.embed_lyrics || options.lyrics_sidecar {
                let result = cancellable(
                    &cancel,
                    api.download_lyrics_with_options(&track, &options.lyrics),
                )
                .await
                .map(|lyrics| lyrics.filter(|text| !text.trim().is_empty()));
                match optional_download_asset(result, "Lyrics were unavailable.", &mut warnings)? {
                    Some(original) => {
                        match lyrics::translate_lyrics(&original, &options.lyrics, &cancel).await {
                            Ok(translated) => Some(translated),
                            Err(error) if error == CANCELLED => return Err(error),
                            Err(error) => {
                                warnings.push(format!(
                                    "Lyrics translation: {error} Original lyrics were preserved."
                                ));
                                Some(original)
                            }
                        }
                    }
                    None => None,
                }
            } else {
                None
            };
            let mut metadata = TrackMetadata::from(&track);
            metadata.collection = job.collection_title.clone();
            metadata.collection_owner = job.collection_owner.clone();
            let mut export_options = options.clone();
            if job.collection_kind == "track" && !options.apply_folder_to_single_track {
                export_options.folder_template.clear();
            }
            if matches!(job.collection_kind.as_str(), "playlist" | "collection")
                && options.create_playlist_folder
            {
                let prefix =
                    if options.playlist_owner_folder && !metadata.collection_owner.is_empty() {
                        "{creator}/{playlist}"
                    } else {
                        "{playlist}"
                    };
                export_options.folder_template = if export_options.folder_template.is_empty() {
                    prefix.into()
                } else {
                    format!("{prefix}/{}", export_options.folder_template)
                };
            }
            if options.separate_album_filename
                && matches!(job.collection_kind.as_str(), "album" | "artist")
            {
                export_options.filename_template = options.album_filename_template.clone();
            }
            export_file(
                ExportInput {
                    metadata,
                    response: audio.response,
                    cover,
                    lyrics,
                    source: Some(audio.source),
                    extension: audio.extension,
                    warnings,
                },
                export_options,
                cancel.clone(),
                progress.clone(),
            )
            .await
        }
        .await;
        match result {
            Ok(file) => receipt.file = Some(file),
            Err(error) => {
                receipt.cancelled = error == CANCELLED;
                receipt.file_error = Some(error);
            }
        }
    }
    if options.destination.library() && receipt.library_song_id.is_none() {
        receipt.library_error = None;
        if cancel.is_cancelled() {
            receipt.cancelled = true;
            receipt.library_error = Some(CANCELLED.into());
        } else {
            progress(TransferProgress {
                stage: JobStage::SavingLibrary,
                ..Default::default()
            });
            // Once the server accepts a save, cancellation cannot reliably undo
            // it. Await the real result instead of claiming it was cancelled.
            match api
                .save_download_to_library(
                    &job.track,
                    options.source,
                    options.quality,
                    options.allow_youtube_fallback,
                    &options.providers,
                )
                .await
            {
                Ok(id) => receipt.library_song_id = Some(id),
                Err(error) => receipt.library_error = Some(error),
            }
        }
    }
    if options.export_log
        && options.destination.local()
        && (!options.log_failures_only
            || receipt.file_error.is_some()
            || receipt.library_error.is_some())
    {
        if let Err(error) = export::write_job_log(&job, &receipt) {
            if let Some(file) = receipt.file.as_mut() {
                file.warnings.push(format!("Download log: {error}"));
            }
        }
    }
    receipt
}

/// Template values are always a single filesystem component. Separators only
/// come from the user-authored folder template, never track metadata.
pub fn safe_component(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let value = value.trim().trim_matches('.').trim();
    let mut result = String::new();
    for character in value.chars() {
        if result.len() + character.len_utf8() > 180 {
            break;
        }
        result.push(character);
    }
    if result.is_empty() {
        result = "Unknown".into();
    }
    if matches!(
        result.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "LPT1"
            | "LPT2"
            | "LPT3"
    ) {
        result.insert(0, '_');
    }
    result
}
pub fn render_template(template: &str, metadata: &TrackMetadata) -> String {
    let mut rendered = template.to_owned();
    for (key, value) in [
        ("title", metadata.title.clone()),
        (
            "artist",
            metadata
                .artists
                .first()
                .cloned()
                .unwrap_or_else(|| metadata.artist.clone()),
        ),
        ("album", metadata.album.clone()),
        (
            "album_artist",
            if metadata.album_artist.is_empty() {
                metadata.artist.clone()
            } else {
                metadata.album_artist.clone()
            },
        ),
        (
            "track",
            format!("{:02}", metadata.track_number.unwrap_or(0)),
        ),
        ("disc", metadata.disc_number.unwrap_or(1).to_string()),
        ("year", metadata.year.chars().take(4).collect()),
        ("date", metadata.year.clone()),
        ("isrc", metadata.isrc.clone()),
        ("upc", metadata.upc.clone()),
        ("id", metadata.id.clone()),
        ("artists", metadata.artists.join(", ")),
        (
            "total_tracks",
            metadata.track_total.unwrap_or(0).to_string(),
        ),
        ("total_discs", metadata.disc_total.unwrap_or(0).to_string()),
        ("playlist", metadata.collection.clone()),
        ("creator", metadata.collection_owner.clone()),
        ("genre", metadata.genre.clone()),
        ("composer", metadata.composer.clone()),
        ("category", metadata.category.clone()),
    ] {
        rendered = rendered.replace(&format!("{{{key}}}"), &safe_component(&value));
    }
    safe_component(&rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_missing_assets_warn_and_cancellation_remains_fatal() {
        let mut warnings = Vec::new();
        assert_eq!(
            optional_download_asset::<String>(Ok(None), "Lyrics were unavailable.", &mut warnings),
            Ok(None)
        );
        assert_eq!(warnings, ["Lyrics were unavailable."]);
        assert_eq!(
            optional_download_asset::<Vec<u8>>(Ok(None), "Artwork was unavailable.", &mut warnings),
            Ok(None)
        );
        assert_eq!(warnings.len(), 2);
        assert_eq!(
            optional_download_asset::<String>(
                Err(CANCELLED.into()),
                "Lyrics were unavailable.",
                &mut warnings
            ),
            Err(CANCELLED.into())
        );
        assert_eq!(
            warnings.len(),
            2,
            "cancellation must not look like a missing optional asset"
        );
        assert_eq!(
            optional_download_asset(
                Ok(Some("synthetic lyric")),
                "Lyrics were unavailable.",
                &mut warnings
            ),
            Ok(Some("synthetic lyric"))
        );
        assert_eq!(
            warnings.len(),
            2,
            "available assets must not produce warnings"
        );
        assert_eq!(
            optional_download_asset::<String>(
                Err("provider failed".into()),
                "Lyrics were unavailable.",
                &mut warnings
            ),
            Ok(None)
        );
        assert_eq!(warnings.last().unwrap(), "Lyrics were unavailable.");
    }

    #[test]
    fn names_do_not_turn_catalog_metadata_into_paths() {
        let metadata = TrackMetadata {
            title: "../../my/song\n".into(),
            artist: "AC/DC".into(),
            ..Default::default()
        };
        assert_eq!(
            render_template("{artist} - {title}", &metadata),
            "AC_DC - _.._my_song_"
        );
        assert_eq!(safe_component(".."), "Unknown");
        assert!(safe_component(&"音".repeat(500)).len() <= 180);
        assert_eq!(safe_component("CON"), "_CON");
        assert_eq!(
            render_template(
                "{year} - {date} - {isrc} - {upc}",
                &TrackMetadata {
                    year: "2026-10-03".into(),
                    isrc: "USABC2600001".into(),
                    upc: "012345678901".into(),
                    ..Default::default()
                }
            ),
            "2026 - 2026-10-03 - USABC2600001 - 012345678901"
        );
    }

    #[test]
    fn restored_jobs_require_retry_and_preserve_account_and_completed_results() {
        let directory =
            std::env::temp_dir().join(format!("spotify-download-state-{}", rand::random::<u64>()));
        let mut queue = QueueState::for_account("first/account");
        queue.options.bitrate_kbps = 256;
        let track = DownloadTrack {
            id: "one".into(),
            title: "One".into(),
            ..Default::default()
        };
        let id = queue.enqueue(track.clone(), queue.options.clone()).unwrap();
        assert!(queue.enqueue(track, queue.options.clone()).is_none());
        queue.update(
            id,
            TransferProgress {
                stage: JobStage::Downloading,
                received: 12,
                total: Some(100),
            },
        );
        let done = queue
            .enqueue(
                DownloadTrack {
                    id: "two".into(),
                    ..Default::default()
                },
                queue.options.clone(),
            )
            .unwrap();
        queue.finish(
            done,
            JobReceipt {
                library_song_id: Some("saved-song".into()),
                ..Default::default()
            },
        );
        queue.save(&directory).unwrap();
        let mut restored = QueueState::load(&directory, "first/account").unwrap();
        assert_eq!(restored.jobs[0].stage, JobStage::Interrupted);
        assert_eq!(restored.jobs[1].stage, JobStage::Completed);
        assert_eq!(restored.options.bitrate_kbps, 256);
        assert!(restored.retry(id));
        assert_eq!(restored.jobs[0].stage, JobStage::Queued);
        assert!(
            QueueState::load(&directory, "other-account")
                .unwrap()
                .jobs
                .is_empty()
        );
        let unrelated = QueueState::path(&directory, "other-account");
        std::fs::copy(QueueState::path(&directory, "first/account"), unrelated).unwrap();
        assert!(QueueState::load(&directory, "other-account").is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn partial_success_stays_visible_and_retryable() {
        let receipt = JobReceipt {
            library_song_id: Some("saved".into()),
            file_error: Some("Disk is full".into()),
            ..Default::default()
        };
        assert!(receipt.succeeded());
        assert!(receipt.stage().retryable());
        let mut queue = QueueState::for_account("listener");
        let id = queue
            .enqueue(
                DownloadTrack {
                    id: "track".into(),
                    ..Default::default()
                },
                ExportOptions::default(),
            )
            .unwrap();
        queue.finish(id, receipt);
        assert!(queue.retry(id));
        assert_eq!(
            queue.jobs[0]
                .receipt
                .as_ref()
                .unwrap()
                .library_song_id
                .as_deref(),
            Some("saved")
        );
    }

    #[test]
    fn stale_background_save_cannot_replace_a_newer_flush() {
        let directory =
            std::env::temp_dir().join(format!("spotify-download-order-{}", rand::random::<u64>()));
        let mut old = QueueState::for_account("listener");
        old.revision = 3;
        old.options.bitrate_kbps = 128;
        let mut latest = old.clone();
        latest.revision = 4;
        latest.options.bitrate_kbps = 256;
        latest.save(&directory).unwrap();
        old.save(&directory).unwrap();
        let loaded = QueueState::load(&directory, "listener").unwrap();
        assert_eq!(loaded.revision, 4);
        assert_eq!(loaded.options.bitrate_kbps, 256);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
