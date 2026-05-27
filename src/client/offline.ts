"use client";

import { create } from "zustand";
import type { PlayerSong } from "@/types/player";
import { isBrowserLocalSong } from "@/store/browser-local-library";

export type DownloadScope = "home" | "liked" | `playlist:${string}` | `song:${string}`;
export type OfflineDownloadStatus = "queued" | "downloading" | "downloaded" | "failed";

export type OfflineDownloadRecord = {
  songId: string;
  song: PlayerSong;
  audioUrl: string;
  imageUrl: string;
  lyricsUrl?: string;
  status: OfflineDownloadStatus;
  progress: number;
  size: number;
  error?: string;
  pinnedBy: DownloadScope[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
};

export type OfflineApiSnapshot<T = unknown> = {
  url: string;
  data: T;
  etag?: string | null;
  fetchedAt: number;
  updatedAt: number;
};

export type OfflineMutation =
  | {
      id: string;
      type: "like";
      status: OfflineMutationStatus;
      attempts: number;
      error?: string;
      createdAt: number;
      updatedAt: number;
      payload: {
        songId: string;
        nextLiked: boolean;
        song?: PlayerSong;
      };
    }
  | {
      id: string;
      type: "playlist-reorder";
      status: OfflineMutationStatus;
      attempts: number;
      error?: string;
      createdAt: number;
      updatedAt: number;
      payload: {
        playlistId: string;
        songIds: string[];
      };
    }
  | {
      id: string;
      type: "song-edit";
      status: OfflineMutationStatus;
      attempts: number;
      error?: string;
      createdAt: number;
      updatedAt: number;
      payload: {
        songId: string;
        title: string;
        artist: string;
        coverFile?: File;
        lyricsFile?: File;
        lyricsText?: string;
      };
    };

export type OfflineMutationStatus = "queued" | "syncing" | "failed" | "auth-required";
export type OfflineSyncStatus = "idle" | "syncing" | "failed" | "auth-required";

type OfflineState = {
  hydrated: boolean;
  online: boolean;
  records: Record<string, OfflineDownloadRecord>;
  pendingMutations: number;
  syncStatus: OfflineSyncStatus;
  syncError: string | null;
  storageUsage: number | null;
  storageQuota: number | null;
  persistentStorage: boolean | null;
  hydrate: () => Promise<void>;
  queueDownloads: (songs: PlayerSong[], scope: DownloadScope) => Promise<void>;
  removeDownload: (songId: string) => Promise<void>;
  removeScope: (scope: DownloadScope) => Promise<void>;
  retryFailedDownloads: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  clearPlaybackCache: () => Promise<void>;
  prefetchUpcoming: (queue: PlayerSong[], currentIndex: number) => Promise<void>;
  syncMutations: () => Promise<void>;
  refreshStorage: () => Promise<void>;
};

const DB_NAME = "spotify_offline_v1";
const DB_VERSION = 1;
const DOWNLOAD_STORE = "downloads";
const API_SNAPSHOT_STORE = "api_snapshots";
const MUTATION_STORE = "mutations";
export const OFFLINE_MEDIA_CACHE = "spotify-media-v1";
export const OFFLINE_PLAYBACK_CACHE = "spotify-playback-v1";
const OFFLINE_SYNC_EVENT = "spotify-offline-sync";
const PLAYBACK_WARM_BYTES = 2 * 1024 * 1024;
const PLAYBACK_WARM_TIMEOUT_MS = 4_000;
const PLAYBACK_WARM_DEDUPE_MS = 2 * 60 * 1_000;
const PLAYBACK_WARM_QUEUE_LIMIT = 12;

let dbPromise: Promise<IDBDatabase> | null = null;
let hydrateStarted = false;
let listenersAttached = false;
let downloadPumpRunning = false;
let syncRunning = false;
let prefetchRunning = false;
let warmPlaybackPumpRunning = false;
const warmPlaybackQueue: string[] = [];
const warmPlaybackSeen = new Map<string, number>();

function now(): number {
  return Date.now();
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasCacheStorage(): boolean {
  return typeof caches !== "undefined";
}

function openOfflineDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("IndexedDB is not available"));
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOWNLOAD_STORE)) {
        db.createObjectStore(DOWNLOAD_STORE, { keyPath: "songId" });
      }
      if (!db.objectStoreNames.contains(API_SNAPSHOT_STORE)) {
        db.createObjectStore(API_SNAPSHOT_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(MUTATION_STORE)) {
        db.createObjectStore(MUTATION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open offline database"));
  });
  return dbPromise;
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error(`Failed to read ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to read ${storeName}`));
  });
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error(`Failed to read ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to read ${storeName}`));
  });
}

