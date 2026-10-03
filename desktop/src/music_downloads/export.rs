use super::*;
use std::{
    ffi::OsString,
    fs::File,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;

const MAX_AUDIO_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(super) fn tool_path(name: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(Path::parent) {
            let bundled = contents.join("Resources/bin").join(name);
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let path = Path::new(directory).join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|path| path.join(name))
        .find(|path| path.is_file())
}
pub fn tool_available(name: &str) -> bool {
    matches!(name, "ffmpeg" | "ffprobe") && tool_path(name).is_some()
}

/// Only paths created by this job are removed. The guard also runs if its
/// asynchronous task is aborted; blocking post-processing owns it until its
/// cancellation token has killed and reaped the child process.
pub(super) struct TemporaryFiles(pub(super) Vec<PathBuf>);
impl TemporaryFiles {
    pub(super) fn new() -> Self {
        Self(Vec::new())
    }
    pub(super) fn add(&mut self, directory: &Path, suffix: &str) -> PathBuf {
        let path = directory.join(format!(".spotify-{:016x}.{suffix}", rand::random::<u64>()));
        self.0.push(path.clone());
        path
    }
}
impl Drop for TemporaryFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn command_output(
    program: &str,
    args: &[OsString],
    directory: &Path,
    cancel: &Cancellation,
) -> Result<(String, String), String> {
    cancel.check()?;
    let executable = tool_path(program).ok_or_else(|| format!("{program} is required for audio exports. Install it with Homebrew or select library-only downloads."))?;
    let mut temporary = TemporaryFiles(Vec::new());
    let stdout_path = temporary.add(directory, "stdout");
    let stderr_path = temporary.add(directory, "stderr");
    let stdout = File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|e| e.to_string())?;
    let child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("Could not start {program}: {e}"))?;
    let mut child = ChildGuard(child);
    let started = Instant::now();
    let status = loop {
        cancel.check()?;
        if started.elapsed() > Duration::from_secs(20 * 60) {
            return Err("Audio processing took too long. Try a smaller batch.".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(80));
    };
    let read = |path: &Path| -> String {
        let mut data = String::new();
        if let Ok(file) = File::open(path) {
            let _ = file.take(512 * 1024).read_to_string(&mut data);
        }
        data
    };
    let out = read(&stdout_path);
    let err = read(&stderr_path);
    if !status.success() {
        return Err(format!(
            "{program} could not process this audio file. {}",
            err.lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("The file may be incomplete or unsupported.")
        ));
    }
    Ok((out, err))
}

pub(super) fn probe(
    path: &Path,
    directory: &Path,
    cancel: &Cancellation,
) -> Result<AudioQuality, String> {
    let args: Vec<OsString> = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,bit_rate:format=format_name,bit_rate", "-of", "json"].into_iter().map(Into::into).chain(std::iter::once(path.as_os_str().to_owned())).collect();
    let (output, _) = command_output("ffprobe", &args, directory, cancel)?;
    let value: serde_json::Value =
        serde_json::from_str(&output).map_err(|_| "Could not read the audio format.".to_owned())?;
    let stream = value
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|s| s.first())
        .ok_or("The downloaded file does not contain audio.")?;
    let number = |value: Option<&serde_json::Value>| {
        value
            .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
            .and_then(|v| u32::try_from(v).ok())
    };
    let codec = stream
        .get("codec_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned();
    if codec.is_empty() {
        return Err("Could not identify the downloaded audio.".into());
    }
    let lossless = codec == "flac"
        || codec == "alac"
        || codec.starts_with("pcm_")
        || matches!(codec.as_str(), "wavpack" | "ape");
    Ok(AudioQuality {
        codec,
        container: value
            .pointer("/format/format_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        sample_rate: number(stream.get("sample_rate")).unwrap_or(0),
        bit_depth: number(stream.get("bits_per_raw_sample"))
            .filter(|v| *v > 0)
            .or_else(|| number(stream.get("bits_per_sample")).filter(|v| *v > 0)),
        bitrate_kbps: number(stream.get("bit_rate"))
            .or_else(|| number(value.pointer("/format/bit_rate")))
            .map(|v| v / 1000),
        channels: number(stream.get("channels")).unwrap_or(0),
        lossless,
    })
}

fn source_extension(quality: &AudioQuality, provided: &str) -> Result<&'static str, String> {
    Ok(match quality.codec.as_str() {
        "flac" => "flac",
        "alac" | "aac" | "eac3" | "ac3" => "m4a",
        "mp3" => "mp3",
        "opus" => "opus",
        "vorbis" => "ogg",
        codec if codec.starts_with("pcm_") => {
            if quality.container.contains("aiff") {
                "aiff"
            } else {
                "wav"
            }
        }
        _ => match provided {
            "flac" => "flac",
            "m4a" => "m4a",
            "mp3" => "mp3",
            "opus" => "opus",
            "ogg" => "ogg",
            "wav" => "wav",
            _ => return Err(
                "This original format cannot be exported yet. Choose FLAC, ALAC, MP3, Opus or WAV."
                    .into(),
            ),
        },
    })
}
fn extension(
    format: OutputFormat,
    source: &AudioQuality,
    provided: &str,
) -> Result<&'static str, String> {
    match format {
        OutputFormat::Original => source_extension(source, provided),
        OutputFormat::Flac => Ok("flac"),
        OutputFormat::Alac => Ok("m4a"),
        OutputFormat::Mp3 => Ok("mp3"),
        OutputFormat::Opus => Ok("opus"),
        OutputFormat::Wav => Ok("wav"),
        OutputFormat::Aac => Ok("m4a"),
        OutputFormat::Aiff => Ok("aiff"),
    }
}

