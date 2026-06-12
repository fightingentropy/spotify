import { isNativeCapacitorApp } from "@/lib/song-utils";

type HapticsModule = typeof import("@capacitor/haptics");

let hapticsModule: Promise<HapticsModule> | null = null;

function loadHaptics(): Promise<HapticsModule> {
  hapticsModule ??= import("@capacitor/haptics");
  return hapticsModule;
}

export async function impactLight(): Promise<void> {
  if (!isNativeCapacitorApp()) return;
  try {
    const { Haptics, ImpactStyle } = await loadHaptics();
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics must never break a tap.
  }
}

export async function selectionTap(): Promise<void> {
  if (!isNativeCapacitorApp()) return;
  try {
    const { Haptics } = await loadHaptics();
    await Haptics.selectionStart();
    await Haptics.selectionChanged();
    await Haptics.selectionEnd();
  } catch {
    // Haptics must never break a tap.
  }
}