async function idbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`));
    tx.onabort = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`));
  });
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to delete from ${storeName}`));
  });
}

async function idbClear(storeName: string): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to clear ${storeName}`));
  });
}

function recordsById(records: OfflineDownloadRecord[]): Record<string, OfflineDownloadRecord> {
  const map: Record<string, OfflineDownloadRecord> = {};
  for (const record of records) {
    map[record.songId] = record;
  }
  return map;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function canCacheSong(song: PlayerSong): boolean {
  if (isBrowserLocalSong(song)) return false;
  return sameOriginCacheableUrl(song.audioUrl);
}

function sameOriginCacheableUrl(value: string | null | undefined): boolean {
  if (!value || /^(blob:|data:)/i.test(value)) return false;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin;
  } catch {
    return false;
  }
}

function resolveUrl(value: string): string {
  return new URL(value, location.origin).toString();
}

function songAssetUrls(song: PlayerSong): string[] {
  return uniqueStrings([song.audioUrl, song.imageUrl, song.lyricsUrl]).filter(sameOriginCacheableUrl).map(resolveUrl);
}

async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

async function estimateStorage(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return {
      usage: typeof estimate?.usage === "number" ? estimate.usage : null,
      quota: typeof estimate?.quota === "number" ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
}

async function cacheUrl(
  url: string,
  cacheName: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<number> {
  if (!hasCacheStorage()) throw new Error("Cache storage is not available");
  const absoluteUrl = resolveUrl(url);
  const cache = await caches.open(cacheName);
  const cached = await cache.match(absoluteUrl);
  if (cached) {
    const blob = await cached.clone().blob().catch(() => null);
    return blob?.size ?? 0;
  }

  const response = await fetch(absoluteUrl, {
    credentials: "include",
    cache: "reload",
  });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);

  const totalRaw = Number(response.headers.get("content-length") || 0);
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
  const headers = new Headers(response.headers);
  headers.set("x-spotify-offline-cached-at", String(now()));

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(blob.size, total);
    await cache.put(
      absoluteUrl,
      new Response(blob, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
    return blob.size;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy.buffer);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }

  const blob = new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
  await cache.put(
    absoluteUrl,
    new Response(blob, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
  onProgress?.(blob.size, total);
  return blob.size;
}

async function warmPlaybackUrl(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!sameOriginCacheableUrl(url)) return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PLAYBACK_WARM_TIMEOUT_MS);
  try {
    const response = await fetch(resolveUrl(url), {
      credentials: "include",
      cache: "force-cache",
      headers: {
        Range: `bytes=0-${PLAYBACK_WARM_BYTES - 1}`,
      },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
  } finally {
    window.clearTimeout(timeout);
  }
}

async function pumpWarmPlaybackQueue(): Promise<void> {
  if (warmPlaybackPumpRunning) return;
  warmPlaybackPumpRunning = true;
  try {
    for (;;) {
      const url = warmPlaybackQueue.shift();
      if (!url) break;
      await warmPlaybackUrl(url);
    }
  } finally {
    warmPlaybackPumpRunning = false;
  }
}

export function warmPlaybackSong(song: PlayerSong, priority = false): void {
  if (typeof window === "undefined" || isBrowserLocalSong(song) || !sameOriginCacheableUrl(song.audioUrl)) return;
  const url = resolveUrl(song.audioUrl);
  const seenAt = warmPlaybackSeen.get(url);
  const timestamp = now();
  if (seenAt && timestamp - seenAt < PLAYBACK_WARM_DEDUPE_MS) {
    const queuedIndex = warmPlaybackQueue.indexOf(url);
    if (priority && queuedIndex > 0) {
      warmPlaybackQueue.splice(queuedIndex, 1);
      warmPlaybackQueue.unshift(url);
    }
    return;
  }

  warmPlaybackSeen.set(url, timestamp);
  if (priority) {
    warmPlaybackQueue.unshift(url);
  } else {
    if (warmPlaybackQueue.length >= PLAYBACK_WARM_QUEUE_LIMIT) {
      warmPlaybackQueue.shift();
    }
    warmPlaybackQueue.push(url);
  }
  if (priority && warmPlaybackQueue.length > PLAYBACK_WARM_QUEUE_LIMIT) {
    warmPlaybackQueue.length = PLAYBACK_WARM_QUEUE_LIMIT;
  }
  void pumpWarmPlaybackQueue();
}

async function deleteCachedUrls(urls: string[]): Promise<void> {
  if (!hasCacheStorage()) return;
  const cacheNames = [OFFLINE_MEDIA_CACHE, OFFLINE_PLAYBACK_CACHE];
  await Promise.all(
    cacheNames.map(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await Promise.all(urls.map((url) => cache.delete(resolveUrl(url)).catch(() => false)));
    }),
  );
}

async function clearCache(cacheName: string): Promise<void> {
  if (!hasCacheStorage()) return;
  await caches.delete(cacheName);
}

async function prunePlaybackCache(): Promise<void> {
  if (!hasCacheStorage()) return;
  const cache = await caches.open(OFFLINE_PLAYBACK_CACHE);
  const requests = await cache.keys();
  const entries = await Promise.all(
    requests.map(async (request) => {
      const response = await cache.match(request);
      const cachedAt = Number(response?.headers.get("x-spotify-offline-cached-at") || 0);
      return { request, cachedAt: Number.isFinite(cachedAt) ? cachedAt : 0 };
    }),
  );
  entries.sort((left, right) => left.cachedAt - right.cachedAt);
  const deleteCount = Math.max(1, Math.ceil(entries.length / 2));
  await Promise.all(entries.slice(0, deleteCount).map((entry) => cache.delete(entry.request)));
}

async function cacheDurableUrl(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<number> {
  try {
    return await cacheUrl(url, OFFLINE_MEDIA_CACHE, onProgress);
  } catch (error) {
    await prunePlaybackCache();
    return await cacheUrl(url, OFFLINE_MEDIA_CACHE, onProgress).catch(() => {
      throw error;
    });
  }
}

function setRecordState(record: OfflineDownloadRecord): void {
  useOfflineStore.setState((state) => ({
    records: {
      ...state.records,
      [record.songId]: record,
    },
  }));
}

async function persistRecord(record: OfflineDownloadRecord): Promise<void> {
  await idbPut(DOWNLOAD_STORE, record);
  setRecordState(record);
}

async function processDownloadQueue(): Promise<void> {
  if (downloadPumpRunning) return;
  downloadPumpRunning = true;
  try {
    for (;;) {
      const records = await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE);
      const record = records.find((item) => item.status === "queued");
      if (!record) break;

      let working: OfflineDownloadRecord = {
        ...record,
        status: "downloading",
        progress: 0,
        error: undefined,
        updatedAt: now(),
      };
      await persistRecord(working);

      try {
        const urls = songAssetUrls(working.song);
        if (urls.length === 0) throw new Error("No cacheable media URLs for this song");

        let completedAssets = 0;
        let totalBytes = 0;
        for (const url of urls) {
          const bytes = await cacheDurableUrl(url, (loaded, total) => {
            const assetProgress = total ? Math.min(1, loaded / total) : loaded > 0 ? 0.5 : 0;
            working = {
              ...working,
              progress: Math.min(0.98, (completedAssets + assetProgress) / urls.length),
              updatedAt: now(),
            };
            setRecordState(working);
          });
          completedAssets += 1;
          totalBytes += bytes;
          working = {
            ...working,
            progress: Math.min(0.98, completedAssets / urls.length),
            size: totalBytes,
            updatedAt: now(),
          };
          setRecordState(working);
        }

        working = {
          ...working,
          status: "downloaded",
          progress: 1,
          size: totalBytes,
          error: undefined,
          updatedAt: now(),
          lastAccessedAt: now(),
        };
        await persistRecord(working);
      } catch (error) {
        working = {
          ...working,
          status: "failed",
          error: error instanceof Error ? error.message : "Download failed",
          updatedAt: now(),
        };
        await persistRecord(working);
      }

      await useOfflineStore.getState().refreshStorage();
    }
  } finally {
    downloadPumpRunning = false;
  }
}

function attachBrowserListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("online", () => {
    useOfflineStore.setState({ online: true });
    void useOfflineStore.getState().syncMutations();
    void processDownloadQueue();
  });
  window.addEventListener("offline", () => {
    useOfflineStore.setState({ online: false });
  });
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void useOfflineStore.getState().syncMutations();
    void useOfflineStore.getState().refreshStorage();
  });
}

