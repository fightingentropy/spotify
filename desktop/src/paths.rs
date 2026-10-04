//! Where Spotifast keeps its files.
//!
//! Configuration, durable non-secret state, and disposable caches live in the
//! platform's conventional directories. Spotify grants use the platform store;
//! the token paths below are retained only for migration and sign-out cleanup.

use std::path::PathBuf;

use directories::ProjectDirs;

#[derive(Clone, Debug)]
pub struct AppDirs {
    pub config: PathBuf,
    pub state: PathBuf,
    pub cache: PathBuf,
}

impl AppDirs {
    pub fn discover() -> Self {
        if let Some(root) = std::env::var_os("STREAMARENA_PROFILE_DIR") {
            let root = PathBuf::from(root);
            return Self {
                config: root.join("config"),
                state: root.join("state"),
                cache: root.join("cache"),
            };
        }
        Self::for_name("streamarena-music")
    }

    pub(crate) fn legacy() -> Self {
        Self::for_name("fastpotify")
    }

    /// An updater trial launch must leave the old profile available to rollback.
    pub fn for_launch(update_trial: bool) -> Self {
        Self::select_profile(Self::discover(), Self::legacy(), update_trial)
    }

    fn select_profile(current: Self, legacy: Self, update_trial: bool) -> Self {
        if update_trial
            && !current.config.exists()
            && !current.state.exists()
            && (legacy.config.exists() || legacy.state.exists())
        {
            legacy
        } else {
            current
        }
    }

    pub(crate) fn is_legacy_profile(&self) -> bool {
        self.state == Self::legacy().state
    }

