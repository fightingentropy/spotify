import { create } from "zustand";

// Backend-agnostic playback clock for the UI (Scrubber, time labels). The active
// audio backend feeds it: engine-native pushes the active deck's `time` events
// (0.25s) on iOS; engine-rntp pushes RNTP progress on Android. Replaces the UI's
// direct dependency on RNTP's useProgress so the same scrubber works under the
// native dual-deck engine.

type ProgressState = { position: number; duration: number };

export const useAudioProgressStore = create<ProgressState>(() => ({ position: 0, duration: 0 }));

export function setAudioProgress(position: number, duration: number): void {
  const prev = useAudioProgressStore.getState();
  const nextDuration = Number.isFinite(duration) && duration > 0 ? duration : prev.duration;
  if (position === prev.position && nextDuration === prev.duration) return;
  useAudioProgressStore.setState({ position, duration: nextDuration });
}

export function resetAudioProgress(duration = 0): void {
  useAudioProgressStore.setState({ position: 0, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 });
}

// Hook for components — returns { position, duration } and re-renders on change.
export function useAudioProgress(): ProgressState {
  return useAudioProgressStore();
}