pub(super) fn destination_directory(
    options: &ExportOptions,
    metadata: &TrackMetadata,
) -> Result<PathBuf, String> {
    if options.output_dir.as_os_str().is_empty() {
        return Err("Choose a download folder.".into());
    }
    std::fs::create_dir_all(&options.output_dir)
        .map_err(|e| format!("Could not create the download folder: {e}"))?;
    let root = std::fs::canonicalize(&options.output_dir)
        .map_err(|e| format!("Could not open the download folder: {e}"))?;
    let mut directory = root.clone();
    for component in options
        .folder_template
        .split(['/', '\\'])
        .filter(|part| !part.trim().is_empty())
    {
        if matches!(component.trim(), "." | "..") {
            return Err("Folder templates cannot contain . or .. components.".into());
        }
        directory.push(render_template(component, metadata));
        match std::fs::symlink_metadata(&directory) {
            Ok(info) if info.file_type().is_symlink() => return Err("A folder created from this template is a symbolic link. Choose a direct destination folder.".into()),
            Ok(info) if !info.is_dir() => return Err("A file already uses one of the folder names in this template.".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&directory) {
                    Ok(()) => {},
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        // Tracks from one album can create its folder together.
                        let info = std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
                        if !info.is_dir() || info.file_type().is_symlink() { return Err("The download folder changed while it was being created.".into()); }
                    },
                    Err(error) => return Err(format!("Could not create the download folder: {error}")),
                }
            },
            Err(error) => return Err(format!("Could not open the download folder: {error}")),
        }
        let resolved = std::fs::canonicalize(&directory).map_err(|error| error.to_string())?;
        if !resolved.starts_with(&root) {
            return Err(
                "The folder template resolves outside the selected download folder.".into(),
            );
        }
    }
    Ok(directory)
}

