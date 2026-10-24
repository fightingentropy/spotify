//! Where the app keeps its files.
//!
//! Configuration, durable non-secret state, and disposable caches live in the
//! platform's conventional directories. The music session itself is in the
//! platform's credential store (see `music_session.rs`).

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

    /// The log of the current run, replaced at every start.
    pub fn log_file(&self) -> PathBuf {
        self.state.join("spotifast.log")
    }

    /// Where a panic is recorded before the process dies of it.
    pub fn panic_log(&self) -> PathBuf {
        self.state.join("panic.log")
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

    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [&self.config, &self.state, &self.cache] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}
