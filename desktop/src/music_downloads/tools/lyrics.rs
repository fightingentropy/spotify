use super::*;
use std::io::Read;
const MAX_LYRICS_BYTES: usize = 512 * 1024;
fn accepted(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "lrc" | "txt"))
}
fn validate(text: &str) -> Result<(), String> {
    if text.len() > MAX_LYRICS_BYTES {
        return Err("Lyrics exceed the 512 KB limit.".into());
    }
    if text.contains('\0') {
        return Err("Lyrics must be a UTF-8 text file, without binary data.".into());
    }
    Ok(())
}
fn timestamp(value: &str) -> bool {
    let Some((minutes, seconds)) = value.split_once(':') else {
        return false;
    };
    if minutes.is_empty() || minutes.len() > 4 || !minutes.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let mut fields = seconds.split(['.', ',']);
    let seconds = fields.next().unwrap_or_default();
    if seconds.len() != 2 || seconds.parse::<u32>().ok().is_none_or(|value| value >= 60) {
        return false;
    }
    if let Some(fraction) = fields.next() {
        if fraction.is_empty()
            || fraction.len() > 3
            || !fraction.bytes().all(|b| b.is_ascii_digit())
        {
            return false;
        }
    }
    fields.next().is_none()
}
fn synced(text: &str) -> bool {
    text.lines().any(|line| {
        line.trim_start()
            .strip_prefix('[')
            .and_then(|line| line.split_once(']'))
            .is_some_and(|(stamp, _)| timestamp(stamp))
    })
}
fn read(path: &Path, cancel: &Cancellation) -> Result<LyricsDocument, String> {
    cancel.check()?;
    if !accepted(path) {
        return Err("Choose a .lrc or .txt lyrics file.".into());
    }
    let path = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let info = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !info.is_file() {
        return Err("Choose a regular lyrics file.".into());
    }
    if info.len() > MAX_LYRICS_BYTES as u64 {
        return Err("Lyrics exceed the 512 KB limit.".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(MAX_LYRICS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(
        |_| "Lyrics must use UTF-8 encoding. Convert this file to UTF-8 before importing it.",
    )?;
    let text = text.trim_start_matches('\u{feff}').to_owned();
    validate(&text)?;
    cancel.check()?;
    Ok(LyricsDocument {
        path,
        synced: synced(&text),
        text,
    })
}
pub(super) fn plain_text(text: &str) -> String {
    text.lines()
        .filter_map(|line| {
            let mut line = line.trim();
            while let Some(rest) = line.strip_prefix('[') {
                let Some((stamp, tail)) = rest.split_once(']') else {
                    break;
                };
                if timestamp(stamp) {
                    line = tail.trim_start();
                    continue;
                }
                let key = stamp
                    .split_once(':')
                    .map(|(key, _)| key.to_ascii_lowercase());
                if key.is_some_and(|key| {
                    matches!(
                        key.as_str(),
                        "ar" | "ti" | "al" | "au" | "by" | "offset" | "re" | "ve" | "length"
                    )
                }) && tail.trim().is_empty()
                {
                    return None;
                }
                break;
            }
            let mut result = String::new();
            let mut remaining = line;
            while let Some(start) = remaining.find('<') {
                result.push_str(&remaining[..start]);
                let rest = &remaining[start + 1..];
                if let Some((stamp, tail)) = rest.split_once('>') {
                    if timestamp(stamp) {
                        remaining = tail;
                        continue;
                    }
                }
                result.push('<');
                remaining = rest;
            }
            result.push_str(remaining);
            Some(result)
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn save(
    path: &Path,
    directory: &Path,
    text: &str,
    plain: bool,
    suffix: &str,
    cancel: &Cancellation,
) -> Result<LyricsDocument, String> {
    validate(text)?;
    cancel.check()?;
    let text = if plain {
        plain_text(text)
    } else {
        text.to_owned()
    };
    let is_synced = !plain && synced(&text);
    let extension = if is_synced { "lrc" } else { "txt" };
    let name = format!(
        "{} - {suffix}.{extension}",
        crate::music_downloads::safe_component(
            &path.file_stem().unwrap_or_default().to_string_lossy()
        )
    );
    let path = write_new_file(directory, &name, text.as_bytes(), cancel)?;
    Ok(LyricsDocument {
        path,
        text,
        synced: is_synced,
    })
}
pub(super) fn execute(
    request: ToolsRequest,
    cancel: &Cancellation,
    progress: &ToolsProgressCallback,
) -> ToolsResult {
    if let ToolsRequest::SaveLyrics {
        path,
        output_dir,
        text,
        plain_text,
    } = request
    {
        return match save(
            &path,
            &output_dir,
            &text,
            plain_text,
            if plain_text { "plain lyrics" } else { "edited" },
            cancel,
        ) {
            Ok(document) => ToolsResult {
                files: vec![ToolsFileResult {
                    input: path,
                    output: Some(document.path.clone()),
                    lyric_document: Some(document),
                    ..Default::default()
                }],
                cancelled: false,
            },
            Err(error) => failed_result(path, error),
        };
    }
    let ToolsRequest::InspectLyrics { paths } = request else {
        unreachable!()
    };
    let files = match expand_matching(&paths, cancel, accepted) {
        Ok(files) => files,
        Err(error) => return failed_result(PathBuf::new(), error),
    };
    if files.is_empty() {
        return failed_result(PathBuf::new(), "No .lrc or .txt files were found.".into());
    }
    let mut result = ToolsResult::default();
    for (index, path) in files.iter().enumerate() {
        progress(ToolsProgress {
            completed: index,
            total: files.len(),
            path: Some(path.clone()),
            stage: "Reading lyrics".into(),
        });
        match read(path, cancel) {
            Ok(document) => result.files.push(ToolsFileResult {
                input: path.clone(),
                lyric_document: Some(document),
                ..Default::default()
            }),
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
    }
    progress(ToolsProgress {
        completed: result.files.len(),
        total: files.len(),
        path: None,
        stage: "Finished".into(),
    });
    result
}
pub(super) async fn translate(
    path: PathBuf,
    directory: PathBuf,
    text: String,
    options: crate::music_downloads::LyricsOptions,
    cancel: Cancellation,
    progress: ToolsProgressCallback,
) -> ToolsResult {
    if let Err(error) = validate(&text) {
        return failed_result(path, error);
    }
    if text.trim().is_empty() {
        return failed_result(path, "Load or enter lyrics before translating.".into());
    }
    progress(ToolsProgress {
        completed: 0,
        total: 1,
        path: Some(path.clone()),
        stage: "Translating lyrics".into(),
    });
    match crate::music_downloads::lyrics::translate_lyrics(&text, &options, &cancel).await {
        Ok(translated) => {
            let target = path.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                save(
                    &target,
                    &directory,
                    &translated,
                    false,
                    "translated",
                    &cancel,
                )
            })
            .await;
            match outcome {
                Ok(Ok(document)) => ToolsResult {
                    files: vec![ToolsFileResult {
                        input: path,
                        output: Some(document.path.clone()),
                        lyric_document: Some(document),
                        ..Default::default()
                    }],
                    cancelled: false,
                },
                Ok(Err(error)) => failed_result(path, error),
                Err(_) => failed_result(
                    path,
                    "Saving translated lyrics stopped unexpectedly.".into(),
                ),
            }
        }
        Err(error) if error == CANCELLED => failed_result(path, error),
        Err(error) => ToolsResult {
            files: vec![ToolsFileResult {
                input: path.clone(),
                lyric_document: Some(LyricsDocument {
                    path,
                    text: text.clone(),
                    synced: synced(&text),
                }),
                warnings: vec![format!(
                    "Translation failed; the original lyrics were kept: {error}"
                )],
                ..Default::default()
            }],
            cancelled: false,
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_export_removes_timing_but_preserves_words_and_literal_brackets() {
        assert_eq!(
            plain_text(
                "[ar:Artist]\n[00:01.25][00:10.00]Hello <00:02.100>world\n[laughter]\n[01:01]Again"
            ),
            "Hello world\n[laughter]\nAgain"
        );
        assert!(synced("[123:02.01]Long track"));
        assert!(!synced("[00:99]Bad seconds"));
    }
    #[test]
    fn edit_and_plain_exports_preserve_original_and_avoid_overwrite() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("lyrics.lrc");
        let original = "[ar:Artist]\n[00:01.00]Hello";
        std::fs::write(&path, original).unwrap();
        let cancel = Cancellation::default();
        let doc = read(&path, &cancel).unwrap();
        assert!(doc.synced);
        let one = save(&path, &scratch.0, &doc.text, true, "plain lyrics", &cancel).unwrap();
        let two = save(&path, &scratch.0, &doc.text, true, "plain lyrics", &cancel).unwrap();
        assert_ne!(one.path, two.path);
        assert_eq!(one.text, "Hello");
        assert!(!one.synced);
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }
    #[test]
    fn limits_and_cancellation_prevent_outputs() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("song.lrc");
        let cancelled = Cancellation::default();
        cancelled.cancel();
        assert_eq!(
            save(&path, &scratch.0, "hello", false, "edited", &cancelled).unwrap_err(),
            CANCELLED
        );
        assert!(
            save(
                &path,
                &scratch.0,
                &"x".repeat(MAX_LYRICS_BYTES + 1),
                false,
                "edited",
                &Cancellation::default()
            )
            .is_err()
        );
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0);
    }
}
