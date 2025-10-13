"use client";

import { create } from "zustand";

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
  toggleLike: (songId: string, nextLiked: boolean) => Promise<LikeToggleResult>;
};

function removeKey(source: Record<string, true>, key: string): Record<string, true> {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likedSongIds: {},
  pending: {},
  hydrated: false,
  mergeInitial: (ids) => {
    const list = Array.isArray(ids) ? ids : [];
    const current = get().likedSongIds;
    let changed = false;
    const next = { ...current };
    for (const id of list) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (!next[id]) {
        next[id] = true;
        changed = true;
      }
    }
    if (changed) set({ likedSongIds: next, hydrated: true });
    else if (!get().hydrated) set({ hydrated: true });
  },
  toggleLike: async (songId, nextLiked) => {
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

      return { ok: true, status: response.status };
    } catch (error) {
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
