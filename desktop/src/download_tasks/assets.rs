//! Explicit artwork/lyrics exports never request or download audio.
use crate::music_api::{
    MusicApi,
    downloads::{DownloadImage, DownloadTrack},
};
use crate::music_downloads::tools::{
    ToolsFileResult, ToolsProgress, ToolsProgressCallback, ToolsResult,
};
use crate::music_downloads::{Cancellation, ExportOptions};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;

async fn cancellable<T>(
    cancel: &Cancellation,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        tokio::select! { result=&mut future=>return result, _=tokio::time::sleep(std::time::Duration::from_millis(100))=>if cancel.is_cancelled() {return Err("Cancelled".into());} }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetKind {
    Covers,
    Lyrics,
    Artwork,
}
#[derive(Clone, Debug)]
pub struct AssetRequest {
    pub kind: AssetKind,
    pub tracks: Vec<DownloadTrack>,
    pub images: Vec<DownloadImage>,
    pub artist_input: Option<String>,
    pub options: ExportOptions,
}

pub async fn execute(
    mut request: AssetRequest,
    api: MusicApi,
    cancel: Cancellation,
    progress: ToolsProgressCallback,
) -> ToolsResult {
    let mut result = ToolsResult::default();
    if let Some(input) = request.artist_input.as_ref() {
        progress(ToolsProgress {
            completed: 0,
            total: 0,
            path: None,
            stage: "Finding artist artwork".into(),
        });
        match cancellable(
            &cancel,
            api.download_artist_images(input, request.options.max_artwork),
        )
        .await
        {
            Ok(images) => request.images = images,
            Err(error) => {
                result.files.push(ToolsFileResult {
                    error: Some(error),
                    ..Default::default()
                });
                result.cancelled = cancel.is_cancelled();
                return result;
            }
        }
    }
    if let Err(error) = tokio::fs::create_dir_all(&request.options.output_dir).await {
        result.files.push(ToolsFileResult {
            error: Some(format!("Could not create export folder: {error}")),
            ..Default::default()
        });
        return result;
    }
    let mut seen = HashSet::new();
    let assets: Vec<_> = if request.kind == AssetKind::Lyrics {
        request
            .tracks
            .into_iter()
            .map(|track| {
                (
                    format!("{} - {}", track.artists.join(", "), track.title),
                    String::new(),
                    Some(track),
                )
            })
            .collect()
    } else if request.kind == AssetKind::Covers {
        request
            .tracks
            .into_iter()
            .filter(|track| !track.cover_url.is_empty() && seen.insert(track.cover_url.clone()))
            .map(|track| {
                (
                    format!("{} - {} - cover", track.album_artist, track.album),
                    track.cover_url,
                    None,
                )
            })
            .collect()
    } else {
        request
            .images
            .into_iter()
            .filter(|image| !image.url.is_empty() && seen.insert(image.url.clone()))
            .map(|image| (format!("{} - {}", image.label, image.kind), image.url, None))
            .collect()
    };
    let total = assets.len();
    if total == 0 {
        result.files.push(ToolsFileResult {
            error: Some(
                "No matching artwork or lyrics tracks were available for this selection.".into(),
            ),
            ..Default::default()
        });
    }
    for (index, (name, url, track)) in assets.into_iter().enumerate() {
        if cancel.is_cancelled() {
            result.cancelled = true;
            break;
        }
        progress(ToolsProgress {
            completed: index,
            total,
            path: None,
            stage: format!("Saving {name}"),
        });
        let operation = async {
            let (bytes, extension) = if let Some(track) = track {
                let text = cancellable(
                    &cancel,
                    api.download_lyrics_with_options(&track, &request.options.lyrics),
                )
                .await?
                .ok_or_else(|| "No lyrics found for this recording.".to_string())?;
                let text = crate::music_downloads::lyrics::translate_lyrics(
                    &text,
                    &request.options.lyrics,
                    &cancel,
                )
                .await?;
                let extension = if text
                    .lines()
                    .any(|line| line.starts_with('[') && line.contains(':'))
                {
                    "lrc"
                } else {
                    "txt"
                };
                (text.into_bytes(), extension)
            } else {
                let bytes = cancellable(
                    &cancel,
                    api.download_cover_with_size(&url, request.options.max_artwork),
                )
                .await?;
                let extension = if bytes.starts_with(b"\x89PNG") {
                    "png"
                } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
                {
                    "webp"
                } else {
                    "jpg"
                };
                (bytes, extension)
            };
            if cancel.is_cancelled() {
                return Err("Cancelled".into());
            }
            save_unique(&request.options.output_dir, &name, extension, &bytes).await
        }
        .await;
        match operation {
            Ok(path) => result.files.push(ToolsFileResult {
                input: path.clone(),
                output: Some(path),
                ..Default::default()
            }),
            Err(error) => result.files.push(ToolsFileResult {
                input: PathBuf::from(name),
                error: Some(error),
                ..Default::default()
            }),
        }
    }
    result.cancelled |= cancel.is_cancelled();
    progress(ToolsProgress {
        completed: result.files.len(),
        total,
        path: None,
        stage: if result.cancelled {
            "Cancelled"
        } else {
            "Finished"
        }
        .into(),
    });
    result
}

async fn save_unique(
    directory: &Path,
    name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let stem: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '?') {
                '_'
            } else {
                c
            }
        })
        .take(160)
        .collect();
    let stem = stem.trim_matches([' ', '.']);
    let stem = if stem.is_empty() { "Artwork" } else { stem };
    for index in 0..10_000 {
        let filename = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let path = directory.join(filename);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).await {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(format!("Could not save asset: {error}"));
                }
                file.sync_all()
                    .await
                    .map_err(|error| format!("Could not finish asset: {error}"))?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save asset: {error}")),
        }
    }
    Err("Too many files with this name. Choose another folder.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn asset_copies_are_sanitized_and_never_overwrite_existing_files() {
        let directory =
            std::env::temp_dir().join(format!("spotify-assets-{}", rand::random::<u64>()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let first = save_unique(&directory, "../Artist/Title", "txt", b"Original")
            .await
            .unwrap();
        let second = save_unique(&directory, "../Artist/Title", "txt", b"New lyrics")
            .await
            .unwrap();
        assert_eq!(first.parent(), Some(directory.as_path()));
        assert_eq!(second.parent(), Some(directory.as_path()));
        assert_ne!(first, second);
        assert_eq!(tokio::fs::read(first).await.unwrap(), b"Original");
        assert_eq!(tokio::fs::read(second).await.unwrap(), b"New lyrics");
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
    #[tokio::test]
    async fn cancelled_asset_requests_stop_waiting_for_remote_work() {
        let cancel = Cancellation::default();
        cancel.cancel();
        let result: Result<(), String> = cancellable(&cancel, std::future::pending()).await;
        assert_eq!(result.unwrap_err(), "Cancelled");
    }
}
