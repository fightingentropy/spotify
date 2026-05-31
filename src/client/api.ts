import { useEffect, useState } from "react";
import type { PlayerSong } from "@/types/player";
import {
  readOfflineApiSnapshot,
  removeOfflineApiSnapshots,
  writeOfflineApiSnapshot,
} from "@/client/offline-api-snapshots";

export type PlaylistEntry = {
  id: string;
  name: string;
  imageUrl?: string | null;
  userId?: string;
  createdAt?: string;
  songsCount: number;
};

type ApiCacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  promise?: Promise<T>;
};

const DEFAULT_API_CACHE_TTL_MS = 120_000;
const API_CACHE_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const apiCache = new Map<string, ApiCacheEntry>();

function getApiPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function getApiCacheTtl(url: string): number {
  const path = getApiPath(url);
  if (path === "/api/home") return 2 * 60_000;
  if (path === "/api/search-index") return 5 * 60_000;
  if (path === "/api/library") return 5 * 60_000;
  if (path === "/api/music/source") return 30_000;
  if (path === "/api/liked" || path === "/api/likes") return 60_000;
  if (path.startsWith("/api/playlist/")) return 60_000;
  return DEFAULT_API_CACHE_TTL_MS;
}

function isPersistableApiUrl(url: string): boolean {
  const path = getApiPath(url);
  return (
    path === "/api/home" ||
    path === "/api/search-index" ||
    path === "/api/library" ||
    path === "/api/liked" ||
    path === "/api/likes" ||
    path === "/api/music/source" ||
    path.startsWith("/api/playlist/")
  );
}

function getCacheEntry<T>(url: string): ApiCacheEntry<T> | undefined {
  const memory = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (memory?.data !== undefined || memory?.promise) return memory;
  return undefined;
}

async function readStoredApiCache<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  if (typeof window === "undefined" || !isPersistableApiUrl(url)) return undefined;

  const snapshot = await readOfflineApiSnapshot<T>(url);
  if (!snapshot || snapshot.data === undefined || typeof snapshot.fetchedAt !== "number") return undefined;
  if (Date.now() - snapshot.fetchedAt > API_CACHE_MAX_STALE_MS) {
    await removeOfflineApiSnapshots(url);
    return undefined;
  }
  return {
    data: snapshot.data,
    etag: snapshot.etag ?? null,
    fetchedAt: snapshot.fetchedAt,
  };
}

async function getCacheEntryAsync<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  const memory = getCacheEntry<T>(url);
  if (memory?.data !== undefined || memory?.promise) return memory;
  const stored = await readStoredApiCache<T>(url);
  if (stored) apiCache.set(url, stored);
  return stored;
}

function getCachedData<T>(url: string): T | undefined {
  return getCacheEntry<T>(url)?.data;
}

