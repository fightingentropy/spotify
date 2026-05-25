import { useEffect, useState } from "react";
import type { PlayerSong } from "@/types/player";

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
  fetchedAt: number;
  promise?: Promise<T>;
};

const API_CACHE_TTL_MS = 60_000;
const apiCache = new Map<string, ApiCacheEntry>();

function getCachedData<T>(url: string): T | undefined {
  return apiCache.get(url)?.data as T | undefined;
}

function writeApiCache<T>(url: string, data: T): T {
  apiCache.set(url, { data, fetchedAt: Date.now() });
  return data;
}

async function fetchApiData<T>(url: string): Promise<T> {
  const cached = apiCache.get(url) as ApiCacheEntry<T> | undefined;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return writeApiCache(url, (await response.json()) as T);
  })();

  apiCache.set(url, {
    data: cached?.data,
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
        fetchedAt: next.fetchedAt,
      });
    }
  }
}

export function invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void {
  if (!match) {
    apiCache.clear();
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
}

export function invalidateLibraryApiCache(): void {
  invalidateApiCache((url) =>
    url === "/api/home" ||
    url === "/api/songs" ||
    url === "/api/liked" ||
    url === "/api/likes" ||
    url.startsWith("/api/music/source") ||
    url.startsWith("/api/library") ||
    url.startsWith("/api/playlist/"),
  );
}

export function useApiData<T>(url: string, initialValue: T) {
  const cachedInitial = getCachedData<T>(url);
  const [data, setDataState] = useState<T>(cachedInitial ?? initialValue);
  const [loading, setLoading] = useState(!cachedInitial);
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
    let cancelled = false;
    const cached = apiCache.get(url) as ApiCacheEntry<T> | undefined;
    const cachedData = cached?.data;
    const fresh =
      cachedData !== undefined &&
      cached?.fetchedAt !== undefined &&
      Date.now() - cached.fetchedAt < API_CACHE_TTL_MS;

    if (cachedData !== undefined) {
      setDataState(cachedData);
      setLoading(false);
      setError(null);
    }
    if (fresh) return () => {
      cancelled = true;
    };

    async function load() {
      if (cachedData === undefined) setLoading(true);
      setError(null);
      try {
        const payload = await fetchApiData<T>(url);
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Request failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading, error, setData };
}

export type HomePayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
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
