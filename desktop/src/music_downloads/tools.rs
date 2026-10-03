//! Local audio utilities. Inspection never changes files; every user-selected
//! file edit writes a new output, while download finalization may tag only the
//! newly-created files explicitly handed to it by the queue.
mod analysis;
mod lyrics;
mod metadata;
mod processing;
mod spectrum_image;

use super::{AudioQuality, CANCELLED, Cancellation, OutputFormat};
use crate::music_api::MusicApi;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug)]
pub enum ToolsRequest {
    Inspect {
        paths: Vec<PathBuf>,
    },
    Rename {
        paths: Vec<PathBuf>,
        output_dir: PathBuf,
        template: String,
    },
    Convert {
        paths: Vec<PathBuf>,
        output_dir: PathBuf,
        format: OutputFormat,
        bitrate_kbps: u32,
        sample_rate: Option<u32>,
        bit_depth: Option<u32>,
    },
    ReplayGain {
        paths: Vec<PathBuf>,
        output_dir: PathBuf,
        album: bool,
    },
    Edit {
        path: PathBuf,
        output_dir: PathBuf,
        tags: BTreeMap<String, String>,
        lyrics: Option<String>,
    },
    Enrich {
        paths: Vec<PathBuf>,
        output_dir: PathBuf,
        source: Option<String>,
        overwrite: bool,
        lyrics_options: super::LyricsOptions,
    },
    InspectLyrics {
        paths: Vec<PathBuf>,
    },
    SaveLyrics {
        path: PathBuf,
        output_dir: PathBuf,
        text: String,
        plain_text: bool,
    },
    TranslateLyrics {
        path: PathBuf,
        output_dir: PathBuf,
        text: String,
        options: super::LyricsOptions,
    },
    AnalyzeSpectrum {
        paths: Vec<PathBuf>,
        tempo_key: bool,
        fft_size: usize,
        window: SpectrumWindow,
        palette: SpectrumPalette,
        frequency_scale: FrequencyScale,
        export_dir: Option<PathBuf>,
    },
    Analyze {
        paths: Vec<PathBuf>,
        tempo_key: bool,
        spectrum: bool,
    },
    ExtractLyrics {
        paths: Vec<PathBuf>,
        output_dir: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpectrumWindow {
    #[default]
    Hann,
    Hamming,
    Blackman,
    Rectangular,
}
impl SpectrumWindow {
    pub const ALL: [Self; 4] = [Self::Hann, Self::Hamming, Self::Blackman, Self::Rectangular];
    pub fn label(self) -> &'static str {
        match self {
            Self::Hann => "Hann",
            Self::Hamming => "Hamming",
            Self::Blackman => "Blackman",
            Self::Rectangular => "Rectangular",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpectrumPalette {
    Spek,
    #[default]
    Viridis,
    Hot,
    Cool,
    Grayscale,
}
impl SpectrumPalette {
    pub const ALL: [Self; 5] = [
        Self::Spek,
        Self::Viridis,
        Self::Hot,
        Self::Cool,
        Self::Grayscale,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Self::Spek => "Spek",
            Self::Viridis => "Viridis",
            Self::Hot => "Hot",
            Self::Cool => "Cool",
            Self::Grayscale => "Grayscale",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FrequencyScale {
    #[default]
    Linear,
    Logarithmic,
}
impl FrequencyScale {
    pub const ALL: [Self; 2] = [Self::Linear, Self::Logarithmic];
    pub fn label(self) -> &'static str {
        match self {
            Self::Linear => "Linear",
            Self::Logarithmic => "Logarithmic",
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Spectrogram {
    pub times_seconds: Vec<f32>,
    pub frequencies_hz: Vec<f32>,
    /// Rows are time windows; columns are logarithmically spaced bands.
    pub levels_db: Vec<Vec<f32>>,
}
pub use spectrum_image::{spectrogram_color, spectrogram_rgb};

#[derive(Clone, Debug)]
pub struct LyricsDocument {
    pub path: PathBuf,
    pub text: String,
    pub synced: bool,
}

#[derive(Clone, Debug)]
pub struct AudioDocument {
    pub path: PathBuf,
    pub bytes: u64,
    pub duration_ms: u64,
    pub quality: AudioQuality,
    /// Keys are normalized to lowercase so editing FLAC and ID3 tags has the
    /// same behavior. Values are preserved, including multiline lyrics.
    pub tags: BTreeMap<String, String>,
    pub lyrics: Option<String>,
    pub has_artwork: bool,
}
#[derive(Clone, Debug)]
pub struct SpectrumPoint {
    pub frequency_hz: f32,
    pub level_db: f32,
}
#[derive(Clone, Debug)]
pub struct TempoEstimate {
    pub bpm: f32,
    pub confidence: f32,
}
#[derive(Clone, Debug)]
pub struct KeyEstimate {
    pub key: String,
    pub confidence: f32,
}
#[derive(Clone, Debug, Default)]
pub struct AudioAnalysis {
    pub analyzed_seconds: f64,
    pub analysis_sample_rate: u32,
    pub peak_dbfs: f32,
    pub rms_dbfs: f32,
    pub crest_db: f32,
    pub clipping_samples: u64,
    pub spectrum: Vec<SpectrumPoint>,
    pub spectrogram: Option<Spectrogram>,
    pub waveform: Vec<f32>,
    pub bpm: Option<TempoEstimate>,
    pub key: Option<KeyEstimate>,
    pub high_frequency_rolloff_hz: Option<f32>,
    pub notes: Vec<String>,
}
#[derive(Clone, Debug, Default)]
pub struct ReplayGainReport {
    pub track_gain_db: f64,
    pub track_peak: f64,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
    pub integrated_lufs: f64,
    pub true_peak_dbfs: f64,
}
#[derive(Clone, Debug, Default)]
pub struct ToolsFileResult {
    pub input: PathBuf,
    pub output: Option<PathBuf>,
    pub document: Option<AudioDocument>,
    pub lyric_document: Option<LyricsDocument>,
    pub analysis: Option<AudioAnalysis>,
    pub replay_gain: Option<ReplayGainReport>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Default)]
pub struct ToolsResult {
    pub files: Vec<ToolsFileResult>,
    pub cancelled: bool,
}
#[derive(Clone, Debug)]
pub struct ToolsProgress {
    pub completed: usize,
    pub total: usize,
    pub path: Option<PathBuf>,
    pub stage: String,
}
pub type ToolsProgressCallback = Arc<dyn Fn(ToolsProgress) + Send + Sync>;

pub async fn execute(
    request: ToolsRequest,
    api: Option<MusicApi>,
    cancel: Cancellation,
    progress: ToolsProgressCallback,
) -> ToolsResult {
    if let ToolsRequest::Enrich {
        paths,
        output_dir,
        source,
        overwrite,
        lyrics_options,
    } = request
    {
        return metadata::enrich(
            paths,
            output_dir,
            source,
            overwrite,
            lyrics_options,
            api,
            cancel,
            progress,
        )
        .await;
    }
    if let ToolsRequest::TranslateLyrics {
        path,
        output_dir,
        text,
        options,
    } = request
    {
        return lyrics::translate(path, output_dir, text, options, cancel, progress).await;
    }
    tokio::task::spawn_blocking(move || execute_local(request, cancel, progress))
        .await
        .unwrap_or_else(|_| ToolsResult {
            files: vec![ToolsFileResult {
                error: Some(
                    "The audio task stopped unexpectedly. The original files were preserved."
                        .into(),
                ),
                ..Default::default()
            }],
            cancelled: false,
        })
}

fn execute_local(
    request: ToolsRequest,
    cancel: Cancellation,
    progress: ToolsProgressCallback,
) -> ToolsResult {
    if matches!(
        &request,
        ToolsRequest::InspectLyrics { .. } | ToolsRequest::SaveLyrics { .. }
    ) {
        return lyrics::execute(request, &cancel, &progress);
    }
    let requested = match &request {
        ToolsRequest::Rename { paths, .. }
        | ToolsRequest::Inspect { paths }
        | ToolsRequest::Convert { paths, .. }
        | ToolsRequest::ReplayGain { paths, .. }
        | ToolsRequest::Enrich { paths, .. }
        | ToolsRequest::AnalyzeSpectrum { paths, .. }
        | ToolsRequest::InspectLyrics { paths }
        | ToolsRequest::Analyze { paths, .. }
        | ToolsRequest::ExtractLyrics { paths, .. } => paths.clone(),
        ToolsRequest::Edit { path, .. }
        | ToolsRequest::SaveLyrics { path, .. }
        | ToolsRequest::TranslateLyrics { path, .. } => vec![path.clone()],
    };
    let paths = match expand_paths(&requested, &cancel) {
        Ok(paths) => paths,
        Err(error) => return failed_result(requested.first().cloned().unwrap_or_default(), error),
    };
    if matches!(
        &request,
        ToolsRequest::Analyze { .. } | ToolsRequest::AnalyzeSpectrum { .. }
    ) && paths.len() > 128
    {
        return failed_result(
            PathBuf::new(),
            "Analyze no more than 128 files per batch to keep spectrogram memory bounded.".into(),
        );
    }
    if paths.is_empty() {
        return failed_result(
            PathBuf::new(),
            "No supported audio files were found.".into(),
        );
    }
    if let ToolsRequest::ReplayGain {
        output_dir, album, ..
    } = &request
    {
        return processing::batch_gain(&paths, output_dir, *album, &cancel, &progress);
    }
    let mut result = ToolsResult::default();
    for (index, path) in paths.iter().enumerate() {
        if cancel.is_cancelled() {
            result.cancelled = true;
            break;
        }
        progress(ToolsProgress {
            completed: index,
            total: paths.len(),
            path: Some(path.clone()),
            stage: request_label(&request).into(),
        });
        let operation = || -> Result<ToolsFileResult, String> {
            let document = inspect(path, &cancel)?;
            let mut item = ToolsFileResult {
                input: path.clone(),
                ..Default::default()
            };
            match &request {
                ToolsRequest::Inspect { .. } => item.document = Some(document),
                ToolsRequest::Rename {
                    output_dir,
                    template,
                    ..
                } => {
                    let output = processing::rename(&document, output_dir, template, &cancel)?;
                    item.document = Some(inspect(&output, &cancel)?);
                    item.output = Some(output);
                }
                ToolsRequest::Analyze {
                    tempo_key,
                    spectrum,
                    ..
                } => {
                    item.analysis = Some(analysis::analyze(
                        &document, *tempo_key, *spectrum, &cancel,
                    )?);
                    item.document = Some(document);
                }
                ToolsRequest::AnalyzeSpectrum {
                    tempo_key,
                    fft_size,
                    window,
                    palette,
                    frequency_scale,
                    export_dir,
                    ..
                } => {
                    let measured = analysis::analyze_with_options(
                        &document, *tempo_key, true, *fft_size, *window, &cancel,
                    )?;
                    if let Some(directory) = export_dir {
                        item.output = Some(analysis::export_png(
                            &document,
                            &measured,
                            *fft_size,
                            *window,
                            *palette,
                            *frequency_scale,
                            directory,
                            &cancel,
                        )?);
                    }
                    item.analysis = Some(measured);
                    item.document = Some(document);
                }
                ToolsRequest::Convert {
                    output_dir,
                    format,
                    bitrate_kbps,
                    sample_rate,
                    bit_depth,
                    ..
                } => {
                    let output = processing::convert(
                        &document,
                        output_dir,
                        *format,
                        *bitrate_kbps,
                        *sample_rate,
                        *bit_depth,
                        &cancel,
                    )?;
                    let updated = inspect(&output, &cancel)?;
                    if updated.quality.lossless && !document.quality.lossless {
                        item.warnings.push("This lossless output was converted from a lossy source; conversion cannot restore missing audio detail.".into());
                    }
                    item.output = Some(output);
                    item.document = Some(updated);
                }
                ToolsRequest::Edit {
                    output_dir,
                    tags,
                    lyrics,
                    ..
                } => {
                    let output = metadata::edited_copy(
                        &document,
                        output_dir,
                        tags,
                        lyrics.as_deref(),
                        "edited",
                        &cancel,
                    )?;
                    item.document = Some(inspect(&output, &cancel)?);
                    item.output = Some(output);
                }
                ToolsRequest::ExtractLyrics { output_dir, .. } => {
                    let lyrics = document
                        .lyrics
                        .as_ref()
                        .ok_or("No embedded lyrics were found in this file.")?;
                    let synced = lyrics.lines().any(|line| {
                        line.starts_with('[')
                            && line.get(1..3).is_some_and(|value| {
                                value.bytes().all(|byte| byte.is_ascii_digit())
                            })
                    });
                    let name = format!(
                        "{}.{}",
                        super::safe_component(
                            &path.file_stem().unwrap_or_default().to_string_lossy()
                        ),
                        if synced { "lrc" } else { "txt" }
                    );
                    item.output = Some(write_new_file(
                        output_dir,
                        &name,
                        lyrics.as_bytes(),
                        &cancel,
                    )?);
                    item.document = Some(document);
                }
                ToolsRequest::ReplayGain { .. }
                | ToolsRequest::Enrich { .. }
                | ToolsRequest::InspectLyrics { .. }
                | ToolsRequest::SaveLyrics { .. }
                | ToolsRequest::TranslateLyrics { .. } => unreachable!(),
            }
            Ok(item)
        };
        match operation() {
            Ok(item) => result.files.push(item),
            Err(error) => {
                let cancelled = error == CANCELLED;
                result.files.push(ToolsFileResult {
                    input: path.clone(),
                    error: Some(error),
                    ..Default::default()
                });
                if cancelled {
                    result.cancelled = true;
                    break;
                }
            }
        }
        progress(ToolsProgress {
            completed: index + 1,
            total: paths.len(),
            path: Some(path.clone()),
            stage: "Finished".into(),
        });
    }
    result
}

fn request_label(request: &ToolsRequest) -> &'static str {
    match request {
        ToolsRequest::Rename { .. } => "Saving renamed copies",
        ToolsRequest::Inspect { .. } => "Reading audio",
        ToolsRequest::Convert { .. } => "Converting audio",
        ToolsRequest::ReplayGain { .. } => "Measuring loudness",
        ToolsRequest::Edit { .. } => "Saving edited copy",
        ToolsRequest::Enrich { .. } => "Matching metadata",
        ToolsRequest::Analyze { .. } | ToolsRequest::AnalyzeSpectrum { .. } => "Analyzing audio",
        ToolsRequest::InspectLyrics { .. } => "Reading lyrics",
        ToolsRequest::SaveLyrics { .. } => "Saving lyrics copy",
        ToolsRequest::TranslateLyrics { .. } => "Translating lyrics",
        ToolsRequest::ExtractLyrics { .. } => "Extracting lyrics",
    }
}
fn failed_result(input: PathBuf, error: String) -> ToolsResult {
    ToolsResult {
        cancelled: error == CANCELLED,
        files: vec![ToolsFileResult {
            input,
            error: Some(error),
            ..Default::default()
        }],
    }
}

pub fn inspect(path: &Path, cancel: &Cancellation) -> Result<AudioDocument, String> {
    cancel.check()?;
    let path = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not open this file: {error}"))?;
    let info = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !info.is_file() || info.len() == 0 {
        return Err("Choose a nonempty audio file.".into());
    }
    let scratch = Scratch::new()?;
    let args = vec!["-v".into(), "error".into(), "-show_entries".into(), "format=duration:format_tags:stream=codec_type,duration:stream_tags:stream_disposition=attached_pic".into(), "-of".into(), "json".into(), path.as_os_str().to_owned()];
    let (json, _) = super::export::command_output("ffprobe", &args, &scratch.0, cancel)?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|_| "Audio metadata could not be decoded.")?;
    let mut tags = BTreeMap::new();
    let mut duration = value
        .pointer("/format/duration")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let mut has_artwork = false;
    if let Some(streams) = value.get("streams").and_then(|value| value.as_array()) {
        for stream in streams {
            has_artwork |= stream
                .pointer("/disposition/attached_pic")
                .and_then(|value| value.as_u64())
                == Some(1);
            if stream.get("codec_type").and_then(|value| value.as_str()) == Some("audio") {
                if duration <= 0.0 {
                    duration = stream
                        .get("duration")
                        .and_then(|value| value.as_str())
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0.0);
                }
                collect_tags(stream.get("tags"), &mut tags);
            }
        }
    }
    collect_tags(value.pointer("/format/tags"), &mut tags);
    // Lofty reads rich MP4/ID3/Vorbis fields that ffprobe may omit. Fold
    // aliases before exposing the editor so an old TRACKNUMBER cannot win
    // over an edited canonical track value.
    tags = tags
        .into_iter()
        .map(|(key, value)| (metadata::canonical_name(&key).to_owned(), value))
        .collect();
    if let Ok((rich_tags, artwork)) = metadata::read_tags(&path) {
        tags.extend(rich_tags);
        has_artwork |= artwork;
    }
    let lyrics = tags
        .iter()
        .find(|(key, _)| {
            key.starts_with("lyrics")
                || matches!(
                    key.as_str(),
                    "unsyncedlyrics" | "unsynced lyrics" | "unsynchronisedlyrics"
                )
        })
        .map(|(_, value)| value.clone());
    let quality = super::export::probe(&path, &scratch.0, cancel)?;
    Ok(AudioDocument {
        path,
        bytes: info.len(),
        duration_ms: (duration.max(0.0) * 1000.0) as u64,
        quality,
        tags,
        lyrics,
        has_artwork,
    })
}
fn collect_tags(value: Option<&serde_json::Value>, tags: &mut BTreeMap<String, String>) {
    if let Some(values) = value.and_then(|value| value.as_object()) {
        for (key, value) in values {
            if let Some(value) = value.as_str() {
                tags.insert(key.to_ascii_lowercase(), value.to_owned());
            }
        }
    }
}

fn expand_paths(requested: &[PathBuf], cancel: &Cancellation) -> Result<Vec<PathBuf>, String> {
    expand_matching(requested, cancel, audio_extension)
}
fn expand_matching(
    requested: &[PathBuf],
    cancel: &Cancellation,
    accepts: fn(&Path) -> bool,
) -> Result<Vec<PathBuf>, String> {
    let mut pending = requested.to_vec();
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut visited = 0;
    while let Some(path) = pending.pop() {
        cancel.check()?;
        visited += 1;
        if visited > 50_000 {
            return Err("Select a smaller folder containing fewer than 50,000 entries.".into());
        }
        let info = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if info.file_type().is_symlink() {
            continue;
        }
        if info.is_dir() {
            for entry in std::fs::read_dir(&path).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if !entry.file_name().to_string_lossy().starts_with('.') {
                    pending.push(entry.path());
                }
            }
        } else if info.is_file() && accepts(&path) {
            let canonical = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
            if seen.insert(canonical.clone()) {
                files.push(canonical);
            }
            if files.len() > 10_000 {
                return Err("Select no more than 10,000 audio files at a time.".into());
            }
        }
    }
    files.sort();
    Ok(files)
}
fn audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "flac"
                    | "mp3"
                    | "m4a"
                    | "mp4"
                    | "aac"
                    | "alac"
                    | "wav"
                    | "aif"
                    | "aiff"
                    | "opus"
                    | "ogg"
                    | "oga"
                    | "wma"
                    | "ape"
                    | "wv"
            )
        })
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "spotify-audio-tools-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write_new_file(
    directory: &Path,
    name: &str,
    bytes: &[u8],
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    cancel.check()?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut temporary = super::export::TemporaryFiles::new();
    let source = temporary.add(directory, "tools-part");
    std::fs::write(&source, bytes).map_err(|error| error.to_string())?;
    cancel.check()?;
    super::export::publish(
        &source,
        &directory.join(name),
        super::DuplicatePolicy::Rename,
    )
    .map(|(path, _)| path)
}

