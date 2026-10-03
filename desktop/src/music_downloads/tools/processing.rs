use super::*;
use crate::music_downloads::{
    DuplicatePolicy, TrackMetadata,
    export::{TemporaryFiles, command_output, publish},
};
use std::{
    ffi::OsString,
    io::{Read, Write},
};

pub(super) fn copy_cancelled(
    input: &Path,
    output: &Path,
    cancel: &Cancellation,
) -> Result<(), String> {
    let mut input = std::fs::File::open(input).map_err(|e| e.to_string())?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        cancel.check()?;
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    output.sync_all().map_err(|e| e.to_string())
}
fn output_name(document: &AudioDocument, suffix: &str, ext: &str) -> String {
    format!(
        "{} - {suffix}.{ext}",
        crate::music_downloads::safe_component(
            &document
                .path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
        )
    )
}

pub(super) fn convert(
    document: &AudioDocument,
    directory: &Path,
    format: OutputFormat,
    bitrate: u32,
    rate: Option<u32>,
    depth: Option<u32>,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    if rate.is_some_and(|rate| {
        !matches!(
            rate,
            8000 | 11025
                | 16000
                | 22050
                | 24000
                | 32000
                | 44100
                | 48000
                | 88200
                | 96000
                | 176400
                | 192000
        )
    }) {
        return Err("Choose a supported sample rate between 8 and 192 kHz.".into());
    }
    if depth.is_some_and(|depth| !matches!(depth, 16 | 24 | 32)) {
        return Err("Choose 16, 24, or 32 bits.".into());
    }
    let format = if format == OutputFormat::Original && (rate.is_some() || depth.is_some()) {
        match document.quality.codec.as_str() {
            "flac" => OutputFormat::Flac,
            "alac" => OutputFormat::Alac,
            "mp3" => OutputFormat::Mp3,
            "opus" => OutputFormat::Opus,
            "aac" => OutputFormat::Aac,
            codec if codec.starts_with("pcm_") => {
                if document.quality.container.contains("aiff") {
                    OutputFormat::Aiff
                } else {
                    OutputFormat::Wav
                }
            }
            _ => return Err("Choose an explicit output format to resample this codec.".into()),
        }
    } else {
        format
    };
    let original_ext = document
        .path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("audio");
    let ext = match format {
        OutputFormat::Original => original_ext,
        OutputFormat::Flac => "flac",
        OutputFormat::Alac | OutputFormat::Aac => "m4a",
        OutputFormat::Mp3 => "mp3",
        OutputFormat::Opus => "opus",
        OutputFormat::Wav => "wav",
        OutputFormat::Aiff => "aiff",
    };
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temporary = TemporaryFiles::new();
    let output = temporary.add(directory, ext);
    if format == OutputFormat::Original {
        copy_cancelled(&document.path, &output, cancel)?;
    } else {
        let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-v", "error", "-n", "-i"]
            .into_iter()
            .map(Into::into)
            .collect();
        args.push(document.path.as_os_str().to_owned());
        args.extend(["-map", "0:a:0", "-map_metadata", "0"].map(Into::into));
        let depth = depth
            .unwrap_or(document.quality.bit_depth.unwrap_or(16))
            .clamp(16, 32);
        let codec = match format {
            OutputFormat::Flac => "flac",
            OutputFormat::Alac => "alac",
            OutputFormat::Mp3 => "libmp3lame",
            OutputFormat::Opus => "libopus",
            OutputFormat::Aac => "aac",
            OutputFormat::Wav => {
                if depth <= 16 {
                    "pcm_s16le"
                } else if depth <= 24 {
                    "pcm_s24le"
                } else {
                    "pcm_s32le"
                }
            }
            OutputFormat::Aiff => {
                if depth <= 16 {
                    "pcm_s16be"
                } else if depth <= 24 {
                    "pcm_s24be"
                } else {
                    "pcm_s32be"
                }
            }
            OutputFormat::Original => unreachable!(),
        };
        args.extend([OsString::from("-c:a"), codec.into()]);
        if matches!(format, OutputFormat::Flac | OutputFormat::Alac) {
            args.extend([
                "-sample_fmt".into(),
                if depth <= 16 {
                    "s16".into()
                } else {
                    "s32".into()
                },
            ]);
            if depth > 16 {
                args.extend([
                    "-bits_per_raw_sample".into(),
                    depth.min(24).to_string().into(),
                ]);
            }
        }
        if matches!(
            format,
            OutputFormat::Mp3 | OutputFormat::Opus | OutputFormat::Aac
        ) {
            let maximum = if format == OutputFormat::Mp3 {
                320
            } else {
                512
            };
            args.extend([
                "-b:a".into(),
                format!("{}k", bitrate.clamp(64, maximum)).into(),
            ]);
        }
        if let Some(rate) = rate {
            if format != OutputFormat::Opus {
                args.extend(["-ar".into(), rate.to_string().into()]);
            }
        }
        args.push(output.as_os_str().to_owned());
        command_output("ffmpeg", &args, directory, cancel)?;
        metadata::copy_tags(&document.path, &output, cancel)?;
    }
    cancel.check()?;
    publish(
        &output,
        &directory.join(output_name(document, "converted", ext)),
        DuplicatePolicy::Rename,
    )
    .map(|(path, _)| path)
}

