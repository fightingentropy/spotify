import TrackPlayer, { Event } from "react-native-track-player";
import { usePlayerStore } from "@/store/player";

// The RNTP playback service: registered at app entry and run in a background-
// capable context so lock-screen / Control-Center / headphone commands work even
// when the UI is suspended. Each remote command maps to a store action; the
// engine (engine.ts) reacts to the store change and drives the player. This
// replaces the entire custom Swift remote-command channel (§5/§11).
export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => usePlayerStore.getState().play());
  TrackPlayer.addEventListener(Event.RemotePause, () => usePlayerStore.getState().pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => usePlayerStore.getState().pause());
  TrackPlayer.addEventListener(Event.RemoteNext, () => usePlayerStore.getState().next());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => usePlayerStore.getState().previous());

  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => {
    void TrackPlayer.seekTo(position);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, async ({ interval }) => {
    const { position } = await TrackPlayer.getProgress();
    void TrackPlayer.seekTo(position + interval);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async ({ interval }) => {
    const { position } = await TrackPlayer.getProgress();
    void TrackPlayer.seekTo(Math.max(0, position - interval));
  });

  // Audio-session interruption (call / Siri / alarm): pause on start, resume on end.
  TrackPlayer.addEventListener(Event.RemoteDuck, ({ paused }) => {
    if (paused) usePlayerStore.getState().pause();
    else usePlayerStore.getState().play();
  });
}
