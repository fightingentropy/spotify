import { create } from "zustand";
import { storage } from "@/lib/storage";

// Persisted sort order for Your Library (mirrors library-view): read synchronously
// from MMKV at creation so the chosen order is applied on first paint instead of
// flashing the default, and survives closing and reopening the app.

export type LibrarySortKey = "recents" | "recently-added" | "alphabetical";

export const LIBRARY_SORT_OPTIONS: { key: LibrarySortKey; label: string }[] = [
  { key: "recents", label: "Recents" },
  { key: "recently-added", label: "Recently added" },
  { key: "alphabetical", label: "Alphabetical" },
];

export function librarySortLabel(sort: LibrarySortKey): string {
  return LIBRARY_SORT_OPTIONS.find((o) => o.key === sort)?.label ?? "Recents";
}

const SORT_KEY = "spotify_library_sort";
const DEFAULT_SORT: LibrarySortKey = "recents";

function isSortKey(v: string | null | undefined): v is LibrarySortKey {
  return v === "recents" || v === "recently-added" || v === "alphabetical";
}

function readSort(): LibrarySortKey {
  try {
    const stored = storage.getItem(SORT_KEY);
    return isSortKey(stored) ? stored : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

function writeSort(sort: LibrarySortKey): void {
  try {
    storage.setItem(SORT_KEY, sort);
  } catch {}
}

type LibrarySortState = {
  sort: LibrarySortKey;
  setSort: (sort: LibrarySortKey) => void;
};

export const useLibrarySortStore = create<LibrarySortState>((set) => ({
  sort: readSort(),
  setSort: (sort) => {
    writeSort(sort);
    set({ sort });
  },
}));