export async function readOfflineApiSnapshot<T>(url: string): Promise<OfflineApiSnapshot<T> | undefined> {
  if (!hasIndexedDb()) return undefined;
  try {
    return await idbGet<OfflineApiSnapshot<T>>(API_SNAPSHOT_STORE, url);
  } catch {
    return undefined;
  }
}

export async function writeOfflineApiSnapshot<T>(
  url: string,
  data: T,
  etag?: string | null,
  fetchedAt = now(),
): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const snapshot: OfflineApiSnapshot<T> = {
      url,
      data,
      etag: etag ?? null,
      fetchedAt,
      updatedAt: now(),
    };
    await idbPut(API_SNAPSHOT_STORE, snapshot);
  } catch {}
}

export async function removeOfflineApiSnapshots(
  match?: string | RegExp | ((url: string) => boolean),
): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    if (!match) {
      await idbClear(API_SNAPSHOT_STORE);
      return;
    }
    const snapshots = await idbGetAll<OfflineApiSnapshot>(API_SNAPSHOT_STORE);
    await Promise.all(
      snapshots.map(async (snapshot) => {
        const shouldDelete =
          typeof match === "string"
            ? snapshot.url === match || snapshot.url.startsWith(match)
            : match instanceof RegExp
              ? match.test(snapshot.url)
              : match(snapshot.url);
        if (shouldDelete) await idbDelete(API_SNAPSHOT_STORE, snapshot.url);
      }),
    );
  } catch {}
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function cloneJsonLike<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function updateLikedIds(data: unknown, songId: string, nextLiked: boolean): boolean {
  if (!data || typeof data !== "object") return false;
  const target = data as { likedSongIds?: unknown; likes?: unknown };
  let changed = false;
  if (hasStringArray(target.likedSongIds)) {
    const set = new Set(target.likedSongIds);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likedSongIds = Array.from(set);
    changed = true;
  }
  if (hasStringArray(target.likes)) {
    const set = new Set(target.likes);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likes = Array.from(set);
    changed = true;
  }
  return changed;
}

