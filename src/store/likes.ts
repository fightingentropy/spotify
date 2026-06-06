"use client";

import { create } from "zustand";
import { patchLikeApiCache } from "@/client/api";
import { getOfflineAccountScope, queueOfflineMutation } from "@/client/offline";
import type { PlayerSong } from "@/types/player";

type LikeToggleResult = {
  ok: boolean;
  status: number;
  error?: string;
};

type LikesState = {
  likedSongIds: Record<string, true>;
  pending: Record<string, true>;
  hydrated: boolean;
  mergeInitial: (ids: string[]) => void;
  resetRemote: () => void;
  toggleLike: (songId: string, nextLiked: boolean, song?: PlayerSong) => Promise<LikeToggleResult>;
};

const LOCAL_LIKED_SONG_IDS_KEY = "spotify_local_liked_song_ids";

function removeKey(source: Record<string, true>, key: string): Record<string, true> {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

function isLocalSongId(songId: string): boolean {
  return songId.startsWith("browser-local:") || songId.startsWith("picked-file:");
}

function readLocalLikedSongIds(): Record<string, true> {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem(LOCAL_LIKED_SONG_IDS_KEY);
    const ids = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(ids)) return {};

    const liked: Record<string, true> = {};
    for (const id of ids) {
      if (typeof id === "string" && isLocalSongId(id)) liked[id] = true;
    }
    return liked;
  } catch {
    return {};
  }
}

function writeLocalLikedSongIds(likedSongIds: Record<string, true>): void {
  if (typeof window === "undefined") return;

  try {
    const ids = Object.keys(likedSongIds).filter(isLocalSongId);
    localStorage.setItem(LOCAL_LIKED_SONG_IDS_KEY, JSON.stringify(ids));
  } catch {}
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likedSongIds: readLocalLikedSongIds(),
  pending: {},
  hydrated: true,
  mergeInitial: (ids) => {
    const list = Array.isArray(ids) ? ids : [];
    const current = get().likedSongIds;
    const next: Record<string, true> = {};

    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }

    for (const id of list) {
      if (typeof id !== "string" || id.length === 0) continue;
      next[id] = true;
    }

    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(next);
    const changed =
      currentKeys.length !== nextKeys.length ||
      nextKeys.some((id) => !current[id]);

    if (changed) set({ likedSongIds: next, hydrated: true });
    else if (!get().hydrated) set({ hydrated: true });
  },
  resetRemote: () => {
    const current = get().likedSongIds;
    const next: Record<string, true> = {};
    for (const id of Object.keys(current)) {
      if (isLocalSongId(id)) next[id] = true;
    }
    writeLocalLikedSongIds(next);
    set({ likedSongIds: next, pending: {}, hydrated: true });
  },
  toggleLike: async (songId, nextLiked, song) => {
    if (typeof songId !== "string" || songId.length === 0) {
      return { ok: false, status: 400, error: "Invalid song id" };
    }

    const pendingMap = get().pending;
    if (pendingMap[songId]) {
      return { ok: false, status: 0, error: "Like is still updating" };
    }

    const prevLiked = !!get().likedSongIds[songId];
    if (prevLiked === nextLiked) {
      return { ok: true, status: 200 };
    }

    if (isLocalSongId(songId)) {
      set((state) => {
        const likedSongIds: Record<string, true> = nextLiked
          ? { ...state.likedSongIds, [songId]: true as const }
          : removeKey(state.likedSongIds, songId);
        writeLocalLikedSongIds(likedSongIds);
        return {
          likedSongIds,
          hydrated: true,
        };
      });
      return { ok: true, status: 200 };
    }

    set((state) => ({
      likedSongIds: nextLiked ? { ...state.likedSongIds, [songId]: true } : removeKey(state.likedSongIds, songId),
      pending: { ...state.pending, [songId]: true },
      hydrated: true,
    }));

    try {
      const response = await fetch("/api/likes", {
        method: nextLiked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId }),
        credentials: "include",
        cache: "no-store",
      });

      if (!response.ok) {
        set((state) => ({
          likedSongIds: prevLiked
            ? { ...state.likedSongIds, [songId]: true }
            : removeKey(state.likedSongIds, songId),
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));

        let message: string | undefined;
        try {
          const data = (await response.json()) as { error?: unknown } | null;
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // ignore parse issues
        }

        return { ok: false, status: response.status, error: message };
      }

      set((state) => ({
        pending: removeKey(state.pending, songId),
        hydrated: true,
      }));
      patchLikeApiCache(songId, nextLiked, song, getOfflineAccountScope());

      return { ok: true, status: response.status };
    } catch (error) {
      try {
        await queueOfflineMutation({
          type: "like",
          payload: { songId, nextLiked, song },
        });
        set((state) => ({
          pending: removeKey(state.pending, songId),
          hydrated: true,
        }));
        patchLikeApiCache(songId, nextLiked, song, getOfflineAccountScope());
        return { ok: true, status: 202 };
      } catch {}

      set((state) => ({
        likedSongIds: prevLiked
          ? { ...state.likedSongIds, [songId]: true }
          : removeKey(state.likedSongIds, songId),
        pending: removeKey(state.pending, songId),
        hydrated: true,
      }));

      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : "Failed to update like",
      };
    }
  },
}));