    pub fn window_profile(&self) -> &'static str {
        if self.is_legacy_profile() {
            "fastpotify"
        } else {
            "streamarena-music"
        }
    }

    fn for_name(name: &str) -> Self {
        let project = ProjectDirs::from("xyz", "streamarena", name);
        match project {
            Some(project) => Self {
                config: project.config_dir().to_path_buf(),
                state: project
                    .state_dir()
                    .map(|path| path.to_path_buf())
                    .unwrap_or_else(|| project.data_local_dir().to_path_buf()),
                cache: project.cache_dir().to_path_buf(),
            },
            None => {
                let fallback = std::env::current_dir().unwrap_or_default();
                Self {
                    config: fallback.join(format!("{name}-config")),
                    state: fallback.join(format!("{name}-state")),
                    cache: fallback.join(format!("{name}-cache")),
                }
            }
        }
    }

    /// Run only after acquiring the single-instance guard, before loading state.
    pub fn migrate_legacy(&self) -> std::io::Result<()> {
        self.migrate_from(&Self::legacy())
    }

    pub(crate) fn migrate_from(&self, old: &Self) -> std::io::Result<()> {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        // Credential accounts were scoped to the original state path. Preserve
        // that non-secret identity before moving any directory (on macOS config
        // and state share a directory). Never copy a grant into this file.
        if old.state.is_dir() && !self.state.exists() {
            let profile = old.state.join("credential-profile");
            if !profile.exists() {
                let value = format!(
                    "{:x}",
                    Sha256::digest(old.state.to_string_lossy().as_bytes())
                );
                let temporary = old.state.join("credential-profile.tmp");
                let mut file = std::fs::File::create(&temporary)?;
                file.write_all(value.as_bytes())?;
                file.sync_all()?;
                std::fs::rename(temporary, profile)?;
            }
        }
        for (source, destination) in [
            (&old.config, &self.config),
            (&old.state, &self.state),
            (&old.cache, &self.cache),
        ] {
            migrate_directory(source, destination)?;
        }
        Ok(())
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }

    /// Winamp skins the listener has added, as `.wsz` files or folders.
    pub fn skins_dir(&self) -> PathBuf {
        self.config.join("skins")
    }

    /// MilkDrop presets, as `.milk` files, in folders or not, with any
    /// textures they use in a `textures` folder inside.
    pub fn milkdrop_dir(&self) -> PathBuf {
        self.config.join("milkdrop")
    }

    pub fn session_file(&self) -> PathBuf {
        self.state.join("session.json")
    }

    /// What Home and the library list last showed, for the next launch.
    pub fn home_snapshot_file(&self) -> PathBuf {
        self.state.join("music-home.json")
    }

    /// What was played here, which Spotify never hears about and so
    /// cannot tell us later. See [`crate::history`].
    pub fn history_file(&self) -> PathBuf {
        self.state.join("history.json")
    }

    pub fn shared_web_token_file(&self) -> PathBuf {
        self.state.join("shared_web_api_token.json")
    }

    pub fn personal_web_token_file(&self) -> PathBuf {
        self.state.join("personal_web_api_token.json")
    }

    pub fn legacy_web_token_file(&self) -> PathBuf {
        self.state.join("web_api_token.json")
    }

    /// The log of the current run, replaced at every start.
    pub fn log_file(&self) -> PathBuf {
        self.state.join("spotifast.log")
    }

    /// Where a panic is recorded before the process dies of it.
    pub fn panic_log(&self) -> PathBuf {
        self.state.join("panic.log")
    }

    pub fn credentials_dir(&self) -> PathBuf {
        self.state.join("credentials")
    }

    /// Optional proxy password, owner-only, never written to settings.json.
    pub fn proxy_secret_file(&self) -> PathBuf {
        self.state.join("proxy_password")
    }

    pub fn volume_dir(&self) -> PathBuf {
        self.state.join("volume")
    }

    pub fn audio_cache_dir(&self) -> PathBuf {
        self.cache.join("audio")
    }

    /// Artwork files, named by their URL without the expiring signature.
    pub fn art_cache_dir(&self) -> PathBuf {
        self.cache.join("artwork")
    }

    /// The artwork cache from before, which named files by the whole signed
    /// URL and so kept a copy of each picture per signature.
    pub fn legacy_art_cache_dir(&self) -> PathBuf {
        self.cache.join("art")
    }

    pub fn lyrics_cache_dir(&self) -> PathBuf {
        self.cache.join("lyrics")
    }

    pub fn playlist_cache_dir(&self) -> PathBuf {
        self.cache.join("playlists")
    }

    pub fn account_playlist_cache_dir(&self, account_id: &str) -> PathBuf {
        self.playlist_cache_dir().join(account_id)
    }

    pub fn liked_songs_cache_file(&self, account_id: &str) -> PathBuf {
        // Hex encoding also keeps unusual account IDs within the cache root.
        let account: String = account_id
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.cache
            .join("liked-songs")
            .join(format!("{account}.json"))
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [&self.config, &self.state, &self.cache] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

/// A same-filesystem rename preserves contents and permissions. An existing
/// destination, including a dangling symlink, always wins and is never merged.
pub fn migrate_directory(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    match std::fs::symlink_metadata(destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    match std::fs::metadata(source) {
        Ok(metadata) if metadata.is_dir() => (),
        Ok(_) => return Err(std::io::Error::other("The old profile is not a directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(source, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_files_and_credential_identity_and_is_repeatable() {
        use sha2::{Digest, Sha256};
        for shared in [false, true] {
            let root =
                std::env::temp_dir().join(format!("spotifast-migration-{}", rand::random::<u64>()));
            let dirs = |name: &str| AppDirs {
                config: root
                    .join(name)
                    .join(if shared { "state" } else { "config" }),
                state: root.join(name).join("state"),
                cache: root.join(name).join("cache"),
            };
            let old = dirs("old");
            let new = dirs("new");
            old.ensure().unwrap();
            std::fs::write(old.settings_file(), b"preferences").unwrap();
            std::fs::write(old.history_file(), b"history").unwrap();
            std::fs::write(old.cache.join("artwork"), b"cover").unwrap();
            assert_eq!(
                AppDirs::select_profile(new.clone(), old.clone(), true).state,
                old.state
            );
            assert_eq!(
                AppDirs::select_profile(new.clone(), old.clone(), false).state,
                new.state
            );
            new.migrate_from(&old).unwrap();
            new.migrate_from(&old).unwrap();
            assert_eq!(
                AppDirs::select_profile(new.clone(), old.clone(), true).state,
                new.state
            );
            assert_eq!(std::fs::read(new.settings_file()).unwrap(), b"preferences");
            assert_eq!(std::fs::read(new.history_file()).unwrap(), b"history");
            assert_eq!(std::fs::read(new.cache.join("artwork")).unwrap(), b"cover");
            assert_eq!(
                std::fs::read_to_string(new.state.join("credential-profile")).unwrap(),
                format!(
                    "{:x}",
                    Sha256::digest(old.state.to_string_lossy().as_bytes())
                )
            );
            // A separately created old profile must not overwrite the new one.
            old.ensure().unwrap();
            std::fs::write(old.settings_file(), b"other preferences").unwrap();
            new.migrate_from(&old).unwrap();
            assert_eq!(std::fs::read(new.settings_file()).unwrap(), b"preferences");
            assert_eq!(
                std::fs::read(old.settings_file()).unwrap(),
                b"other preferences"
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
