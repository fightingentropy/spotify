import { useCallback, useEffect, useRef, useState } from "react";
import {
  getApiAuthScope,
  getApiPath,
  normalizeAccountScope,
  withAccountScope,
} from "@spotify/shared/account-scope";
import {
  publishApiCacheUpdate,
  subscribeApiCacheUpdate,
} from "@spotify/shared/api-cache-updates";
import { updateLikedIdsInPayload, updateLikedSongsInPayload } from "@spotify/shared/like-cache";
import { apiReadTimeoutMs } from "@spotify/shared/api-timeout-policy";
import type { PlayerSong } from "@/types/player";
import { createApiDataCache } from "@/client/api-data-cache";
import { createApiAuthRequestGuard } from "@/client/api-auth-request";

export { normalizeAccountScope, withAccountScope };

// The signed-in account the API cache + optimistic patches are scoped to. Kept
// here (rather than in a player/store module) because api.ts owns withAccountScope
// and patchLikeApiCache, the two things that actually read it. auth.tsx sets it on
// every auth transition; likes.ts reads it before patching cached payloads.
const authRequestGuard = createApiAuthRequestGuard();

export function getAccountScope(): string {
  return authRequestGuard.getScope();
}

export function setAccountScope(scope: string | null | undefined): void {
  authRequestGuard.setScope(scope);
}

export type PlaylistEntry = {
  id: string;
  name: string;
  imageUrl?: string | null;
  coverImageUrls?: string[];
  userId?: string;
  createdAt?: string;
  songsCount: number;
};

export const API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required";
const apiCache = createApiDataCache(async (url, cached) => {
  const canExpireSession = authRequestGuard.capture(url);
  const headers = new Headers({ accept: "application/json" });
  if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);
  const response = await fetchWithTimeout(url, {
    credentials: "include",
    cache: "no-cache",
    headers,
  });
  if (response.status === 304 && cached?.data !== undefined) {
    return { data: cached.data, etag: cached.etag };
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401 && canExpireSession()) dispatchApiAuthRequired(url);
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return { data: await response.json(), etag: response.headers.get("etag") };
}, publishApiCacheUpdate);

function apiErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (/request timed out|abort/i.test(message)) {
    return "Taking too long to load — please retry.";
  }
  if (/failed to fetch|load failed|network connection.*lost|network error/i.test(message)) {
    return "Couldn't load — check your connection and retry.";
  }
  if (/internal server error|request failed with 5\d\d/i.test(message)) {
    return "Something went wrong while loading this page. Please retry.";
  }
  return message;
}