pub(super) fn rename(
    document: &AudioDocument,
    directory: &Path,
    template: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    if template.trim().is_empty() {
        return Err("Enter a filename template.".into());
    }
    let get = |key: &str| document.tags.get(key).cloned().unwrap_or_default();
    let number = |key: &str| {
        document
            .tags
            .get(key)
            .and_then(|value| value.split('/').next()?.parse().ok())
    };
    let metadata = TrackMetadata {
        title: get("title"),
        artist: get("artist"),
        album: get("album"),
        album_artist: get("album_artist"),
        year: get("date"),
        isrc: get("isrc"),
        upc: get("upc"),
        genre: get("genre"),
        composer: get("composer"),
        track_number: number("track"),
        disc_number: number("disc"),
        track_total: number("tracktotal"),
        disc_total: number("disctotal"),
        ..Default::default()
    };
    let stem = crate::music_downloads::render_template(template, &metadata);
    let ext = document
        .path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("audio");
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temporary = TemporaryFiles::new();
    let copy = temporary.add(directory, ext);
    copy_cancelled(&document.path, &copy, cancel)?;
    cancel.check()?;
    publish(
        &copy,
        &directory.join(format!("{stem}.{ext}")),
        DuplicatePolicy::Rename,
    )
    .map(|(path, _)| path)
}

