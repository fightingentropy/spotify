//! Incremental ISRC duplicate lookup. Paths stay inside the selected download
//! folder and cached identities are invalidated when a file changes.
use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

static INDEX_LOCK: Mutex<()> = Mutex::new(());
const INDEX_NAME: &str = ".spotify-library-index.json";
const MAX_FILES: usize = 100_000;
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    bytes: u64,
    modified: u128,
    isrc: String,
}
type Index = HashMap<PathBuf, Entry>;

fn fingerprint(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    Some((
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    ))
}
fn read_index(root: &Path) -> Index {
    let path = root.join(INDEX_NAME);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() <= 32 * 1024 * 1024) {
        std::fs::read(path)
            .ok()
            .and_then(|s| serde_json::from_slice(&s).ok())
            .unwrap_or_default()
    } else {
        Index::new()
    }
}
fn save_index(root: &Path, index: &Index) -> Result<(), String> {
    let mut temporary = export::TemporaryFiles(Vec::new());
    let path = temporary.add(root, "index");
    let data = serde_json::to_vec(index).map_err(|e| e.to_string())?;
    if data.len() > 32 * 1024 * 1024 {
        return Err("The library index is too large.".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    std::fs::rename(path, root.join(INDEX_NAME)).map_err(|e| e.to_string())
}
fn normalize(isrc: &str) -> String {
    isrc.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

pub(super) fn find(
    root: &Path,
    isrc: &str,
    cancel: &Cancellation,
) -> Result<Option<PathBuf>, String> {
    if isrc.trim().is_empty() || !root.is_dir() {
        return Ok(None);
    }
    let _guard = INDEX_LOCK
        .lock()
        .map_err(|_| "Could not lock the library index.")?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let wanted = normalize(isrc);
    if wanted.is_empty() {
        return Ok(None);
    }
    let mut index = read_index(&root);
    let mut seen = HashSet::new();
    let mut folders = vec![root.clone()];
    let mut found = None;
    let mut visited = 0usize;
    while let Some(folder) = folders.pop() {
        cancel.check()?;
        for item in std::fs::read_dir(folder)
            .map_err(|e| format!("Could not scan the download folder: {e}"))?
        {
            cancel.check()?;
            let item = item.map_err(|e| e.to_string())?;
            visited += 1;
            if visited > MAX_FILES {
                return Err("The selected folder has over 100,000 entries. Choose a smaller music folder or use filename matching.".into());
            }
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = item.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = item.path();
            if kind.is_dir() {
                folders.push(path);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if ![
                "flac", "mp3", "m4a", "mp4", "aac", "opus", "ogg", "wav", "aif", "aiff", "ape",
                "wv",
            ]
            .contains(&ext.as_str())
            {
                continue;
            }
            let Some((bytes, modified)) = fingerprint(&path) else {
                continue;
            };
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| "Invalid library path.")?
                .to_path_buf();
            seen.insert(relative.clone());
            let cached = index
                .get(&relative)
                .filter(|e| e.bytes == bytes && e.modified == modified);
            let identity = if let Some(cached) = cached {
                cached.isrc.clone()
            } else {
                // A broken or unsupported file must not prevent unrelated
                // recordings from being downloaded into the same library.
                let identity = tools::read_isrc(&path)
                    .unwrap_or(None)
                    .map(|s| normalize(&s))
                    .unwrap_or_default();
                index.insert(
                    relative,
                    Entry {
                        bytes,
                        modified,
                        isrc: identity.clone(),
                    },
                );
                identity
            };
            if identity == wanted && found.is_none() {
                found = Some(path);
            }
        }
    }
    index.retain(|path, _| seen.contains(path));
    if let Err(error) = save_index(&root, &index) {
        log::warn!("Duplicate index was not cached: {error}");
    }
    Ok(found)
}

pub(super) fn record(root: &Path, path: &Path, isrc: &str) -> Result<(), String> {
    if isrc.trim().is_empty() {
        return Ok(());
    }
    let _guard = INDEX_LOCK
        .lock()
        .map_err(|_| "Could not lock the library index.")?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| "The file is outside the music folder.")?;
    let (bytes, modified) = fingerprint(&path).ok_or("The audio file is unavailable.")?;
    let mut index = read_index(&root);
    index.insert(
        relative.to_path_buf(),
        Entry {
            bytes,
            modified,
            isrc: normalize(isrc),
        },
    );
    save_index(&root, &index)
}