function updateLikedSongs(data: unknown, payload: { songId: string; nextLiked: boolean; song?: PlayerSong }): boolean {
  if (!data || typeof data !== "object" || !("songs" in data)) return false;
  const target = data as { songs?: unknown };
  if (!Array.isArray(target.songs)) return false;
  if (payload.nextLiked) {
    if (!payload.song) return false;
    const exists = target.songs.some((song) => {
      return song && typeof song === "object" && (song as PlayerSong).id === payload.songId;
    });
    if (!exists) target.songs = [payload.song, ...target.songs];
    return true;
  }
  target.songs = target.songs.filter((song) => {
    return !(song && typeof song === "object" && (song as PlayerSong).id === payload.songId);
  });
  return true;
}

function updateSongInPayload(data: unknown, songId: string, patch: Partial<PlayerSong>): boolean {
  if (!data || typeof data !== "object") return false;
  let changed = false;
  const target = data as { songs?: unknown; song?: unknown };
  if (Array.isArray(target.songs)) {
    target.songs = target.songs.map((song) => {
      if (!song || typeof song !== "object" || (song as PlayerSong).id !== songId) return song;
      changed = true;
      return { ...(song as PlayerSong), ...patch };
    });
  }
  if (target.song && typeof target.song === "object" && (target.song as PlayerSong).id === songId) {
    target.song = { ...(target.song as PlayerSong), ...patch };
    changed = true;
  }
  return changed;
}

