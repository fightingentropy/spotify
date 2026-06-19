import { create } from "zustand";
import { storage } from "@/lib/storage";
import type { PodcastShow } from "@/lib/podcasts";

// Persisted list of podcasts the user added by RSS URL. Read synchronously from
// MMKV at creation (like the pins/view/sort stores) so the shows are present on
// first paint and survive app restarts. Newest-added first.

const KEY = "spotify_user_podcasts";

function isShow(value: unknown): value is PodcastShow {
  const s = value as Partial<PodcastShow> | null;
  return !!s && typeof s.id === "string" && typeof s.feedUrl === "string" && typeof s.title === "string";
}

function read(): PodcastShow[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isShow).map((s) => ({ ...s, userAdded: true })) : [];
  } catch {
    return [];
  }
}

function write(shows: PodcastShow[]): void {
  try {
    storage.setItem(KEY, JSON.stringify(shows));
  } catch {}
}

type UserPodcastsState = {
  shows: PodcastShow[];
  addShow: (show: PodcastShow) => void;
  removeShow: (id: string) => void;
};

export const useUserPodcastsStore = create<UserPodcastsState>((set, get) => ({
  shows: read(),
  addShow: (show) => {
    // Dedupe by id (derived from the feed URL): re-adding a feed refreshes it and
    // floats it to the top rather than creating a duplicate.
    const next = [{ ...show, userAdded: true }, ...get().shows.filter((s) => s.id !== show.id)];
    write(next);
    set({ shows: next });
  },
  removeShow: (id) => {
    const next = get().shows.filter((s) => s.id !== id);
    write(next);
    set({ shows: next });
  },
}));
