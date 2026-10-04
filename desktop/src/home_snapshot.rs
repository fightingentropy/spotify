//! What Home and the library list last showed, for one account on one
//! server, so a launch can show it at once while fresh copies load.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::api::models::{PlayHistory, Playlist, Track};

const VERSION: u32 = 1;

/// Each part is `None` until it has loaded once.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HomeSnapshot {
    version: u32,
    pub origin: String,
    pub account_id: String,
    pub playlists: Option<Vec<Playlist>>,
    pub discover: Option<Vec<Playlist>>,
    pub top_tracks: Option<Vec<Track>>,
    pub recently_played: Option<Vec<PlayHistory>>,
    pub liked_total: Option<u32>,
}

impl HomeSnapshot {
    pub fn new(origin: &str, account_id: &str) -> Self {
        Self {
            version: VERSION,
            origin: origin.to_owned(),
            account_id: account_id.to_owned(),
            ..Self::default()
        }
    }

    pub fn belongs_to(&self, origin: &str, account_id: &str) -> bool {
        self.version == VERSION && self.origin == origin && self.account_id == account_id
    }

    pub fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    pub fn save(&self, path: &Path) {
        let Ok(bytes) = serde_json::to_vec(self) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temporary = path.with_extension("json.tmp");
        let written = std::fs::write(&temporary, bytes)
            .and_then(|()| crate::util::replace_file(&temporary, path));
        if let Err(error) = written {
            log::warn!("unable to save Home for the next launch: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_round_trips_and_belongs_only_to_its_account_and_server() {
        let path = std::env::temp_dir()
            .join(format!("spotifast-home-snapshot-{}", std::process::id()))
            .join("music-home.json");
        let mut snapshot = HomeSnapshot::new("https://music.example", "listener");
        snapshot.playlists = Some(vec![Playlist {
            id: "pl1".into(),
            name: "Morning".into(),
            ..Playlist::default()
        }]);
        snapshot.liked_total = Some(14);
        snapshot.save(&path);

        let loaded = HomeSnapshot::load(&path).expect("a saved snapshot");
        assert_eq!(loaded, snapshot);
        assert!(loaded.belongs_to("https://music.example", "listener"));
        assert!(!loaded.belongs_to("https://music.example", "someone-else"));
        assert!(!loaded.belongs_to("http://127.0.0.1:5176", "listener"));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_snapshot_from_another_version_is_not_used() {
        let mut snapshot = HomeSnapshot::new("https://music.example", "listener");
        snapshot.version = VERSION + 1;
        assert!(!snapshot.belongs_to("https://music.example", "listener"));
        assert_eq!(
            HomeSnapshot::load(Path::new("/nonexistent/music-home.json")),
            None
        );
    }
}
