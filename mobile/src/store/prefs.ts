import { create } from "zustand";
import { storage } from "@/lib/storage";

// User-facing app preferences (persisted via the synchronous MMKV `storage`
// shim, same pattern as the player store's settings).
const SHOW_CREATE_TAB_KEY = "spotify_show_create_tab";

function readShowCreateTab(): boolean {
  try {
    const raw = storage.getItem(SHOW_CREATE_TAB_KEY);
    return raw === null ? true : raw === "1"; // shown by default
  } catch {
    return true;
  }
}

type PrefsState = {
  showCreateTab: boolean;
  setShowCreateTab: (show: boolean) => void;
};

export const usePrefsStore = create<PrefsState>((set) => ({
  showCreateTab: readShowCreateTab(),
  setShowCreateTab: (show) => {
    try {
      storage.setItem(SHOW_CREATE_TAB_KEY, show ? "1" : "0");
    } catch {}
    set({ showCreateTab: show });
  },
}));