pub async fn export_file(
    mut input: ExportInput,
    options: ExportOptions,
    cancel: Cancellation,
    progress: ProgressCallback,
) -> Result<ExportReceipt, String> {
    cancel.check()?;
    input.metadata = input.metadata.for_export(&options);
    if !input.response.status().is_success() {
        return Err(format!(
            "Audio download failed with HTTP {}.",
            input.response.status().as_u16()
        ));
    }
    let kind = input
        .response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if kind.contains("text/html") || kind.contains("application/json") {
        return Err("The provider returned an error page instead of audio.".into());
    }
    let total = input.response.content_length();
    if total.is_some_and(|total| total > MAX_AUDIO_BYTES) {
        return Err("This audio file exceeds the 2 GB export limit.".into());
    }
    let directory = destination_directory(&options, &input.metadata)?;
    let mut temporary = TemporaryFiles(Vec::new());
    let downloaded = temporary.add(&directory, "part");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&downloaded)
        .await
        .map_err(|e| format!("Could not write to the download folder: {e}"))?;
    let mut received = 0;
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    loop {
        cancel.check()?;
        let next = cancellable(&cancel, async {
            input
                .response
                .chunk()
                .await
                .map_err(|e| format!("Audio transfer failed: {}", e.without_url()))
        })
        .await?;
        let Some(chunk) = next else {
            break;
        };
        received += chunk.len() as u64;
        if received > MAX_AUDIO_BYTES {
            return Err("This audio file exceeds the 2 GB export limit.".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not save the audio file: {e}"))?;
        if last_progress.elapsed() >= Duration::from_millis(100) {
            progress(TransferProgress {
                stage: JobStage::Downloading,
                received,
                total,
            });
            last_progress = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    if received == 0 || total.is_some_and(|total| total != received) {
        return Err("The audio download was incomplete. Retry this track.".into());
    }
    cancel.check()?;
    progress(TransferProgress {
        stage: JobStage::Processing,
        received,
        total: Some(received),
    });
    // Move ownership of all temporary paths into the worker. Cancelling the
    // JoinHandle does not remove inputs from underneath a live ffmpeg process.
    tokio::task::spawn_blocking(move || {
        finish_file(input, options, downloaded, directory, temporary, cancel)
    })
    .await
    .map_err(|_| "Audio processing was interrupted.".to_owned())?
}

pub(super) fn replay_gain(
    path: &Path,
    directory: &Path,
    cancel: &Cancellation,
) -> Result<(String, String), String> {
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-i".into(),
        path.as_os_str().to_owned(),
        "-map".into(),
        "0:a:0".into(),
        "-af".into(),
        "replaygain".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let (_, log) = command_output("ffmpeg", &args, directory, cancel)?;
    let find = |key: &str| {
        log.lines().rev().find_map(|line| {
            line.split_once(key)
                .map(|(_, value)| value.trim().to_owned())
        })
    };
    Ok((
        find("track_gain =").ok_or("ReplayGain analysis did not return a gain value.")?,
        find("track_peak =").ok_or("ReplayGain analysis did not return a peak value.")?,
    ))
}

fn finish_file(
    mut input: ExportInput,
    options: ExportOptions,
    downloaded: PathBuf,
    directory: PathBuf,
    mut temporary: TemporaryFiles,
    cancel: Cancellation,
) -> Result<ExportReceipt, String> {
    cancel.check()?;
    input.metadata = input.metadata.for_export(&options);
    let source_quality = probe(&downloaded, &directory, &cancel)?;
    if options.quality == DownloadQuality::Atmos
        && source_quality.codec == "eac3"
        && (options.format != OutputFormat::Original
            || options
                .sample_rate
                .is_some_and(|rate| rate != source_quality.sample_rate)
            || options.bit_depth.is_some())
    {
        return Err("Atmos must keep Original format, sample rate and bit depth to preserve its spatial information.".into());
    }
    let ext = extension(options.format, &source_quality, &input.extension)?;
    let stem = render_template(&options.filename_template, &input.metadata);
    let desired = directory.join(format!("{stem}.{ext}"));
    let mut warnings = input.warnings;
    let duplicate_policy = if options.existing_file_check == ExistingFileCheck::Isrc {
        DuplicatePolicy::Rename
    } else {
        options.duplicates
    };
    if duplicate_policy == DuplicatePolicy::Skip && desired.is_file() {
        let quality = probe(&desired, &directory, &cancel)?;
        warnings.push("Kept the existing file. Its original provider is unknown.".into());
        return Ok(ExportReceipt {
            bytes: std::fs::metadata(&desired)
                .map_err(|e| e.to_string())?
                .len(),
            album_gain_applied: false,
            path: desired,
            source_quality: quality.clone(),
            quality,
            source: None,
            skipped: true,
            sidecars: Vec::new(),
            warnings,
        });
    }
    let processed = temporary.add(&directory, ext);
    let mut args: Vec<OsString> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-n".into(),
        "-i".into(),
        downloaded.as_os_str().to_owned(),
    ];
    // Metadata is written with the container-aware tag writer after encoding.
    // Disable implicit copies so a disabled tag cannot survive from the provider.
    args.extend([
        "-map".into(),
        "0:a:0".into(),
        "-map_metadata".into(),
        "-1".into(),
        "-map_metadata:s:a".into(),
        "-1".into(),
    ]);
    let reencode = options.format != OutputFormat::Original
        || options
            .sample_rate
            .is_some_and(|rate| rate != source_quality.sample_rate)
        || options
            .bit_depth
            .is_some_and(|bits| source_quality.bit_depth != Some(bits));
    if !reencode {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        let codec = match options.format {
            OutputFormat::Flac => "flac",
            OutputFormat::Alac => "alac",
            OutputFormat::Mp3 => "libmp3lame",
            OutputFormat::Opus => "libopus",
            OutputFormat::Aac => "aac",
            OutputFormat::Aiff => {
                if options.bit_depth.or(source_quality.bit_depth).unwrap_or(16) > 16 {
                    "pcm_s24be"
                } else {
                    "pcm_s16be"
                }
            }
            OutputFormat::Wav => {
                if options.bit_depth.or(source_quality.bit_depth).unwrap_or(16) > 16 {
                    "pcm_s24le"
                } else {
                    "pcm_s16le"
                }
            }
            OutputFormat::Original => match source_quality.codec.as_str() {
                "flac" => "flac",
                "alac" => "alac",
                "mp3" => "libmp3lame",
                "opus" => "libopus",
                "vorbis" => "libvorbis",
                "aac" => "aac",
                codec if codec.starts_with("pcm_") => {
                    if ext == "aiff" {
                        if options.bit_depth.or(source_quality.bit_depth).unwrap_or(16) > 16 {
                            "pcm_s24be"
                        } else {
                            "pcm_s16be"
                        }
                    } else if options.bit_depth.or(source_quality.bit_depth).unwrap_or(16) > 16 {
                        "pcm_s24le"
                    } else {
                        "pcm_s16le"
                    }
                }
                "eac3" | "ac3" => "eac3",
                _ => {
                    return Err(
                        "Resampling this codec is not supported. Choose an output format.".into(),
                    );
                }
            },
        };
        args.extend(["-c:a".into(), codec.into()]);
        if matches!(codec, "flac" | "alac") {
            if let Some(bits) = options.bit_depth {
                if ![16, 24].contains(&bits) {
                    return Err("Choose 16-bit or 24-bit audio.".into());
                }
                args.extend([
                    "-sample_fmt".into(),
                    if bits == 16 { "s16" } else { "s32" }.into(),
                    "-bits_per_raw_sample".into(),
                    bits.to_string().into(),
                ]);
            }
        }
        if matches!(codec, "libmp3lame" | "libopus" | "libvorbis" | "aac") {
            let bitrate = if codec == "libopus" {
                options.bitrate_kbps.clamp(
                    32,
                    if source_quality.channels <= 1 {
                        256
                    } else {
                        512
                    },
                )
            } else {
                options.bitrate_kbps.clamp(64, 320)
            };
            args.extend(["-b:a".into(), format!("{bitrate}k").into()]);
        }
        if let Some(rate) = options.sample_rate {
            if !matches!(
                rate,
                22050 | 44100 | 48000 | 88200 | 96000 | 176400 | 192000
            ) {
                return Err("Choose a supported sample rate.".into());
            }
            // Opus always decodes at 48 kHz, so do not advertise unsupported
            // higher sample rates to its encoder.
            if codec != "libopus" {
                args.extend(["-ar".into(), rate.to_string().into()]);
            }
        }
    }
    if ext == "mp3" {
        args.extend(["-id3v2_version".into(), "3".into()]);
    }
    if ext == "m4a" {
        // The mdta/use_metadata_tags mode drops attached cover art. Keep the
        // standard iTunes metadata layout so music players show the artwork.
        args.extend(["-movflags".into(), "+faststart".into()]);
        if options.format == OutputFormat::Original
            && matches!(source_quality.codec.as_str(), "eac3" | "ac3")
        {
            args.extend(["-f".into(), "mp4".into()]);
        }
    }
    args.push(processed.as_os_str().to_owned());
    command_output("ffmpeg", &args, &directory, &cancel)?;
    tools::write_metadata(
        &processed,
        &input.metadata,
        &options,
        input.lyrics.as_deref(),
        input.cover.as_deref(),
        &cancel,
    )?;
    if options.replay_gain {
        let (gain, peak) = replay_gain(&processed, &directory, &cancel)?;
        let report = tools::ReplayGainReport {
            track_gain_db: gain
                .trim_end_matches(" dB")
                .parse()
                .map_err(|_| "Invalid ReplayGain gain")?,
            track_peak: peak.parse().map_err(|_| "Invalid ReplayGain peak")?,
            ..Default::default()
        };
        tools::write_replay_gain(&processed, &report, &cancel)?;
    }
    let quality = probe(&processed, &directory, &cancel)?;
    if quality.lossless && !source_quality.lossless {
        warnings.push(format!("Converted from {}. A lossless container does not restore quality absent from the source.", source_quality.codec.to_uppercase()));
    }
    cancel.check()?;
    let (path, skipped) = publish(&processed, &desired, duplicate_policy)?;
    let quality = if skipped {
        probe(&path, &directory, &cancel)?
    } else {
        quality
    };
    let source_quality = if skipped {
        quality.clone()
    } else {
        source_quality
    };
    if skipped {
        warnings.push("Kept the existing file. Its original provider is unknown.".into());
    }
    let bytes = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let mut sidecars = Vec::new();
    if !skipped && options.keep_original && reencode {
        let original_ext = source_extension(&source_quality, &input.extension)?;
        let target = directory.join(format!("{stem} (original).{original_ext}"));
        match publish(&downloaded, &target, DuplicatePolicy::Rename) {
            Ok((path, _)) => sidecars.push(path),
            Err(error) => warnings.push(format!("Original file: {error}")),
        }
    }
    if !skipped && options.cover_sidecar {
        if let Some(cover) = &input.cover {
            let ext = if cover.starts_with(b"\x89PNG") {
                "png"
            } else if cover.starts_with(b"RIFF") {
                "webp"
            } else {
                "jpg"
            };
            let target = path.with_extension(ext);
            match write_sidecar(&target, cover, &mut temporary) {
                Ok(path) => sidecars.push(path),
                Err(error) => warnings.push(format!("Cover sidecar: {error}")),
            }
        }
    }
    if !skipped && options.lyrics_sidecar {
        if let Some(lyrics) = &input.lyrics {
            let synced = lyrics.lines().any(|line| {
                line.starts_with('[')
                    && line
                        .get(1..3)
                        .is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit()))
            });
            let target = path.with_extension(if synced { "lrc" } else { "txt" });
            match write_sidecar(&target, lyrics.as_bytes(), &mut temporary) {
                Ok(path) => sidecars.push(path),
                Err(error) => warnings.push(format!("Lyrics sidecar: {error}")),
            }
        }
    }
    if !skipped {
        if let Err(error) = library_index::record(&options.output_dir, &path, &input.metadata.isrc)
        {
            warnings.push(format!("Duplicate index: {error}"));
        }
    }
    Ok(ExportReceipt {
        path,
        bytes,
        album_gain_applied: false,
        quality,
        source_quality,
        source: if skipped { None } else { input.source },
        skipped,
        sidecars,
        warnings,
    })
}

