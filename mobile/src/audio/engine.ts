import { Platform } from "react-native";
import { startDiscoverQueueStager } from "@/audio/discover-stager";
import { startPlaybackContinuity } from "@/audio/playback-continuity";
import * as nativeEngine from "@/audio/engine-native";
import * as rntpEngine from "@/audio/engine-rntp";
import { startSmartShuffleController } from "@/audio/smart-shuffle-controller";
import { useOfflineStore } from "@/store/offline";
export { restorePlaybackState } from "@/audio/playback-sync";
export { startSleepTimerWatchdog } from "@/audio/sleep";

const isIOS = Platform.OS === "ios";

export async function initAudio(): Promise<void> {
  // Playback source selection reads the hydrated download records synchronously.
  // Starting an engine before this resolves can pin its first load to the remote
  // URL even though a valid file is already on disk. Make the records available
  // first so local-file preference is identical online and in airplane mode.
  await useOfflineStore.getState().hydrate();
  // Backend-agnostic: drives just-in-time staging for Discover queue placeholders
  // via a store subscription, so it must be live before any track loads.
  startDiscoverQueueStager();
  // Preserve one canonical queue across connectivity changes and keep the next
  // couple of tracks in a hidden local playback cache.
  startPlaybackContinuity();
  // Smart Shuffle top-up loop — also a store subscription; keeps recommended
  // tracks buffered ahead of the current track while the mode is on.
  startSmartShuffleController();
  if (isIOS) {
    await nativeEngine.initNativeAudio();
    return;
  }
  await rntpEngine.initRntpAudio();
}

// UI seek (Scrubber / remote). Routed to whichever backend is active.
export async function seek(seconds: number): Promise<void> {
  const position = Math.max(0, seconds);
  if (isIOS) {
    await nativeEngine.seekNative(position);
    return;
  }
  await rntpEngine.seekRntp(position);
}