fn measure(
    paths: &[PathBuf],
    directory: &Path,
    cancel: &Cancellation,
) -> Result<(f64, f64), String> {
    if paths.is_empty() || paths.len() > 200 {
        return Err("Measure between 1 and 200 files as one album.".into());
    }
    let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-nostats", "-v", "info"]
        .into_iter()
        .map(Into::into)
        .collect();
    for path in paths {
        args.extend(["-i".into(), path.as_os_str().to_owned()]);
    }
    let mut graph = String::new();
    if paths.len() == 1 {
        // Measure the original channels. Upmixing a mono track before peak
        // measurement would underreport its peak by 3 dB.
        graph.push_str("[0:a:0]loudnorm=I=-18:TP=-1:LRA=11:print_format=json[out]");
    } else {
        for index in 0..paths.len() {
            graph.push_str(&format!("[{index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}];"));
        }
        for index in 0..paths.len() {
            graph.push_str(&format!("[a{index}]"));
        }
        graph.push_str(&format!(
            "concat=n={}:v=0:a=1,loudnorm=I=-18:TP=-1:LRA=11:print_format=json[out]",
            paths.len()
        ));
    }
    args.extend([
        "-filter_complex".into(),
        graph.into(),
        "-map".into(),
        "[out]".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let (_, log) = command_output("ffmpeg", &args, directory, cancel)?;
    let start = log
        .rfind('{')
        .ok_or("The loudness measurement did not return a result.")?;
    let value: serde_json::Value = serde_json::from_str(
        &log[start
            ..=log[start..]
                .find('}')
                .map(|end| start + end)
                .ok_or("The loudness report is incomplete.")?],
    )
    .map_err(|_| "The loudness measurement could not be read.")?;
    let number = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .ok_or("Audio is silent or has no measurable loudness.")
    };
    Ok((number("input_i")?, number("input_tp")?))
}
fn reports(
    paths: &[PathBuf],
    album: bool,
    cancel: &Cancellation,
    progress: Option<&ToolsProgressCallback>,
) -> Result<Vec<ReplayGainReport>, String> {
    let scratch = Scratch::new()?;
    let mut reports = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if let Some(progress) = progress {
            progress(ToolsProgress {
                completed: index,
                total: paths.len(),
                path: Some(path.clone()),
                stage: "Measuring full-track loudness".into(),
            });
        }
        let (integrated_lufs, true_peak_dbfs) =
            measure(std::slice::from_ref(path), &scratch.0, cancel)?;
        reports.push(ReplayGainReport {
            track_gain_db: -18.0 - integrated_lufs,
            track_peak: 10_f64.powf(true_peak_dbfs / 20.0),
            integrated_lufs,
            true_peak_dbfs,
            ..Default::default()
        });
    }
    if album {
        if let Some(progress) = progress {
            progress(ToolsProgress {
                completed: 0,
                total: paths.len(),
                path: None,
                stage: "Measuring album loudness".into(),
            });
        }
        let (loudness, _) = measure(paths, &scratch.0, cancel)?;
        let peak = reports
            .iter()
            .map(|report| report.track_peak)
            .fold(0.0, f64::max);
        for report in &mut reports {
            report.album_gain_db = Some(-18.0 - loudness);
            report.album_peak = Some(peak);
        }
    }
    Ok(reports)
}
pub(super) fn batch_gain(
    paths: &[PathBuf],
    directory: &Path,
    album: bool,
    cancel: &Cancellation,
    progress: &ToolsProgressCallback,
) -> ToolsResult {
    let reports = match reports(paths, album, cancel, Some(progress)) {
        Ok(reports) => reports,
        Err(error) => return failed_result(paths.first().cloned().unwrap_or_default(), error),
    };
    let mut result = ToolsResult::default();
    for (index, (path, report)) in paths.iter().zip(reports).enumerate() {
        let operation = || {
            cancel.check()?;
            std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
            let document = inspect(path, cancel)?;
            let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("audio");
            let mut temporary = TemporaryFiles::new();
            let copy = temporary.add(directory, ext);
            copy_cancelled(path, &copy, cancel)?;
            metadata::write_gain(&copy, &report, cancel)?;
            cancel.check()?;
            let (output, _) = publish(
                &copy,
                &directory.join(output_name(&document, "ReplayGain", ext)),
                DuplicatePolicy::Rename,
            )?;
            Ok::<_, String>(ToolsFileResult {
                input: path.clone(),
                document: Some(inspect(&output, cancel)?),
                output: Some(output),
                replay_gain: Some(report.clone()),
                ..Default::default()
            })
        };
        match operation() {
            Ok(item) => result.files.push(item),
            Err(error) => {
                let stopped = error == CANCELLED;
                result.files.push(ToolsFileResult {
                    input: path.clone(),
                    error: Some(error),
                    ..Default::default()
                });
                if stopped {
                    result.cancelled = true;
                    break;
                }
            }
        }
        progress(ToolsProgress {
            completed: index + 1,
            total: paths.len(),
            path: Some(path.clone()),
            stage: "Saved ReplayGain copy".into(),
        });
    }
    result
}

/// Called only for fresh app-owned downloader outputs. Prepare every tagged
/// copy before replacing any output; an error or cancellation while measuring
/// or writing tags therefore leaves all audio outputs unchanged.
pub(super) fn apply_album_gain(paths: &[PathBuf], cancel: &Cancellation) -> Result<(), String> {
    let reports = reports(paths, true, cancel, None)?;
    let mut temporary = TemporaryFiles::new();
    let mut prepared = Vec::new();
    for (path, report) in paths.iter().zip(reports) {
        let info = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !info.is_file() || info.file_type().is_symlink() {
            return Err("Album tagging requires regular newly exported audio files.".into());
        }
        let directory = path.parent().ok_or("The exported file has no folder.")?;
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("audio");
        let copy = temporary.add(directory, ext);
        copy_cancelled(path, &copy, cancel)?;
        metadata::write_gain(&copy, &report, cancel)?;
        prepared.push((copy, path));
    }
    cancel.check()?;
    // The commit itself is intentionally not interrupted between renames. Each
    // replacement is atomic and contains exactly the same encoded audio.
    for (copy, path) in prepared {
        crate::util::replace_file(&copy, path)
            .map_err(|e| format!("Album tags were prepared but could not be published: {e}"))?;
    }
    Ok(())
}