pub(super) fn find_existing_recording(
    options: &ExportOptions,
    metadata: &TrackMetadata,
    cancel: &Cancellation,
) -> Result<Option<ExportReceipt>, String> {
    if options.duplicates != DuplicatePolicy::Skip
        || options.existing_file_check == ExistingFileCheck::Filename
    {
        return Ok(None);
    }
    let Some(path) = library_index::find(&options.output_dir, &metadata.isrc, cancel)? else {
        return Ok(None);
    };
    let directory = path.parent().ok_or("Invalid existing file path.")?;
    let quality = probe(&path, directory, cancel)?;
    Ok(Some(ExportReceipt {
        bytes: std::fs::metadata(&path).map_err(|e| e.to_string())?.len(),
        path,
        source_quality: quality.clone(),
        quality,
        album_gain_applied: false,
        source: None,
        skipped: true,
        sidecars: Vec::new(),
        warnings: vec![
            "Kept the existing recording matched by ISRC; no audio was downloaded.".into(),
        ],
    }))
}

pub(super) fn write_job_log(job: &DownloadJob, receipt: &JobReceipt) -> Result<(), String> {
    let directory = job.options.output_dir.join("Download logs");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(&serde_json::json!({
        "title":job.track.title,"artists":job.track.artists,"album":job.track.album,
        "spotifyId":job.track.id,"isrc":job.track.isrc,"requestedSource":job.options.source,
        "requestedQuality":job.options.quality,"time":now(),"result":receipt,
    }))
    .map_err(|e| e.to_string())?;
    let mut temporary = TemporaryFiles(Vec::new());
    let source = temporary.add(&directory, "log");
    std::fs::write(&source, data).map_err(|e| e.to_string())?;
    publish(
        &source,
        &directory.join(format!(
            "{}-{}-{}.json",
            now(),
            job.id,
            safe_component(&job.track.title)
        )),
        DuplicatePolicy::Rename,
    )?;
    Ok(())
}

