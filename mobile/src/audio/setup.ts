import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
} from "react-native-track-player";

let setupPromise: Promise<void> | null = null;

// Idempotent player setup. setupPlayer can throw "player already initialized" on
// fast-refresh / re-entry, which we swallow.
export async function setupTrackPlayer(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({
        // We handle interruptions via the RemoteDuck event so the Zustand store
        // stays in sync (auto-pause on call/Siri, auto-resume after) — §11.
        autoHandleInterruptions: false,
        iosCategory: IOSCategory.Playback, // background audio (UIBackgroundModes: audio)
        iosCategoryMode: IOSCategoryMode.Default,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already been initialized|already initialized/i.test(message)) throw error;
    }

    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
      },
      // Lock-screen / Control-Center transport + headphone commands come free.
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
      progressUpdateEventInterval: 1, // 1s ticks drive play-events + sleep timer
      forwardJumpInterval: 15,
      backwardJumpInterval: 15,
    });
  })();
  return setupPromise;
}
