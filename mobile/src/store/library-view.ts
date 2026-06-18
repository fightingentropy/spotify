import { create } from "zustand";
import { storage } from "@/lib/storage";

// Persisted list/grid layout choice for Your Library. Read synchronously from
// MMKV at creation (like the pins/likes/player stores) so the chosen layout is
// applied on first paint instead of flashing the default, and survives closing
// and reopening the app.

export type LibraryViewMode = "list" | "grid";

const VIEW_KEY = "spotify_library_view";
const DEFAULT_VIEW: LibraryViewMode = "list";

function readView(): LibraryViewMode {
  try {
    const stored = storage.getItem(VIEW_KEY);
    return stored === "grid" || stored === "list" ? stored : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function writeView(view: LibraryViewMode): void {
  try {
    storage.setItem(VIEW_KEY, view);
  } catch {}
}

type LibraryViewState = {
  view: LibraryViewMode;
  setView: (view: LibraryViewMode) => void;
  toggleView: () => void;
};

export const useLibraryViewStore = create<LibraryViewState>((set, get) => ({
  view: readView(),
  setView: (view) => {
    writeView(view);
    set({ view });
  },
  toggleView: () => {
    const next = get().view === "grid" ? "list" : "grid";
    writeView(next);
    set({ view: next });
  },
}));
