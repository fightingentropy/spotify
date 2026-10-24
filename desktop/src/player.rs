//! Playback state and commands shared by the interface and the music
//! player.

use std::sync::Arc;
use std::time::Instant;

use crate::api::models::ArtistRef;
use crate::vis::AudioTap;

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub device_name: String,
    pub autoplay: bool,
    pub audio_device: Option<String>,
    pub initial_volume: u16,
    pub tap: Arc<AudioTap>,
    /// The equalizer's settings, shared with the window that sets them.
    pub eq: crate::eq::SharedEq,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Playback {
    #[default]
    Stopped,
    Loading,
    Playing,
    Paused,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RepeatMode {
    #[default]
    Off,
    Context,
    Track,
}

impl RepeatMode {
    pub fn next(self) -> Self {
        match self {
            Self::Off => Self::Context,
            Self::Context => Self::Track,
            Self::Track => Self::Off,
        }
    }

    pub fn api_name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Context => "context",
            Self::Track => "track",
        }
    }

    pub fn from_api(name: &str) -> Self {
        match name {
            "context" => Self::Context,
            "track" => Self::Track,
            _ => Self::Off,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalTrack {
    pub uri: String,
    pub title: String,
    pub artists: Vec<ArtistRef>,
    pub album: String,
    pub art_url: Option<String>,
    pub art_small_url: Option<String>,
    pub duration_ms: u32,
    pub is_episode: bool,
}

impl LocalTrack {
    pub fn artist_names(&self) -> String {
        crate::api::models::join_names(self.artists.iter().map(|artist| artist.name.as_str()))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalState {
    /// The original song behind our service's automatic recommendations.
    pub radio_seed: Option<String>,
    pub recommendations_pending: bool,
    pub playback: Playback,
    pub track: Option<LocalTrack>,
    pub position_ms: u32,
    /// When `position_ms` was observed; `None` while not advancing.
    pub position_at: Option<Instant>,
    pub volume: u16,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    /// The librespot engine's Spotify session is alive. Connect device
    /// activity is separate: Spotify may make this device inactive while the
    /// session remains ready to be activated by the next load.
    pub connected: bool,
    pub username: String,
    pub active_client: String,
    pub error: Option<String>,
    pub seek_sequence: u64,
    /// A newly loaded track, including another play of the same URI.
    pub track_sequence: u64,
    /// Another play of the same track started, and its start position has
    /// not arrived yet. The track looks unchanged, so the `Playing` or
    /// `Paused` that brings the position counts as a seek for media
    /// controls, which would otherwise count on past the end (#587).
    pub replay_pending: bool,
}

impl LocalState {
    /// The position now, interpolated from the last report while playing.
    pub fn position_now(&self) -> u32 {
        match (self.playback, self.position_at) {
            (Playback::Playing, Some(at)) => {
                let elapsed = at.elapsed().as_millis() as u32;
                let limit = self
                    .track
                    .as_ref()
                    .map_or(u32::MAX, |track| track.duration_ms.max(self.position_ms));
                self.position_ms.saturating_add(elapsed).min(limit)
            }
            _ => self.position_ms,
        }
    }

    pub fn is_active(&self) -> bool {
        self.track.is_some() && self.playback != Playback::Stopped
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoadSpec {
    pub context_uri: Option<String>,
    pub uris: Vec<String>,
    pub offset_uri: Option<String>,
    pub offset_index: Option<u32>,
    pub position_ms: u32,
    pub play: bool,
    pub shuffle: Option<bool>,
    /// Explicit repeat preference for a new load. Otherwise retain the
    /// engine's current preference instead of librespot's default (off).
    pub repeat: Option<RepeatMode>,
    /// Play what Spotify would follow `context_uri` with, its autoplay
    /// station, rather than the context itself.
    pub autoplay: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlayerCommand {
    /// Enable or disable our service's single-song continuation.
    SimilarSongs(bool),
    Toggle,
    Next,
    Previous,
    /// Remove manually queued tracks and keep context tracks.
    ClearQueue,
    /// Queue a track or episode after the ones already queued.
    AddToQueue(String),
    Seek(u32),
    /// The volume to keep: applied at once and told to Spotify Connect.
    Volume(u16),
    /// The slider mid-drag: applied at once, nothing sent. Every Connect
    /// update costs a round trip to Spotify, and librespot makes them one
    /// after another, so dragging through fifty values lagged by seconds.
    VolumePreview(u16),
    Shuffle(bool),
    Repeat(RepeatMode),
    Load(LoadSpec),
    /// Take over the active Connect session, including its queue and position.
    Transfer,
}

/// The account's playlist tree, and what Spotify lets the account do to
/// the playlists in it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rootlist {
    /// The rows in Spotify's order, folder markers included.
    pub entries: Vec<RootlistEntry>,
    /// Playlists the account may add songs to, by URI, as Spotify's own
    /// permission service decorates the rootlist. The Web API's
    /// `collaborative` flag stays false for a playlist shared by
    /// invitation, so this is the only word on those.
    pub editable: std::collections::BTreeSet<String>,
}

/// One row of the account's playlist tree.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RootlistEntry {
    /// A playlist, by its URI.
    Playlist(String),
    /// A folder opens; everything until its end sits inside it.
    FolderStart {
        id: String,
        name: String,
    },
    FolderEnd,
}

/// The rootlist's rows from its URIs: playlists pass through, and the
/// `start-group`/`end-group` markers Spotify brackets folders with become
/// folder rows, their names percent-decoded.
pub fn parse_rootlist(uris: &[String]) -> Vec<RootlistEntry> {
    let mut entries = Vec::new();
    let mut depth = 0usize;
    for uri in uris {
        if let Some(rest) = uri.strip_prefix("spotify:start-group:") {
            let (id, name) = match rest.split_once(':') {
                Some((id, name)) => (id.to_string(), decode_folder_name(name)),
                None => (rest.to_string(), String::new()),
            };
            entries.push(RootlistEntry::FolderStart { id, name });
            depth += 1;
        } else if uri.starts_with("spotify:end-group:") {
            if depth > 0 {
                entries.push(RootlistEntry::FolderEnd);
                depth -= 1;
            }
        } else if uri.starts_with("spotify:playlist:") {
            entries.push(RootlistEntry::Playlist(uri.clone()));
        }
    }
    // A folder Spotify never closed still closes here.
    entries.extend(std::iter::repeat_n(RootlistEntry::FolderEnd, depth));
    entries
}

/// Folder names arrive percent-encoded, with `+` for a space.
fn decode_folder_name(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            // The digits are read from the bytes this loop is already
            // walking. Taking them by slicing the text instead put the end
            // of the slice two bytes past a `%`, which is inside a character
            // whenever the next one is not ASCII: a panic rather than the
            // parse error the arm below is written for, on exactly the names
            // that arm exists for.
            b'%' if i + 2 < bytes.len() => {
                let digit = |byte: u8| (byte as char).to_digit(16);
                match (digit(bytes[i + 1]), digit(bytes[i + 2])) {
                    (Some(high), Some(low)) => {
                        out.push((high << 4 | low) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn the_rootlist_markers_become_folders() {
        let uris: Vec<String> = [
            "spotify:playlist:aaa",
            "spotify:start-group:f1:Late%20Night+Mix",
            "spotify:playlist:bbb",
            "spotify:playlist:ccc",
            "spotify:end-group:f1",
            "spotify:playlist:ddd",
            "spotify:start-group:f2:Open",
            "spotify:playlist:eee",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let rows = parse_rootlist(&uris);
        assert_eq!(
            rows[0],
            RootlistEntry::Playlist("spotify:playlist:aaa".into())
        );
        assert_eq!(
            rows[1],
            RootlistEntry::FolderStart {
                id: "f1".into(),
                name: "Late Night Mix".into()
            }
        );
        assert_eq!(rows[4], RootlistEntry::FolderEnd);
        // The unclosed folder still closes.
        assert_eq!(rows.last(), Some(&RootlistEntry::FolderEnd));
        assert_eq!(rows.len(), 9);
    }

    #[test]
    fn a_folder_name_with_a_bare_percent_keeps_its_percent() {
        // The decoder already has an answer for a `%` that begins no escape:
        // it keeps the `%` and moves on. That answer could not be reached
        // when the next character was multi-byte, because the two digits
        // were taken by slicing the `&str` and the second byte of a slice
        // that lands inside a character is a panic, not a parse error.
        let uris: Vec<String> = ["spotify:start-group:f1:100%25 \u{c548}\u{b155}"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            parse_rootlist(&uris)[0],
            RootlistEntry::FolderStart {
                id: "f1".into(),
                name: "100% \u{c548}\u{b155}".into()
            }
        );

        // The same shape with nothing to decode at all.
        let raw: Vec<String> = ["spotify:start-group:f2:100% \u{c548}\u{b155}"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            parse_rootlist(&raw)[0],
            RootlistEntry::FolderStart {
                id: "f2".into(),
                name: "100% \u{c548}\u{b155}".into()
            }
        );
    }

    #[test]
    fn position_interpolates_only_while_playing() {
        let mut state = LocalState {
            playback: Playback::Paused,
            position_ms: 5_000,
            position_at: Some(Instant::now() - Duration::from_secs(2)),
            ..LocalState::default()
        };
        assert_eq!(state.position_now(), 5_000);
        state.playback = Playback::Playing;
        assert!(state.position_now() >= 7_000);
    }

    #[test]
    fn repeat_cycles_and_maps() {
        assert_eq!(RepeatMode::Off.next(), RepeatMode::Context);
        assert_eq!(RepeatMode::Track.next(), RepeatMode::Off);
        assert_eq!(RepeatMode::from_api("track"), RepeatMode::Track);
        assert_eq!(RepeatMode::Context.api_name(), "context");
    }
}