function writeApiCache<T>(url: string, data: T, etag?: string | null): T {
  const entry: ApiCacheEntry<T> = { data, etag: etag ?? null, fetchedAt: Date.now() };
  apiCache.set(url, entry);
  if (isPersistableApiUrl(url)) {
    void writeOfflineApiSnapshot(url, data, entry.etag, entry.fetchedAt);
  }
  return data;
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function cloneCacheData<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function updateLikedIdsInPayload(data: unknown, songId: string, nextLiked: boolean): boolean {
  if (!data || typeof data !== "object") return false;
  const target = data as { likedSongIds?: unknown; likes?: unknown };
  let changed = false;
  if (hasStringArray(target.likedSongIds)) {
    const set = new Set(target.likedSongIds);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likedSongIds = Array.from(set);
    changed = had !== nextLiked;
  }
  if (hasStringArray(target.likes)) {
    const set = new Set(target.likes);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likes = Array.from(set);
    changed = changed || had !== nextLiked;
  }
  return changed;
}

function updateLikedSongsInPayload(
  data: unknown,
  payload: { songId: string; nextLiked: boolean; song?: PlayerSong },
): boolean {
  if (!data || typeof data !== "object" || !("songs" in data)) return false;
  const target = data as { songs?: unknown };
  if (!Array.isArray(target.songs)) return false;
  const songs = target.songs;
  if (payload.nextLiked) {
    if (!payload.song) return false;
    const exists = songs.some((song) => {
      return song && typeof song === "object" && (song as PlayerSong).id === payload.songId;
    });
    if (exists) return false;
    target.songs = [payload.song, ...songs];
    return true;
  }
  const before = songs.length;
  const nextSongs = songs.filter((song) => {
    return !(song && typeof song === "object" && (song as PlayerSong).id === payload.songId);
  });
  target.songs = nextSongs;
  return before !== nextSongs.length;
}

export function patchLikeApiCache(songId: string, nextLiked: boolean, song?: PlayerSong): void {
  for (const [url, entry] of Array.from(apiCache.entries())) {
    if (entry.data === undefined) continue;
    const path = getApiPath(url);
    if (
      path !== "/api/home" &&
      path !== "/api/liked" &&
      path !== "/api/likes" &&
      !path.startsWith("/api/playlist/")
    ) {
      continue;
    }

    const next = cloneCacheData(entry.data);
    let changed = updateLikedIdsInPayload(next, songId, nextLiked);
    if (path === "/api/liked") {
      changed = updateLikedSongsInPayload(next, { songId, nextLiked, song }) || changed;
    }
    if (changed) writeApiCache(url, next, null);
  }
}

async function fetchApiData<T>(url: string): Promise<T> {
  const cached = await getCacheEntryAsync<T>(url);
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const headers = new Headers({ accept: "application/json" });
    if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);

    const response = await fetch(url, {
      credentials: "include",
      cache: "default",
      headers,
    });
    if (response.status === 304 && cached?.data !== undefined) {
      return writeApiCache(url, cached.data, cached.etag ?? null);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return writeApiCache(url, (await response.json()) as T, response.headers.get("etag"));
  })();

  apiCache.set(url, {
    data: cached?.data,
    etag: cached?.etag,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise,
  });

  try {
    return await promise;
  } finally {
    const next = apiCache.get(url);
    if (next?.promise === promise) {
      apiCache.set(url, {
        data: next.data,
        etag: next.etag,
        fetchedAt: next.fetchedAt,
      });
      if (next.data !== undefined && isPersistableApiUrl(url)) {
        void writeOfflineApiSnapshot(url, next.data, next.etag, next.fetchedAt);
      }
    }
  }
}

export function invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void {
  if (!match) {
    apiCache.clear();
    void removeOfflineApiSnapshots();
    return;
  }

  for (const key of Array.from(apiCache.keys())) {
    const shouldDelete =
      typeof match === "string"
        ? key === match || key.startsWith(match)
        : match instanceof RegExp
          ? match.test(key)
          : match(key);
    if (shouldDelete) apiCache.delete(key);
  }
  void removeOfflineApiSnapshots(match);
}

export function invalidateLibraryApiCache(): void {
  invalidateApiCache((url) =>
    url === "/api/home" ||
    url === "/api/search-index" ||
    url === "/api/songs" ||
    url === "/api/liked" ||
    url === "/api/likes" ||
    url.startsWith("/api/music/source") ||
    url.startsWith("/api/library") ||
    url.startsWith("/api/playlist/"),
  );
}

export function useApiData<T>(url: string, initialValue: T, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const cachedInitial = getCachedData<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);

  function setData(nextData: T | ((current: T) => T)) {
    setDataState((current) => {
      const resolved =
        typeof nextData === "function"
          ? (nextData as (current: T) => T)(current)
          : nextData;
      writeApiCache(url, resolved);
      return resolved;
    });
  }

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      const cached = await getCacheEntryAsync<T>(url);
      const cachedData = cached?.data;
      const fresh =
        cachedData !== undefined &&
        cached?.fetchedAt !== undefined &&
        Date.now() - cached.fetchedAt < getApiCacheTtl(url);

      if (cancelled) return;
      if (cachedData !== undefined) {
        setDataState(cachedData);
        setLoading(false);
        setError(null);
      } else {
        setLoading(true);
      }
      if (fresh) return;

      setError(null);
      try {
        const payload = await fetchApiData<T>(url);
        if (!cancelled) setDataState(payload);
      } catch (err) {
        if (!cancelled) {
          setError(cachedData === undefined ? (err instanceof Error ? err.message : "Request failed") : null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);

  return { data, loading, error, setData };
}

export type HomePayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type SearchIndexPayload = {
  songs: PlayerSong[];
};

export type LibraryPayload = {
  playlists: PlaylistEntry[];
  userId: string | null;
};

export type LikedPayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type PlaylistPayload = {
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
  } | null;
  songs: PlayerSong[];
  likedSongIds: string[];
};