/// Hard-link publication is atomic and refuses an existing destination, unlike
/// rename on Unix. A concurrent exporter can never overwrite another file.
pub(super) fn publish(
    source: &Path,
    target: &Path,
    duplicates: DuplicatePolicy,
) -> Result<(PathBuf, bool), String> {
    for suffix in 0..10_000 {
        let candidate = if suffix == 0 {
            target.to_path_buf()
        } else {
            target.with_file_name(format!(
                "{} ({suffix}).{}",
                target.file_stem().unwrap_or_default().to_string_lossy(),
                target.extension().unwrap_or_default().to_string_lossy()
            ))
        };
        match std::fs::hard_link(source, &candidate) {
            Ok(()) => return Ok((candidate, false)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if duplicates == DuplicatePolicy::Skip {
                    return Ok((candidate, true));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Could not finish the audio file without overwriting an existing file: {error}"
                ));
            }
        }
    }
    Err("Too many files already use this name. Choose another folder or template.".into())
}
pub(super) fn write_sidecar(
    target: &Path,
    bytes: &[u8],
    temporary: &mut TemporaryFiles,
) -> Result<PathBuf, String> {
    let source = temporary.add(target.parent().ok_or("Invalid sidecar folder")?, "sidecar");
    std::fs::write(&source, bytes).map_err(|e| e.to_string())?;
    publish(&source, target, DuplicatePolicy::Skip).map(|(path, _)| path)
}