function reorderPlaylistPayload(data: unknown, songIds: string[]): boolean {
  if (!data || typeof data !== "object" || !("songs" in data)) return false;
  const target = data as { songs?: unknown };
  if (!Array.isArray(target.songs)) return false;
  const order = new Map(songIds.map((songId, index) => [songId, index]));
  target.songs = [...target.songs].sort((left, right) => {
    const leftId = left && typeof left === "object" ? (left as PlayerSong).id : "";
    const rightId = right && typeof right === "object" ? (right as PlayerSong).id : "";
    const leftOrder = order.get(leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(rightId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
  return true;
}

async function updateSnapshotsForMutation(mutation: OfflineMutation): Promise<void> {
  if (!hasIndexedDb()) return;
  const snapshots = await idbGetAll<OfflineApiSnapshot>(API_SNAPSHOT_STORE).catch(() => []);
  await Promise.all(
    snapshots.map(async (snapshot) => {
      const next = cloneJsonLike(snapshot.data);
      let changed = false;
      if (mutation.type === "like") {
        changed = updateLikedIds(next, mutation.payload.songId, mutation.payload.nextLiked);
        if (snapshot.url === "/api/liked") {
          changed = updateLikedSongs(next, mutation.payload) || changed;
        }
      } else if (
        mutation.type === "playlist-reorder" &&
        snapshot.url === `/api/playlist/${encodeURIComponent(mutation.payload.playlistId)}`
      ) {
        changed = reorderPlaylistPayload(next, mutation.payload.songIds);
      } else if (mutation.type === "song-edit") {
        changed = updateSongInPayload(next, mutation.payload.songId, {
          title: mutation.payload.title,
          artist: mutation.payload.artist,
        });
      }
      if (!changed) return;
      await idbPut(API_SNAPSHOT_STORE, {
        ...snapshot,
        data: next,
        updatedAt: now(),
      });
    }),
  );
}

async function mutationCount(): Promise<number> {
  const mutations = await idbGetAll<OfflineMutation>(MUTATION_STORE).catch(() => []);
  return mutations.filter((mutation) => mutation.status !== "syncing").length;
}

function setMutationStatus(status: OfflineSyncStatus, error: string | null = null): void {
  useOfflineStore.setState({ syncStatus: status, syncError: error });
}

async function refreshMutationCount(): Promise<void> {
  useOfflineStore.setState({ pendingMutations: await mutationCount() });
}

export async function queueOfflineMutation(
  mutation: Omit<OfflineMutation, "id" | "status" | "attempts" | "createdAt" | "updatedAt" | "error">,
): Promise<OfflineMutation> {
  const timestamp = now();
  const queued = {
    ...mutation,
    id: randomId(),
    status: "queued",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as OfflineMutation;
  await idbPut(MUTATION_STORE, queued);
  await updateSnapshotsForMutation(queued);
  await refreshMutationCount();
  window.dispatchEvent(new CustomEvent(OFFLINE_SYNC_EVENT));
  void useOfflineStore.getState().syncMutations();
  return queued;
}

async function performMutation(mutation: OfflineMutation): Promise<void> {
  if (mutation.type === "like") {
    const response = await fetch("/api/likes", {
      method: mutation.payload.nextLiked ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId: mutation.payload.songId }),
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw Object.assign(new Error(`Request failed with ${response.status}`), { status: response.status });
    return;
  }

  if (mutation.type === "playlist-reorder") {
    const response = await fetch(`/api/playlist/${encodeURIComponent(mutation.payload.playlistId)}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songIds: mutation.payload.songIds }),
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw Object.assign(new Error(`Request failed with ${response.status}`), { status: response.status });
    return;
  }

  const metaResponse = await fetch(`/api/songs/${encodeURIComponent(mutation.payload.songId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: mutation.payload.title,
      artist: mutation.payload.artist,
    }),
    credentials: "include",
    cache: "no-store",
  });
  if (!metaResponse.ok) throw Object.assign(new Error(`Request failed with ${metaResponse.status}`), { status: metaResponse.status });

  if (mutation.payload.coverFile || mutation.payload.lyricsFile || mutation.payload.lyricsText?.trim()) {
    const form = new FormData();
    if (mutation.payload.coverFile) form.append("image", mutation.payload.coverFile);
    if (mutation.payload.lyricsFile) form.append("lyricsFile", mutation.payload.lyricsFile);
    if (mutation.payload.lyricsText?.trim()) form.append("lyricsText", mutation.payload.lyricsText.trim());
    const assetResponse = await fetch(`/api/songs/${encodeURIComponent(mutation.payload.songId)}/assets`, {
      method: "POST",
      body: form,
      credentials: "include",
      cache: "no-store",
    });
    if (!assetResponse.ok) throw Object.assign(new Error(`Request failed with ${assetResponse.status}`), { status: assetResponse.status });
  }
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

async function syncOfflineMutations(): Promise<void> {
  if (syncRunning || typeof navigator !== "undefined" && !navigator.onLine) return;
  syncRunning = true;
  setMutationStatus("syncing");
  try {
    const mutations = (await idbGetAll<OfflineMutation>(MUTATION_STORE))
      .filter((mutation) => mutation.status !== "syncing")
      .sort((left, right) => left.createdAt - right.createdAt);

    if (mutations.length === 0) {
      setMutationStatus("idle");
      await refreshMutationCount();
      return;
    }

    for (const mutation of mutations) {
      const syncing = {
        ...mutation,
        status: "syncing" as const,
        attempts: mutation.attempts + 1,
        updatedAt: now(),
        error: undefined,
      } as OfflineMutation;
      await idbPut(MUTATION_STORE, syncing);
      await refreshMutationCount();
      try {
        await performMutation(syncing);
        await idbDelete(MUTATION_STORE, syncing.id);
      } catch (error) {
        const status = errorStatus(error);
        const nextStatus: OfflineMutationStatus = status === 401 || status === 403 ? "auth-required" : "failed";
        const failed = {
          ...syncing,
          status: nextStatus,
          error: error instanceof Error ? error.message : "Sync failed",
          updatedAt: now(),
        } as OfflineMutation;
        await idbPut(MUTATION_STORE, failed);
        await refreshMutationCount();
        if (nextStatus === "auth-required") {
          setMutationStatus("auth-required", "Sign in to finish syncing offline changes");
          window.dispatchEvent(new CustomEvent(OFFLINE_SYNC_EVENT));
          return;
        }
        setMutationStatus("failed", failed.error ?? "Sync failed");
      }
    }

    await refreshMutationCount();
    setMutationStatus("idle");
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNC_EVENT));
  } catch (error) {
    setMutationStatus("failed", error instanceof Error ? error.message : "Sync failed");
  } finally {
    syncRunning = false;
  }
}

export function getSongDownloadState(
  record: OfflineDownloadRecord | undefined,
): OfflineDownloadStatus | "none" {
  return record?.status ?? "none";
}

export function getScopeDownloadState(
  records: Record<string, OfflineDownloadRecord>,
  songs: PlayerSong[],
  scope: DownloadScope,
): OfflineDownloadStatus | "partial" | "none" {
  const cacheableSongs = songs.filter(canCacheSong);
  if (cacheableSongs.length === 0) return "none";
  const scopedRecords = cacheableSongs
    .map((song) => records[song.id])
    .filter((record): record is OfflineDownloadRecord => !!record && record.pinnedBy.includes(scope));
  if (scopedRecords.length === 0) return "none";
  if (scopedRecords.some((record) => record.status === "failed")) return "failed";
  if (scopedRecords.some((record) => record.status === "queued" || record.status === "downloading")) return "downloading";
  if (scopedRecords.length === cacheableSongs.length && scopedRecords.every((record) => record.status === "downloaded")) {
    return "downloaded";
  }
  return "partial";
}

export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  hydrated: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  records: {},
  pendingMutations: 0,
  syncStatus: "idle",
  syncError: null,
  storageUsage: null,
  storageQuota: null,
  persistentStorage: null,
  hydrate: async () => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    attachBrowserListeners();
    const [records, pendingMutations, storage, persistentStorage] = await Promise.all([
      idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []),
      mutationCount(),
      estimateStorage(),
      requestPersistentStorage(),
    ]);
    set({
      hydrated: true,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      records: recordsById(records),
      pendingMutations,
      storageUsage: storage.usage,
      storageQuota: storage.quota,
      persistentStorage,
    });
    void processDownloadQueue();
    void syncOfflineMutations();
  },
  queueDownloads: async (songs, scope) => {
    await get().hydrate();
    const timestamp = now();
    const existing = await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []);
    const byId = recordsById(existing);
    for (const song of songs) {
      if (!canCacheSong(song)) continue;
      const current = byId[song.id];
      const pinnedBy = Array.from(new Set([...(current?.pinnedBy ?? []), scope]));
      const record: OfflineDownloadRecord = {
        songId: song.id,
        song,
        audioUrl: song.audioUrl,
        imageUrl: song.imageUrl,
        lyricsUrl: song.lyricsUrl,
        status: current?.status === "downloaded" ? "downloaded" : "queued",
        progress: current?.status === "downloaded" ? 1 : current?.progress ?? 0,
        size: current?.size ?? 0,
        error: undefined,
        pinnedBy,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastAccessedAt: timestamp,
      };
      await persistRecord(record);
    }
    void processDownloadQueue();
    await get().refreshStorage();
  },
  removeDownload: async (songId) => {
    const record = await idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, songId).catch(() => undefined);
    if (record) await deleteCachedUrls(songAssetUrls(record.song));
    await idbDelete(DOWNLOAD_STORE, songId).catch(() => undefined);
    set((state) => {
      const records = { ...state.records };
      delete records[songId];
      return { records };
    });
    await get().refreshStorage();
  },
  removeScope: async (scope) => {
    const records = await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []);
    for (const record of records) {
      if (!record.pinnedBy.includes(scope)) continue;
      const pinnedBy = record.pinnedBy.filter((item) => item !== scope);
      if (pinnedBy.length === 0) {
        await get().removeDownload(record.songId);
      } else {
        await persistRecord({ ...record, pinnedBy, updatedAt: now() });
      }
    }
    await get().refreshStorage();
  },
  retryFailedDownloads: async () => {
    const records = await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []);
    for (const record of records) {
      if (record.status !== "failed") continue;
      await persistRecord({
        ...record,
        status: "queued",
        progress: 0,
        error: undefined,
        updatedAt: now(),
      });
    }
    void processDownloadQueue();
  },
  clearDownloads: async () => {
    await idbClear(DOWNLOAD_STORE).catch(() => undefined);
    await clearCache(OFFLINE_MEDIA_CACHE);
    set({ records: {} });
    await get().refreshStorage();
  },
  clearPlaybackCache: async () => {
    await clearCache(OFFLINE_PLAYBACK_CACHE);
    await get().refreshStorage();
  },
  prefetchUpcoming: async (queue, currentIndex) => {
    if (prefetchRunning) return;
    prefetchRunning = true;
    try {
      const upcoming = queue.slice(currentIndex + 1, currentIndex + 4).filter((song) => !isBrowserLocalSong(song));
      const audioUrls = uniqueStrings(upcoming.map((song) => song.audioUrl)).filter(sameOriginCacheableUrl);
      const sidecarUrls = uniqueStrings(
        upcoming.flatMap((song) => [song.imageUrl, song.lyricsUrl]),
      ).filter(sameOriginCacheableUrl);
      for (const url of audioUrls) {
        await warmPlaybackUrl(url);
      }
      if (hasCacheStorage()) {
        for (const url of sidecarUrls) {
          await cacheUrl(url, OFFLINE_PLAYBACK_CACHE).catch(() => 0);
        }
        await get().refreshStorage();
      }
    } finally {
      prefetchRunning = false;
    }
  },
  syncMutations: syncOfflineMutations,
  refreshStorage: async () => {
    const [storage, pendingMutations] = await Promise.all([estimateStorage(), mutationCount()]);
    set({
      storageUsage: storage.usage,
      storageQuota: storage.quota,
      pendingMutations,
    });
  },
}));
