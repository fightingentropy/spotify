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
    /// The music player is running for the signed-in account.
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
    /// player's current preference.
    pub repeat: Option<RepeatMode>,
    /// Play what would follow `context_uri` rather than the context itself.
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
    /// The volume to keep.
    Volume(u16),
    /// The slider mid-drag: applied at once, not kept yet.
    VolumePreview(u16),
    Shuffle(bool),
    Repeat(RepeatMode),
    Load(LoadSpec),
    /// Report the player's state again, as when playback moves here.
    Transfer,
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

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