pub fn write_playlist(
    directory: &Path,
    title: &str,
    tracks: &[(TrackMetadata, ExportReceipt)],
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let canonical_directory = std::fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let mut contents = String::from("#EXTM3U\n");
    for (track, receipt) in tracks {
        let label = format!("{} - {}", track.artist, track.title).replace(['\n', '\r'], " ");
        let path = receipt
            .path
            .strip_prefix(directory)
            .or_else(|_| receipt.path.strip_prefix(&canonical_directory))
            .unwrap_or(&receipt.path);
        let path = path.to_string_lossy();
        if path.contains(['\n', '\r']) {
            return Err("Playlist paths cannot contain line breaks.".into());
        }
        contents.push_str(&format!(
            "#EXTINF:{},{}\n{}\n",
            track.duration_ms / 1000,
            label,
            path
        ));
    }
    let mut temporary = TemporaryFiles(Vec::new());
    let source = temporary.add(directory, "m3u8.part");
    std::fs::write(&source, contents).map_err(|e| e.to_string())?;
    publish(
        &source,
        &directory.join(format!("{}.m3u8", safe_component(title))),
        DuplicatePolicy::Rename,
    )
    .map(|(path, _)| path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("spotify-export-test-{}", rand::random::<u64>()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wave() -> Vec<u8> {
        let rate = 44100u32;
        let samples = rate;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + samples * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples * 2).to_le_bytes());
        for n in 0..samples {
            let sample =
                ((n as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 12000.0) as i16;
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }
    async fn response(bytes: Vec<u8>) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0u8; 1024];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0 && request.len() + size < 16 * 1024);
                request.extend_from_slice(&chunk[..size]);
            }
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        reqwest::Client::new()
            .get(format!("http://{address}/audio"))
            .send()
            .await
            .unwrap()
    }
    async fn input() -> ExportInput {
        let mut cover = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 8)
            .write_to(&mut cover, image::ImageFormat::Png)
            .unwrap();
        ExportInput {
            metadata: TrackMetadata {
                id: "test".into(),
                title: "A song = #1".into(),
                artist: "A / B".into(),
                album: "Album".into(),
                album_artist: "A / B".into(),
                track_number: Some(1),
                duration_ms: 1000,
                ..Default::default()
            },
            response: response(wave()).await,
            cover: Some(cover.into_inner()),
            lyrics: Some("[00:00.00]A test line".into()),
            source: Some("Synthetic test audio".into()),
            extension: "wav".into(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn atomic_publication_never_overwrites_and_rename_keeps_both_files() {
        let dir = TestDirectory::new();
        let source = dir.0.join("part");
        let target = dir.0.join("song.flac");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&target, b"existing").unwrap();
        assert_eq!(
            publish(&source, &target, DuplicatePolicy::Skip).unwrap(),
            (target.clone(), true)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        let (renamed, skipped) = publish(&source, &target, DuplicatePolicy::Rename).unwrap();
        assert!(!skipped);
        assert_eq!(renamed.file_name().unwrap(), "song (1).flac");
        assert_eq!(std::fs::read(renamed).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn folder_templates_cannot_escape_through_parent_segments_or_symlinks() {
        let dir = TestDirectory::new();
        let outside = TestDirectory::new();
        std::os::unix::fs::symlink(&outside.0, dir.0.join("Artist")).unwrap();
        let metadata = TrackMetadata {
            artist: "Artist".into(),
            album: "Album".into(),
            ..Default::default()
        };
        let options = ExportOptions {
            output_dir: dir.0.clone(),
            ..Default::default()
        };
        assert!(
            destination_directory(&options, &metadata)
                .unwrap_err()
                .contains("symbolic link")
        );
        assert!(!outside.0.join("Album").exists());
        assert!(
            destination_directory(
                &ExportOptions {
                    folder_template: "../escape".into(),
                    ..options
                },
                &metadata
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn exports_probe_real_audio_embed_tags_and_keep_source_quality() {
        if !tool_available("ffmpeg") || !tool_available("ffprobe") {
            return;
        }
        let dir = TestDirectory::new();
        for format in OutputFormat::ALL {
            let options = ExportOptions {
                output_dir: dir.0.join(format.label()),
                format,
                folder_template: String::new(),
                cover_sidecar: true,
                sample_rate: Some(48000),
                replay_gain: format == OutputFormat::Flac,
                ..Default::default()
            };
            let result = export_file(
                input().await,
                options,
                Cancellation::default(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap_or_else(|error| panic!("{format:?}: {error}"));
            assert!(result.path.is_file());
            assert!(result.bytes > 0);
            assert_eq!(result.source_quality.codec, "pcm_s16le");
            assert_eq!(result.source_quality.sample_rate, 44100);
            assert_eq!(result.quality.sample_rate, 48000);
            assert_eq!(result.sidecars.len(), 2);
            assert_eq!(
                result
                    .path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .split('.')
                    .next()
                    .unwrap(),
                "A _ B - A song = #1"
            );
            let directory = result.path.parent().unwrap();
            assert!(std::fs::read_dir(directory).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".spotify-")
            }));
            if format == OutputFormat::Flac {
                let (json, _) = command_output(
                    "ffprobe",
                    &[
                        "-v".into(),
                        "error".into(),
                        "-show_entries".into(),
                        "format_tags".into(),
                        "-of".into(),
                        "json".into(),
                        result.path.as_os_str().to_owned(),
                    ],
                    directory,
                    &Cancellation::default(),
                )
                .unwrap();
                let tags: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(
                    tags.pointer("/format/tags")
                        .and_then(|value| value.as_object())
                        .and_then(|tags| tags
                            .iter()
                            .find(|(key, _)| key.eq_ignore_ascii_case("title")))
                        .and_then(|(_, value)| value.as_str()),
                    Some("A song = #1")
                );
                assert!(json.contains("REPLAYGAIN_TRACK_GAIN"));
                assert!(json.contains("A test line"));
            }
            if matches!(
                format,
                OutputFormat::Flac | OutputFormat::Mp3 | OutputFormat::Alac | OutputFormat::Opus
            ) {
                let (json, _) = command_output(
                    "ffprobe",
                    &[
                        "-v".into(),
                        "error".into(),
                        "-show_entries".into(),
                        "stream=codec_type:stream_disposition=attached_pic".into(),
                        "-of".into(),
                        "json".into(),
                        result.path.as_os_str().to_owned(),
                    ],
                    directory,
                    &Cancellation::default(),
                )
                .unwrap();
                assert!(
                    json.contains("\"attached_pic\": 1"),
                    "{format:?} missing embedded cover: {json}"
                );
            }
        }
    }

    #[tokio::test]
    async fn cancelled_transfer_removes_its_partial_file() {
        let dir = TestDirectory::new();
        let cancel = Cancellation::default();
        let signal = cancel.clone();
        let options = ExportOptions {
            output_dir: dir.0.clone(),
            folder_template: String::new(),
            ..Default::default()
        };
        let result = export_file(
            input().await,
            options,
            cancel,
            Arc::new(move |progress| {
                if progress.stage == JobStage::Downloading {
                    signal.cancel();
                }
            }),
        )
        .await;
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn selected_metadata_and_replaygain_survive_every_output_container() {
        if !tool_available("ffmpeg") || !tool_available("ffprobe") {
            return;
        }
        let dir = TestDirectory::new();
        for format in OutputFormat::ALL {
            let mut input = input().await;
            input.metadata.isrc = "GBTEST2600012".into();
            input.metadata.upc = "123456789012".into();
            input.metadata.composer = "Composer".into();
            input.metadata.label = "Label".into();
            input.metadata.year = "2026-10-03".into();
            input.metadata.source_url =
                "https://open.spotify.com/track/0123456789012345678901".into();
            let mut options = ExportOptions {
                output_dir: dir.0.join(format.label()),
                format,
                replay_gain: true,
                bit_depth: Some(24),
                folder_template: String::new(),
                ..Default::default()
            };
            options.metadata_tags.artist = false;
            options.metadata_tags.comment = false;
            let result = export_file(input, options, Cancellation::default(), Arc::new(|_| {}))
                .await
                .unwrap_or_else(|e| panic!("{format:?}: {e}"));
            let document = tools::inspect(&result.path, &Cancellation::default()).unwrap();
            assert_eq!(
                document.tags.get("isrc").map(String::as_str),
                Some("GBTEST2600012"),
                "{format:?}"
            );
            assert_eq!(
                document.tags.get("composer").map(String::as_str),
                Some("Composer"),
                "{format:?}"
            );
            assert!(
                !document.tags.contains_key("artist"),
                "{format:?}: disabled artist survived"
            );
            assert!(
                !document.tags.contains_key("comment"),
                "{format:?}: disabled comment survived"
            );
            assert!(
                document.tags.contains_key("replaygain_track_gain"),
                "{format:?}: missing ReplayGain"
            );
            assert!(document.has_artwork, "{format:?}: missing artwork");
            assert!(
                document
                    .lyrics
                    .as_deref()
                    .is_some_and(|s| s.contains("A test line")),
                "{format:?}: missing lyrics"
            );
        }
    }

    #[tokio::test]
    async fn original_copy_and_isrc_index_keep_audio_without_overwrites() {
        if !tool_available("ffmpeg") || !tool_available("ffprobe") {
            return;
        }
        let dir = TestDirectory::new();
        let mut data = input().await;
        data.metadata.isrc = "GBTEST2600013".into();
        let metadata = data.metadata.clone();
        let options = ExportOptions {
            output_dir: dir.0.clone(),
            format: OutputFormat::Flac,
            keep_original: true,
            folder_template: String::new(),
            lyrics_sidecar: false,
            existing_file_check: ExistingFileCheck::Isrc,
            ..Default::default()
        };
        let receipt = export_file(
            data,
            options.clone(),
            Cancellation::default(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        assert_eq!(receipt.sidecars.len(), 1);
        assert_eq!(std::fs::read(&receipt.sidecars[0]).unwrap(), wave());
        std::fs::write(dir.0.join("broken.aac"), b"not audio").unwrap();
        assert!(
            library_index::find(&dir.0, "---", &Cancellation::default())
                .unwrap()
                .is_none()
        );
        let found = find_existing_recording(&options, &metadata, &Cancellation::default())
            .unwrap()
            .unwrap();
        assert!(found.skipped);
        assert_eq!(found.path, receipt.path);
        let mut another = input().await;
        another.metadata.isrc = "GBTEST2600014".into();
        let second = export_file(another, options, Cancellation::default(), Arc::new(|_| {}))
            .await
            .unwrap();
        assert_ne!(
            second.path, receipt.path,
            "Different recordings with the same title must not overwrite each other."
        );
        assert!(receipt.path.is_file());
    }

    #[tokio::test]
    async fn atmos_refuses_settings_that_would_remove_spatial_metadata() {
        if !tool_available("ffmpeg") || !tool_available("ffprobe") {
            return;
        }
        let dir = TestDirectory::new();
        let source = dir.0.join("source.wav");
        std::fs::write(&source, wave()).unwrap();
        let encoded = dir.0.join("source.m4a");
        command_output(
            "ffmpeg",
            &[
                "-v".into(),
                "error".into(),
                "-i".into(),
                source.as_os_str().into(),
                "-c:a".into(),
                "eac3".into(),
                "-f".into(),
                "mp4".into(),
                encoded.as_os_str().into(),
            ],
            &dir.0,
            &Cancellation::default(),
        )
        .unwrap();
        let mut data = input().await;
        data.response = response(std::fs::read(&encoded).unwrap()).await;
        data.extension = "m4a".into();
        let error = export_file(
            data,
            ExportOptions {
                output_dir: dir.0.join("out"),
                quality: DownloadQuality::Atmos,
                bit_depth: Some(24),
                ..Default::default()
            },
            Cancellation::default(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("preserve its spatial information"));
    }

    #[test]
    fn playlist_keeps_relative_unicode_paths_without_overwriting() {
        let dir = TestDirectory::new();
        let metadata = TrackMetadata {
            title: "Song".into(),
            artist: "Artist".into(),
            duration_ms: 245000,
            ..Default::default()
        };
        let receipt = ExportReceipt {
            path: dir.0.join("Άλμπουμ/song.flac"),
            bytes: 1,
            album_gain_applied: false,
            quality: AudioQuality::default(),
            source_quality: AudioQuality::default(),
            source: None,
            skipped: false,
            sidecars: Vec::new(),
            warnings: Vec::new(),
        };
        let tracks = vec![(metadata, receipt)];
        let first = write_playlist(&dir.0, "Collection", &tracks).unwrap();
        let second = write_playlist(&dir.0, "Collection", &tracks).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            std::fs::read_to_string(first).unwrap(),
            "#EXTM3U\n#EXTINF:245,Artist - Song\nΆλμπουμ/song.flac\n"
        );
    }
}