pub fn apply_album_replay_gain(paths: &[PathBuf], cancel: &Cancellation) -> Result<(), String> {
    processing::apply_album_gain(paths, cancel)
}

pub fn read_isrc(path: &Path) -> Result<Option<String>, String> {
    metadata::read_isrc(path)
}
pub fn write_metadata(
    path: &Path,
    metadata: &super::TrackMetadata,
    options: &super::ExportOptions,
    lyrics: Option<&str>,
    cover: Option<&[u8]>,
    cancel: &Cancellation,
) -> Result<(), String> {
    metadata::write_metadata(path, metadata, options, lyrics, cover, cancel)
}
pub fn write_replay_gain(
    path: &Path,
    report: &ReplayGainReport,
    cancel: &Cancellation,
) -> Result<(), String> {
    metadata::write_gain(path, report, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_downloads::{ExportOptions, TrackMetadata};
    fn available() -> bool {
        super::super::tool_available("ffmpeg") && super::super::tool_available("ffprobe")
    }
    fn tone(directory: &Path, name: &str, volume: f64) -> PathBuf {
        let path = directory.join(name);
        let args = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:sample_rate=44100:duration=2".into(),
            "-af".into(),
            format!("volume={volume}").into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            path.as_os_str().to_owned(),
        ];
        super::super::export::command_output("ffmpeg", &args, directory, &Cancellation::default())
            .unwrap();
        path
    }
    fn audio_hash(path: &Path, directory: &Path) -> String {
        let args = vec![
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-i".into(),
            path.as_os_str().to_owned(),
            "-map".into(),
            "0:a:0".into(),
            "-c:a".into(),
            "copy".into(),
            "-f".into(),
            "md5".into(),
            "-".into(),
        ];
        super::super::export::command_output("ffmpeg", &args, directory, &Cancellation::default())
            .unwrap()
            .0
    }
    fn metadata() -> TrackMetadata {
        TrackMetadata {
            title: "Test title".into(),
            artist: "Test artist".into(),
            album: "Test album".into(),
            album_artist: "Album artist".into(),
            year: "2025-08-02".into(),
            track_number: Some(2),
            track_total: Some(9),
            disc_number: Some(1),
            disc_total: Some(2),
            genre: "Electronic".into(),
            composer: "Test composer".into(),
            copyright: "Test copyright".into(),
            label: "Test label".into(),
            isrc: "GBTEST2500001".into(),
            upc: "123456789012".into(),
            source_url: "https://music.example/track/1".into(),
            ..Default::default()
        }
    }
    #[test]
    fn real_formats_preserve_rich_tags_lyrics_and_gain_without_audio_changes() {
        if !available() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let signal = Cancellation::default();
        let source = tone(&scratch.0, "original.wav", 1.0);
        let document = inspect(&source, &signal).unwrap();
        let picture = scratch.0.join("cover.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([30, 180, 90, 255]))
            .save(&picture)
            .unwrap();
        let cover = std::fs::read(picture).unwrap();
        for format in [
            OutputFormat::Flac,
            OutputFormat::Alac,
            OutputFormat::Mp3,
            OutputFormat::Opus,
            OutputFormat::Wav,
            OutputFormat::Aac,
            OutputFormat::Aiff,
        ] {
            let output = processing::convert(
                &document,
                &scratch.0,
                format,
                192,
                Some(48000),
                Some(24),
                &signal,
            )
            .unwrap();
            let before = audio_hash(&output, &scratch.0);
            write_metadata(
                &output,
                &metadata(),
                &ExportOptions::default(),
                Some("[00:00.00] Test lyrics"),
                Some(&cover),
                &signal,
            )
            .unwrap_or_else(|error| panic!("{format:?}: {error}"));
            write_replay_gain(
                &output,
                &ReplayGainReport {
                    track_gain_db: -3.25,
                    track_peak: 0.85,
                    album_gain_db: Some(-2.5),
                    album_peak: Some(0.90),
                    ..Default::default()
                },
                &signal,
            )
            .unwrap();
            let result = inspect(&output, &signal).unwrap();
            for (key, value) in [
                ("title", "Test title"),
                ("artist", "Test artist"),
                ("album", "Test album"),
                ("album_artist", "Album artist"),
                ("genre", "Electronic"),
                ("composer", "Test composer"),
                ("copyright", "Test copyright"),
                ("publisher", "Test label"),
                ("isrc", "GBTEST2500001"),
                ("upc", "123456789012"),
            ] {
                assert_eq!(
                    result.tags.get(key).map(String::as_str),
                    Some(value),
                    "{format:?}: {key}"
                );
            }
            assert_eq!(
                result.lyrics.as_deref(),
                Some("[00:00.00] Test lyrics"),
                "{format:?}"
            );
            assert!(result.has_artwork, "{format:?}");
            assert_eq!(
                result.tags.get("replaygain_track_gain").map(String::as_str),
                Some("-3.25 dB"),
                "{format:?}"
            );
            assert_eq!(
                read_isrc(&output).unwrap().as_deref(),
                Some("GBTEST2500001")
            );
            assert_eq!(
                before,
                audio_hash(&output, &scratch.0),
                "Tagging changed encoded audio in {format:?}"
            );
        }
        assert_eq!(document.tags, inspect(&source, &signal).unwrap().tags);
    }
    #[test]
    fn enriched_copies_add_cover_and_preserve_it_when_fetch_has_no_result() {
        if !available() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let signal = Cancellation::default();
        let source = tone(&scratch.0, "source.wav", 1.0);
        let original = std::fs::read(&source).unwrap();
        let document = inspect(&source, &signal).unwrap();
        assert!(!document.has_artwork);
        let picture = scratch.0.join("cover.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([30, 180, 90, 255]))
            .save(&picture)
            .unwrap();
        let cover = std::fs::read(picture).unwrap();
        let enriched = metadata::edited_copy_with_cover(
            &document,
            &scratch.0,
            &BTreeMap::new(),
            Some("Existing lyrics"),
            Some(&cover),
            "enriched",
            &signal,
        )
        .unwrap();
        let enriched_document = inspect(&enriched, &signal).unwrap();
        assert!(enriched_document.has_artwork);
        let preserved = metadata::edited_copy_with_cover(
            &enriched_document,
            &scratch.0,
            &BTreeMap::new(),
            None,
            None,
            "enriched",
            &signal,
        )
        .unwrap();
        let preserved_document = inspect(&preserved, &signal).unwrap();
        assert!(preserved_document.has_artwork);
        assert_eq!(
            preserved_document.lyrics.as_deref(),
            Some("Existing lyrics")
        );
        assert_eq!(
            audio_hash(&source, &scratch.0),
            audio_hash(&preserved, &scratch.0)
        );
        assert_eq!(std::fs::read(source).unwrap(), original);
    }

    #[test]
    fn edits_create_copies_and_disabled_export_fields_are_removed() {
        if !available() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let signal = Cancellation::default();
        let source = tone(&scratch.0, "source.wav", 1.0);
        let original = std::fs::read(&source).unwrap();
        let document = inspect(&source, &signal).unwrap();
        let values = BTreeMap::from([
            ("title".into(), "Edited title".into()),
            ("isrc".into(), "TESTISRC".into()),
        ]);
        let output = metadata::edited_copy(
            &document,
            &scratch.0,
            &values,
            Some("Some lyrics"),
            "edited",
            &signal,
        )
        .unwrap();
        assert_ne!(output, source);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(
            inspect(&output, &signal)
                .unwrap()
                .tags
                .get("title")
                .unwrap(),
            "Edited title"
        );
        let mut options = ExportOptions::default();
        options.metadata_tags.title = false;
        options.metadata_tags.isrc = false;
        options.embed_lyrics = false;
        write_metadata(&output, &metadata(), &options, None, None, &signal).unwrap();
        let result = inspect(&output, &signal).unwrap();
        assert!(!result.tags.contains_key("title"));
        assert!(read_isrc(&output).unwrap().is_none());
        assert!(result.lyrics.is_none());
        let renamed = processing::rename(&document, &scratch.0, "../{title}", &signal).unwrap();
        assert_eq!(renamed.parent(), Some(scratch.0.as_path()));
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }
    #[test]
    fn album_gain_uses_shared_album_tags_and_preserves_encoded_audio() {
        if !available() {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let signal = Cancellation::default();
        let a = tone(&scratch.0, "a.wav", 1.0);
        let b = tone(&scratch.0, "b.wav", 0.25);
        let hashes = [audio_hash(&a, &scratch.0), audio_hash(&b, &scratch.0)];
        apply_album_replay_gain(&[a.clone(), b.clone()], &signal).unwrap();
        let a_doc = inspect(&a, &signal).unwrap();
        let b_doc = inspect(&b, &signal).unwrap();
        assert_ne!(
            a_doc.tags.get("replaygain_track_gain"),
            b_doc.tags.get("replaygain_track_gain")
        );
        assert_eq!(
            a_doc.tags.get("replaygain_album_gain"),
            b_doc.tags.get("replaygain_album_gain")
        );
        assert!(a_doc.tags.contains_key("replaygain_album_gain"));
        let peak: f64 = a_doc
            .tags
            .get("replaygain_track_peak")
            .unwrap()
            .parse()
            .unwrap();
        assert!((peak - 0.125).abs() < 0.002, "{peak}");
        assert_eq!(
            hashes,
            [audio_hash(&a, &scratch.0), audio_hash(&b, &scratch.0)]
        );
        let cancelled = Cancellation::default();
        cancelled.cancel();
        let before = std::fs::read(&a).unwrap();
        assert_eq!(
            apply_album_replay_gain(&[a.clone()], &cancelled),
            Err(CANCELLED.into())
        );
        assert_eq!(before, std::fs::read(a).unwrap());
    }
    #[test]
    fn scans_deduplicate_and_ignore_symlinks() {
        let scratch = Scratch::new().unwrap();
        let file = scratch.0.join("a.flac");
        std::fs::write(&file, b"test").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, scratch.0.join("linked.flac")).unwrap();
        let files =
            expand_paths(&[scratch.0.clone(), file.clone()], &Cancellation::default()).unwrap();
        assert_eq!(files, vec![std::fs::canonicalize(file).unwrap()]);
    }
}
