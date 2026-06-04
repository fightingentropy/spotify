import { useCallback, useEffect, useRef, useState } from "react";
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
  promiseStartedAt?: number;
};

const API_REFRESH_HEADER = "x-spotify-api-refresh";
export const API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required";
const API_FETCH_TIMEOUT_MS = 5_000;
const API_SNAPSHOT_READ_TIMEOUT_MS = 1_000;
const apiCache = new Map<string, ApiCacheEntry>();

function getApiPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function getApiAuthScope(url: string): string {
  try {
    return new URL(url, "http://spotify.local").searchParams.get("auth")?.trim() || "legacy";
  } catch {
    return "legacy";
  }
}

export function withAccountScope(url: string, scope: string | null | undefined): string {
  const value = scope?.trim() || "anonymous";
  try {
    const parsed = new URL(url, "http://spotify.local");
    parsed.searchParams.set("auth", value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("auth", value);
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
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
    path === "/api/songs" ||
    path.startsWith("/api/playlist/")
  );
}

function getCacheEntry<T>(url: string): ApiCacheEntry<T> | undefined {
  const memory = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (!memory) return undefined;
  if (memory.promise) {
    const startedAt = memory.promiseStartedAt ?? (memory.fetchedAt > 0 ? memory.fetchedAt : 0);
    if (!startedAt || Date.now() - startedAt > API_FETCH_TIMEOUT_MS + API_SNAPSHOT_READ_TIMEOUT_MS + 1_000) {
      apiCache.set(url, {
        data: memory.data,
        etag: memory.etag,
        fetchedAt: memory.fetchedAt,
      });
      return memory.data === undefined ? undefined : getCacheEntry<T>(url);
    }
    return memory;
  }
  if (memory.data !== undefined) return memory;
  return undefined;
}

async function readStoredApiCache<T>(url: string): Promise<ApiCacheEntry<T> | undefined> {
  if (typeof window === "undefined" || !isPersistableApiUrl(url)) return undefined;

  const snapshot = await withClientTimeout(
    readOfflineApiSnapshot<T>(url),
    API_SNAPSHOT_READ_TIMEOUT_MS,
    "Offline snapshot read timed out",
  ).catch(() => undefined);
  if (!snapshot || snapshot.data === undefined || typeof snapshot.fetchedAt !== "number") return undefined;
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

function canSyncApiData(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function dispatchApiAuthRequired(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { url } }));
}

async function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (typeof window === "undefined") return promise;
  let timeoutId: number | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return fetch(input, init);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
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
      }, API_FETCH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
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

export function patchLikeApiCache(
  songId: string,
  nextLiked: boolean,
  song?: PlayerSong,
  accountScope?: string,
): void {
  const scopedAccount = accountScope?.trim();
  for (const [url, entry] of Array.from(apiCache.entries())) {
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
    headers.set(API_REFRESH_HEADER, "1");
    if (cached?.etag && cached.data !== undefined) headers.set("if-none-match", cached.etag);

    const response = await fetchWithTimeout(url, {
      credentials: "include",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached?.data !== undefined) {
      return writeApiCache(url, cached.data, cached.etag ?? null);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401) dispatchApiAuthRequired(url);
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return writeApiCache(url, (await response.json()) as T, response.headers.get("etag"));
  })();

  apiCache.set(url, {
    data: cached?.data,
    etag: cached?.etag,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise,
    promiseStartedAt: Date.now(),
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
    getApiPath(url) === "/api/home" ||
    getApiPath(url) === "/api/search-index" ||
    getApiPath(url) === "/api/songs" ||
    getApiPath(url) === "/api/liked" ||
    getApiPath(url) === "/api/likes" ||
    getApiPath(url).startsWith("/api/music/source") ||
    getApiPath(url).startsWith("/api/library") ||
    getApiPath(url).startsWith("/api/playlist/"),
  );
}

export function useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean; refreshOnReconnect?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const keepPreviousData = options?.keepPreviousData ?? false;
  const refreshOnReconnect = options?.refreshOnReconnect ?? true;
  const cachedInitial = getCachedData<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(enabled && !cachedInitial);
  const [error, setError] = useState<string | null>(null);
  const dataUrlRef = useRef(cachedInitial !== undefined ? url : "");
  const initialValueRef = useRef(initialValue);

  function setData(nextData: T | ((current: T) => T)) {
    setDataState((current) => {
      const resolved =
        typeof nextData === "function"
          ? (nextData as (current: T) => T)(current)
          : nextData;
      writeApiCache(url, resolved);
      dataUrlRef.current = url;
      return resolved;
    });
  }

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
      const cached = await getCacheEntryAsync<T>(url);
      const cachedData = cached?.data;
      const canReuseCurrentData = dataUrlRef.current === url || keepPreviousData;

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

      if (!canSyncApiData()) {
        if (cachedData === undefined && !canReuseCurrentData) {
          setError("You're offline and this data has not been cached yet.");
        }
        setLoading(false);
        return;
      }

      if (!background || cachedData !== undefined) setError(null);
      try {
        const payload = await fetchApiData<T>(url);
        if (!cancelled) {
          setDataState(payload);
          dataUrlRef.current = url;
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            cachedData === undefined && !canReuseCurrentData
              ? err instanceof Error
                ? err.message
                : "Request failed"
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

  useEffect(() => {
    return startLoad(false);
  }, [startLoad]);

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
