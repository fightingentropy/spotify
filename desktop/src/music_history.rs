//! Count decoded listening time, excluding seeks and pauses, once per play.
use crate::player::{LocalState, Playback};
#[derive(Default)]
pub struct ListeningHistory {
    active: Option<Listen>,
}
struct Listen {
    uri: String,
    sequence: u64,
    seek: u64,
    position: u32,
    listened: u32,
    duration: u32,
}
impl ListeningHistory {
    pub fn observe(&mut self, state: &LocalState) -> Option<(String, u32)> {
        let changed = self.active.as_ref().is_some_and(|listen| {
            state
                .track
                .as_ref()
                .is_none_or(|track| track.uri != listen.uri)
                || state.track_sequence != listen.sequence
                || state.playback == Playback::Stopped
        });
        let finished = if changed { self.finish() } else { None };
        if !matches!(state.playback, Playback::Playing | Playback::Paused) {
            return finished;
        }
        let Some(track) = state.track.as_ref() else {
            return finished;
        };
        let listen = self.active.get_or_insert_with(|| Listen {
            uri: track.uri.clone(),
            sequence: state.track_sequence,
            seek: state.seek_sequence,
            position: state.position_ms,
            listened: 0,
            duration: track.duration_ms,
        });
        if state.playback == Playback::Playing && state.seek_sequence == listen.seek {
            let advanced = state.position_ms.saturating_sub(listen.position);
            if advanced <= 2000 {
                listen.listened = listen.listened.saturating_add(advanced);
            }
        }
        listen.position = state.position_ms;
        listen.seek = state.seek_sequence;
        finished
    }
    pub fn finish(&mut self) -> Option<(String, u32)> {
        let listen = self.active.take()?;
        let threshold = if listen.duration > 0 {
            (listen.duration / 2).min(30_000)
        } else {
            30_000
        };
        (listen.listened > 0 && listen.listened >= threshold)
            .then_some((listen.uri, listen.listened))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::LocalTrack;
    fn state(position: u32) -> LocalState {
        LocalState {
            playback: Playback::Playing,
            track: Some(LocalTrack {
                uri: "spotify:track:one".into(),
                duration_ms: 120_000,
                ..Default::default()
            }),
            position_ms: position,
            track_sequence: 1,
            ..Default::default()
        }
    }
    #[test]
    fn records_once_after_thirty_seconds_of_decoded_audio() {
        let mut history = ListeningHistory::default();
        for second in 0..=31 {
            assert!(history.observe(&state(second * 1000)).is_none());
        }
        assert_eq!(history.finish(), Some(("spotify:track:one".into(), 31_000)));
        assert!(history.finish().is_none());
    }
    #[test]
    fn seek_and_pause_do_not_fabricate_listening() {
        let mut history = ListeningHistory::default();
        history.observe(&state(0));
        history.observe(&state(1000));
        let mut seeked = state(100_000);
        seeked.seek_sequence = 1;
        history.observe(&seeked);
        seeked.playback = Playback::Paused;
        history.observe(&seeked);
        assert!(history.finish().is_none());
    }
}
