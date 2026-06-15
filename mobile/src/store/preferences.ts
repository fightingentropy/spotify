import { create } from "zustand";
import { storage } from "@/lib/storage";

// User display/language preferences that aren't tied to playback. Read once at
// store creation straight from MMKV (synchronous, no hydration flash) — the same
// pattern the player store uses for shuffle/crossfade/etc.
const GREEK_PHONETICS_STORAGE_KEY = "spotify_greek_phonetics";

function readStoredGreekPhonetics(): boolean {
  try {
    return storage.getItem(GREEK_PHONETICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

type PreferencesState = {
  // Show a phonetic Latin spelling under each Greek lyric line. Default off.
  greekPhonetics: boolean;
  setGreekPhonetics: (enabled: boolean) => void;
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  greekPhonetics: readStoredGreekPhonetics(),
  setGreekPhonetics: (enabled) => {
    try {
      storage.setItem(GREEK_PHONETICS_STORAGE_KEY, enabled ? "1" : "0");
    } catch {}
    set({ greekPhonetics: enabled });
  },
}));
