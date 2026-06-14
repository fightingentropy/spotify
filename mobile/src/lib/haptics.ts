import * as Haptics from "expo-haptics";

// Drop-in replacement for the web app's @capacitor/haptics wrapper
// (src/lib/haptics.ts). Fire-and-forget; never throw on the caller.
export function impactLight(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function selectionAsync(): void {
  void Haptics.selectionAsync().catch(() => {});
}