function dispatchApiAuthRequired(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { url } }));
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return fetch(input, init);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const requestUrl =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const timeoutMs = apiReadTimeoutMs(requestUrl);
  let timeoutId: number | undefined;
  try {
    const request = fetch(input, {
      ...init,
      signal: controller?.signal ?? init?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller?.abort();
        reject(new Error("Request timed out"));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export function patchLikeApiCache(
  songId: string,
  nextLiked: boolean,
  song?: PlayerSong,
  accountScope?: string,
): void {
  const scopedAccount = accountScope?.trim();
  // Preserve Date-added ordering while the server mutation is in flight. The
  // next authoritative /api/liked response will replace this client timestamp.
  const likedSong =
    nextLiked && song && !song.likedAt
      ? { ...song, likedAt: new Date().toISOString() }
      : song;
  for (const [url, entry] of apiCache.entries()) {
    if (entry.data === undefined) continue;
    if (scopedAccount && getApiAuthScope(url) !== scopedAccount) continue;
    const path = getApiPath(url);
    if (
      path !== "/api/home" &&
      path !== "/api/liked" &&
      path !== "/api/likes" &&
      !path.startsWith("/api/playlist/")
    ) {
      continue;
    }

    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    // The patch helpers replace top-level arrays; song objects are immutable.
    // Sharing unchanged metadata avoids cloning every track for a heart toggle.
    const next = { ...entry.data };
    let changed = updateLikedIdsInPayload(next, songId, nextLiked);
    if (path === "/api/liked") {
      changed = updateLikedSongsInPayload(next, { songId, nextLiked, song: likedSong }) || changed;
    }
    if (changed) apiCache.patch(url, next);
  }
}

export function invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void {
  // Sign-in/out clears every entry even when the same account signs in again.
  // A 401 from the previous session must not undo that successful sign-in.
  if (match === undefined) authRequestGuard.invalidate();
  apiCache.invalidate(match === undefined ? undefined : (url) => (
    typeof match === "string"
      ? url === match || url.startsWith(match)
      : match instanceof RegExp
        ? match.test(url)
        : match(url)
  ));
}

export function invalidateLibraryApiCache(accountScope?: string): void {
  const scopedAccount = accountScope?.trim();
  invalidateApiCache((url) => {
    if (scopedAccount && getApiAuthScope(url) !== scopedAccount) return false;
    const path = getApiPath(url);
    return (
      path === "/api/home" ||
      path === "/api/search-index" ||
      path === "/api/songs" ||
      path === "/api/liked" ||
      path === "/api/likes" ||
      path === "/api/stats/home" ||
      path === "/api/stats/listening" ||
      path.startsWith("/api/music/source") ||
      path.startsWith("/api/library") ||
      path.startsWith("/api/playlist/")
    );
  });
}

export function useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean; refreshOnReconnect?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const keepPreviousData = options?.keepPreviousData ?? false;
  const refreshOnReconnect = options?.refreshOnReconnect ?? true;
  const cachedInitial = apiCache.get<T>(url)?.data;
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && cachedInitial === undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dataUrlRef = useRef(cachedInitial !== undefined ? url : "");
  const initialValueRef = useRef(initialValue);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  const startLoad = useCallback((background = false) => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function run() {
      const cached = apiCache.get<T>(url);
      const cachedData = cached?.data;
      // keepPreviousData should only suppress the spinner/error when data is
      // actually on screen — on a cold load (no visible data yet) it must NOT
      // mask fetch errors, or every page renders an outage as an empty library.
      const hasVisibleData = dataUrlRef.current !== "";
      const canReuseCurrentData = dataUrlRef.current === url || (keepPreviousData && hasVisibleData);

      if (cancelled) return;
      if (cachedData !== undefined) {
        setDataState(cachedData);
        dataUrlRef.current = url;
        setLoading(false);
        setError(null);
      } else if (!background && !canReuseCurrentData) {
        setDataState(initialValueRef.current);
        dataUrlRef.current = "";
        setLoading(true);
      } else {
        setLoading(false);
      }

      if (!background || cachedData !== undefined) setError(null);
      try {
        const payload = await apiCache.read<T>(url, background);
        if (!cancelled) {
          setDataState(payload);
          dataUrlRef.current = url;
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            cachedData === undefined && !canReuseCurrentData
              ? apiErrorMessage(err)
              : null,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, keepPreviousData, url]);

  // Keep mounted consumers synchronized with cache patches made by actions on
  // other views (for example, adding/removing a track from Liked Songs).
  useEffect(() => {
    if (!enabled) return;
    return subscribeApiCacheUpdate<T>(url, (payload) => {
      setDataState(payload);
      dataUrlRef.current = url;
      setLoading(false);
      setError(null);
    });
  }, [enabled, url]);

  useEffect(() => {
    return startLoad(false);
  }, [startLoad, reloadKey]);

  const retry = useCallback(() => {
    invalidateApiCache(url);
    setReloadKey((value) => value + 1);
  }, [url]);

  useEffect(() => {
    if (!enabled || !refreshOnReconnect || typeof window === "undefined") return;
    let cancelReconnectLoad: (() => void) | undefined;
    const handleOnline = () => {
      cancelReconnectLoad?.();
      cancelReconnectLoad = startLoad(true);
    };
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      cancelReconnectLoad?.();
    };
  }, [enabled, startLoad, refreshOnReconnect]);

  return { data, loading, error, retry };
}

export type HomePayload = {
  // /api/home now returns only likedSongIds — the song list was dropped because
  // nothing renders it (kept optional for backward compatibility with old cached
  // snapshots that still carry it).
  songs?: PlayerSong[];
  likedSongIds: string[];
};

export type StatsHomePayload = {
  recentlyPlayed: PlayerSong[];
  mostPlayed: { song: PlayerSong; playCount: number }[];
};

export type ListeningWeek = {
  weekStart: string;
  weekEnd: string;
  minutesListened: number;
  topSong: PlayerSong | null;
  topArtist: { name: string; image: string | null } | null;
};

export type ListeningStatsPayload = { weeks: ListeningWeek[] };

// A globally-trending track from the Discover row. Not in the library. When
// `staged` is true it's already pre-downloaded into the Mac-mini's hidden
// .discover cache and plays instantly from `audioUrl` (with stable library id
// `audioId`); otherwise a tap materializes it on demand via /api/discover/stage.
// The Home "Discover" row: clickable, auto-updating playlists (Top 50 + the
// YouTube Music Discover Mix) instead of a scroll of individual tracks. Each
// opens /api/playlist/:id like any other playlist.
export type DiscoverPlaylistsPayload = {
  playlists: PlaylistEntry[];
};

export type SearchIndexPayload = {
  songs: PlayerSong[];
  nextCursor?: string | null;
};

export type SearchCatalogPayload = {
  query?: string;
  results: PlayerSong[];
};

export type LibraryPayload = {
  playlists: PlaylistEntry[];
  userId: string | null;
};

export type LikedPayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

// A user-owned playlist backed by DB rows. `kind` is optional for backward
// compatibility with offline snapshots cached before the discriminator existed.
export type LibraryPlaylistPayload = {
  kind?: "library";
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    coverImageUrls?: string[];
    userId: string;
    createdAt: string;
    editable?: boolean;
    // Server-owned capability. Older payloads omit it, so clients retain the
    // conservative local-folder fallback until every backend is upgraded.
    deletable?: boolean;
  } | null;
  songs: PlayerSong[];
  // null when the server couldn't determine the like set (owner's mini unreachable
  // for a converted folder); SongGrid skips its non-additive merge on null.
  likedSongIds: string[] | null;
};

// An auto-updating playlist streamed read-through (Top 50 / the YouTube Music
// Discover Mix). Its songs aren't library rows — already-staged tracks arrive
// fully playable, the rest are placeholders (empty audioUrl + discoverTrackId)
// that DiscoverQueueStager materializes on demand.
export type CuratedPlaylistPayload = {
  kind: "curated";
  playlist: {
    id: string;
    name: string;
    imageUrl: string;
    description?: string;
    collectionType?: "album";
  };
  songs: PlayerSong[];
  likedSongIds: string[] | null;
};

export type PlaylistPayload = LibraryPlaylistPayload | CuratedPlaylistPayload;
