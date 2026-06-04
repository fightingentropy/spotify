"use client";

import { create } from "zustand";
import type { PlayerSong } from "@/types/player";
import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { isOfflinePlaybackSong, preferOfflinePlaybackSong } from "@/lib/player-song";

export type DownloadScope = "home" | "liked" | `playlist:${string}` | `song:${string}`;
export type OfflineDownloadStatus = "queued" | "downloading" | "downloaded" | "failed";

export type OfflineDownloadRecord = {
  songId: string;
  song: PlayerSong;
  audioUrl: string;
  imageUrl: string;
  lyricsUrl?: string;
  accountScope?: string;
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
      accountScope?: string;
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
      accountScope?: string;
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
      accountScope?: string;
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

type RemoteOfflineDownload = {
  song: PlayerSong;
  pinnedBy: DownloadScope[];
  updatedAt?: string;
};

const DB_NAME = "spotify_offline_v1";
const DB_VERSION = 1;
const DOWNLOAD_STORE = "downloads";
const API_SNAPSHOT_STORE = "api_snapshots";
const MUTATION_STORE = "mutations";
export const OFFLINE_MEDIA_CACHE = "spotify-media-v1";
export const OFFLINE_PLAYBACK_CACHE = "spotify-playback-v1";
const OFFLINE_ACCOUNT_SCOPE_STORAGE_KEY = "spotify_offline_account_scope";
const OFFLINE_SYNC_EVENT = "spotify-offline-sync";
const PLAYBACK_WARM_BYTES = 512 * 1024;
const PLAYBACK_WARM_TIMEOUT_MS = 4_000;
const PLAYBACK_WARM_DEDUPE_MS = 2 * 60 * 1_000;
const PLAYBACK_WARM_QUEUE_LIMIT = 12;
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_CACHE_WRITE_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRY_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_000;
const STALE_DOWNLOADING_MS = 2 * 60 * 1_000;
const REMOTE_DOWNLOAD_SYNC_TIMEOUT_MS = 8_000;

let dbPromise: Promise<IDBDatabase> | null = null;
let hydrateStarted = false;
let listenersAttached = false;
let downloadPumpRunning = false;
let syncRunning = false;
let remoteDownloadRestoreRunning = false;
let remoteDownloadSyncRunning = false;
let prefetchRunning = false;
let warmPlaybackPumpRunning = false;
const warmPlaybackQueue: string[] = [];
const warmPlaybackSeen = new Map<string, number>();
const restoredRemoteDownloadScopes = new Set<string>();
let currentOfflineAccountScope = readStoredOfflineAccountScope();

function now(): number {
  return Date.now();
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeOfflineAccountScope(scope: string | null | undefined): string {
  const value = scope?.trim();
  return value && value !== "loading" ? value : "anonymous";
}

function readStoredOfflineAccountScope(): string {
  if (typeof window === "undefined") return "anonymous";
  try {
    return normalizeOfflineAccountScope(localStorage.getItem(OFFLINE_ACCOUNT_SCOPE_STORAGE_KEY));
  } catch {
    return "anonymous";
  }
}

function writeStoredOfflineAccountScope(scope: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OFFLINE_ACCOUNT_SCOPE_STORAGE_KEY, scope);
  } catch {}
}

export function getOfflineAccountScope(): string {
  return currentOfflineAccountScope;
}

function recordAccountScope(record: OfflineDownloadRecord): string {
  return record.accountScope ? normalizeOfflineAccountScope(record.accountScope) : "legacy";
}

export function isOfflineRecordForAccount(
  record: OfflineDownloadRecord | undefined,
  scope: string | null | undefined = currentOfflineAccountScope,
): record is OfflineDownloadRecord {
  if (!record) return false;
  return recordAccountScope(record) === normalizeOfflineAccountScope(scope);
}

function currentAccountRecords(records: OfflineDownloadRecord[]): OfflineDownloadRecord[] {
  return records.filter((record) => isOfflineRecordForAccount(record));
}

function mutationAccountScope(mutation: OfflineMutation): string {
  return mutation.accountScope ? normalizeOfflineAccountScope(mutation.accountScope) : "legacy";
}

function isMutationForCurrentAccount(mutation: OfflineMutation): boolean {
  return mutationAccountScope(mutation) === currentOfflineAccountScope;
}

function currentAccountMutations(mutations: OfflineMutation[]): OfflineMutation[] {
  return mutations.filter(isMutationForCurrentAccount);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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

function canUseRemoteDownloadPreferences(scope = currentOfflineAccountScope): boolean {
  const normalized = normalizeOfflineAccountScope(scope);
  return normalized !== "anonymous" && normalized !== "unauthenticated" && normalized !== "loading";
}

function isNetworkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function isPlayerSongLike(value: unknown): value is PlayerSong {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlayerSong>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.title === "string" &&
    candidate.title.length > 0 &&
    typeof candidate.artist === "string" &&
    candidate.artist.length > 0 &&
    typeof candidate.audioUrl === "string" &&
    candidate.audioUrl.length > 0
  );
}

function normalizeDownloadScopes(value: unknown, songId: string): DownloadScope[] {
  const scopes = Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
    : [];
  if (scopes.length === 0) scopes.push(`song:${songId}`);
  return Array.from(new Set(scopes.map((scope) => scope.trim()))).slice(0, 32) as DownloadScope[];
}

function coerceRemoteOfflineDownload(value: unknown): RemoteOfflineDownload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { song?: unknown; pinnedBy?: unknown; updatedAt?: unknown };
  if (!isPlayerSongLike(candidate.song)) return null;
  return {
    song: candidate.song,
    pinnedBy: normalizeDownloadScopes(candidate.pinnedBy, candidate.song.id),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined,
  };
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

function shouldSkipSpeculativeMediaFetch(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !!(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
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
    const contentLength = Number(cached.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0) return contentLength;
    const blob = await withTimeout(
      cached.clone().blob().catch(() => null),
      DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
      "Reading cached download timed out",
    );
    return blob?.size ?? 0;
  }

  const controller = new AbortController();
  let stalled = false;
  let stallTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const resetStallTimer = () => {
    if (stallTimeoutId) clearTimeout(stallTimeoutId);
    stallTimeoutId = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  };

  resetStallTimer();

  let response: Response;
  try {
    response = await fetch(absoluteUrl, {
      credentials: "include",
      cache: "reload",
      headers: {
        "x-spotify-offline-download": "1",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (stallTimeoutId) clearTimeout(stallTimeoutId);
    if (stalled) throw new Error("Download stalled while connecting");
    throw error;
  }

  if (!response.ok) {
    if (stallTimeoutId) clearTimeout(stallTimeoutId);
    throw new Error(`Download failed with ${response.status}`);
  }

  const totalRaw = Number(response.headers.get("content-length") || 0);
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
  const headers = new Headers(response.headers);
  headers.set("x-spotify-offline-cached-at", String(now()));

  if (!response.body) {
    try {
      const blob = await withTimeout(
        response.blob(),
        DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
        "Download response timed out",
      );
      onProgress?.(blob.size, total);
      await withTimeout(
        cache.put(
          absoluteUrl,
          new Response(blob, {
            status: response.status,
            statusText: response.statusText,
            headers,
          }),
        ),
        DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
        "Saving download timed out",
      );
      return blob.size;
    } finally {
      if (stallTimeoutId) clearTimeout(stallTimeoutId);
    }
  }

  try {
    const cachePromise = cache.put(
      absoluteUrl,
      new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
    cachePromise.catch(() => undefined);
    const reader = response.body.getReader();
    let loaded = 0;
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (stalled) throw new Error("Download stalled before receiving more data");
        throw error;
      }
      const { done, value } = result;
      if (done) break;
      if (!value) continue;
      resetStallTimer();
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }

    await withTimeout(
      cachePromise,
      DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
      "Saving download timed out",
    );
    onProgress?.(loaded, total);
    return loaded;
  } finally {
    if (stallTimeoutId) clearTimeout(stallTimeoutId);
  }
}

async function warmPlaybackUrl(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!sameOriginCacheableUrl(url)) return;
  if (shouldSkipSpeculativeMediaFetch()) return;
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

async function cacheDurableUrlOnce(
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

async function cacheDurableUrl(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await cacheDurableUrlOnce(url, onProgress);
    } catch (error) {
      lastError = error;
      if (attempt >= DOWNLOAD_RETRY_ATTEMPTS) break;
      await sleep(DOWNLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed");
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

async function fetchRemoteDownloadPreferences(scope = currentOfflineAccountScope): Promise<RemoteOfflineDownload[]> {
  if (!canUseRemoteDownloadPreferences(scope) || !isNetworkAvailable()) return [];
  const response = await withTimeout(
    fetch("/api/offline-downloads", {
      credentials: "include",
      cache: "no-store",
    }),
    REMOTE_DOWNLOAD_SYNC_TIMEOUT_MS,
    "Reading saved downloads timed out",
  );
  if (response.status === 401 || response.status === 403) return [];
  if (!response.ok) throw new Error(`Saved downloads failed with ${response.status}`);
  const data = (await response.json().catch(() => ({}))) as { downloads?: unknown };
  if (!Array.isArray(data.downloads)) return [];
  return data.downloads
    .map(coerceRemoteOfflineDownload)
    .filter((download): download is RemoteOfflineDownload => !!download);
}

async function replaceRemoteDownloadPreferences(records: OfflineDownloadRecord[]): Promise<void> {
  if (!canUseRemoteDownloadPreferences() || !isNetworkAvailable()) return;
  const accountScope = currentOfflineAccountScope;
  if (!restoredRemoteDownloadScopes.has(accountScope)) return;
  if (remoteDownloadSyncRunning) return;
  remoteDownloadSyncRunning = true;
  try {
    const items = records
      .filter((record) => record.pinnedBy.length > 0 && canCacheSong(record.song))
      .map((record) => ({
        song: record.song,
        scopes: record.pinnedBy,
      }));
    const response = await withTimeout(
      fetch("/api/offline-downloads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ items }),
      }),
      REMOTE_DOWNLOAD_SYNC_TIMEOUT_MS,
      "Saving download list timed out",
    );
    if (response.status === 401 || response.status === 403) return;
    if (!response.ok) throw new Error(`Saving download list failed with ${response.status}`);
  } catch {
  } finally {
    remoteDownloadSyncRunning = false;
  }
}

async function syncLocalDownloadPreferences(): Promise<void> {
  const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
  await replaceRemoteDownloadPreferences(records);
}

async function deleteRemoteDownloadPreference(payload: { songId?: string; scope?: DownloadScope; clearAll?: boolean }): Promise<void> {
  if (!canUseRemoteDownloadPreferences() || !isNetworkAvailable()) return;
  try {
    const response = await withTimeout(
      fetch("/api/offline-downloads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify(payload),
      }),
      REMOTE_DOWNLOAD_SYNC_TIMEOUT_MS,
      "Removing saved download timed out",
    );
    if (response.status === 401 || response.status === 403) return;
    if (!response.ok) throw new Error(`Removing saved download failed with ${response.status}`);
  } catch {}
}

async function restoreRemoteDownloadPreferences(): Promise<void> {
  if (remoteDownloadRestoreRunning) return;
  const accountScope = currentOfflineAccountScope;
  if (!canUseRemoteDownloadPreferences(accountScope) || !isNetworkAvailable()) return;
  remoteDownloadRestoreRunning = true;
  try {
    const remoteDownloads = await fetchRemoteDownloadPreferences(accountScope);
    restoredRemoteDownloadScopes.add(accountScope);
    if (remoteDownloads.length === 0) return;

    const timestamp = now();
    const existing = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
    const byId = recordsById(existing);
    for (const remoteDownload of remoteDownloads) {
      const { song } = remoteDownload;
      if (!canCacheSong(song)) continue;
      const current = byId[song.id];
      const pinnedBy = normalizeDownloadScopes(
        [...(current?.pinnedBy ?? []), ...remoteDownload.pinnedBy],
        song.id,
      );
      const record: OfflineDownloadRecord = {
        songId: song.id,
        song: current?.song ? { ...current.song, ...song } : song,
        audioUrl: song.audioUrl,
        imageUrl: song.imageUrl,
        lyricsUrl: song.lyricsUrl,
        accountScope,
        status: current?.status === "downloaded" ? "downloaded" : "queued",
        progress: current?.status === "downloaded" ? 1 : current?.progress ?? 0,
        size: current?.size ?? 0,
        error: undefined,
        pinnedBy,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastAccessedAt: current?.lastAccessedAt ?? timestamp,
      };
      byId[song.id] = record;
      await persistRecord(record);
    }
    await useOfflineStore.getState().refreshStorage();
    void processDownloadQueue();
  } catch {
  } finally {
    remoteDownloadRestoreRunning = false;
  }
}

async function restoreThenSyncRemoteDownloadPreferences(): Promise<void> {
  await restoreRemoteDownloadPreferences();
  await syncLocalDownloadPreferences();
}

async function requeueInterruptedDownloadRecords(
  records: OfflineDownloadRecord[],
  force = false,
): Promise<OfflineDownloadRecord[]> {
  const timestamp = now();
  const nextRecords = await Promise.all(
    records.map(async (record) => {
      if (record.status !== "downloading") return record;
      if (!force && timestamp - record.updatedAt < STALE_DOWNLOADING_MS) return record;
      const queued: OfflineDownloadRecord = {
        ...record,
        status: "queued",
        progress: 0,
        error: undefined,
        updatedAt: timestamp,
      };
      await idbPut(DOWNLOAD_STORE, queued).catch(() => undefined);
      return queued;
    }),
  );
  return nextRecords;
}

async function recoverInterruptedDownloads(force = false): Promise<void> {
  if (downloadPumpRunning) return;
  const records = await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []);
  const nextRecords = await requeueInterruptedDownloadRecords(currentAccountRecords(records), force);
  useOfflineStore.setState({ records: recordsById(nextRecords) });
}

async function processDownloadQueue(): Promise<void> {
  if (downloadPumpRunning) return;
  downloadPumpRunning = true;
  try {
    const initialRecords = currentAccountRecords(
      await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []),
    );
    await requeueInterruptedDownloadRecords(initialRecords);
    for (;;) {
      const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE));
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

async function refreshDownloadRecordsForCurrentAccount(): Promise<void> {
  const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
  const nextRecords = await requeueInterruptedDownloadRecords(records, true);
  useOfflineStore.setState({ records: recordsById(nextRecords) });
}

export function setOfflineAccountScope(scope: string | null | undefined): void {
  const nextScope = normalizeOfflineAccountScope(scope);
  if (currentOfflineAccountScope === nextScope) {
    if (useOfflineStore.getState().hydrated) {
      void restoreThenSyncRemoteDownloadPreferences();
    }
    return;
  }
  currentOfflineAccountScope = nextScope;
  writeStoredOfflineAccountScope(nextScope);
  if (!useOfflineStore.getState().hydrated) return;
  void (async () => {
    await refreshDownloadRecordsForCurrentAccount();
    await restoreThenSyncRemoteDownloadPreferences();
    await useOfflineStore.getState().refreshStorage();
    void processDownloadQueue();
    void syncOfflineMutations();
  })();
}

function attachBrowserListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("online", () => {
    useOfflineStore.setState({ online: true });
    void useOfflineStore.getState().syncMutations();
    void restoreThenSyncRemoteDownloadPreferences();
    void recoverInterruptedDownloads();
    void processDownloadQueue();
  });
  window.addEventListener("offline", () => {
    useOfflineStore.setState({ online: false });
  });
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void useOfflineStore.getState().syncMutations();
    void useOfflineStore.getState().refreshStorage();
    void restoreThenSyncRemoteDownloadPreferences();
    void recoverInterruptedDownloads();
    void processDownloadQueue();
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

function snapshotPath(url: string): string {
  try {
    return new URL(url, "http://spotify.local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function snapshotAccountScope(url: string): string {
  try {
    return normalizeOfflineAccountScope(new URL(url, "http://spotify.local").searchParams.get("auth"));
  } catch {
    return "legacy";
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
  const accountScope = mutationAccountScope(mutation);
  await Promise.all(
    snapshots.map(async (snapshot) => {
      if (snapshotAccountScope(snapshot.url) !== accountScope) return;
      const path = snapshotPath(snapshot.url);
      const next = cloneJsonLike(snapshot.data);
      let changed = false;
      if (mutation.type === "like") {
        changed = updateLikedIds(next, mutation.payload.songId, mutation.payload.nextLiked);
        if (path === "/api/liked") {
          changed = updateLikedSongs(next, mutation.payload) || changed;
        }
      } else if (
        mutation.type === "playlist-reorder" &&
        path === `/api/playlist/${encodeURIComponent(mutation.payload.playlistId)}`
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
  return currentAccountMutations(mutations).filter((mutation) => mutation.status !== "syncing").length;
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
    accountScope: getOfflineAccountScope(),
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
      .filter(isMutationForCurrentAccount)
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

export function resolveOfflinePlaybackSong(song: PlayerSong): PlayerSong;
export function resolveOfflinePlaybackSong(song: PlayerSong | null | undefined): PlayerSong | null | undefined;
export function resolveOfflinePlaybackSong(song: PlayerSong | null | undefined): PlayerSong | null | undefined {
  if (!song || isBrowserLocalSong(song) || isOfflinePlaybackSong(song)) return song;
  const record = useOfflineStore.getState().records[song.id];
  if (!isOfflineRecordForAccount(record) || record.status !== "downloaded") return song;

  return preferOfflinePlaybackSong({
    ...record.song,
    ...song,
    album: song.album ?? record.song.album,
    duration: song.duration ?? record.song.duration,
    audioBitDepth: song.audioBitDepth ?? record.song.audioBitDepth,
    audioSampleRate: song.audioSampleRate ?? record.song.audioSampleRate,
    audioUrl: record.audioUrl || record.song.audioUrl || song.audioUrl,
    imageUrl: record.imageUrl || song.imageUrl,
    lyricsUrl: record.lyricsUrl ?? song.lyricsUrl ?? record.song.lyricsUrl,
  });
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
  if (scopedRecords.some((record) => record.status === "queued" || record.status === "downloading")) return "downloading";
  if (scopedRecords.some((record) => record.status === "failed")) return "failed";
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
    const [storedRecords, pendingMutations, storage, persistentStorage] = await Promise.all([
      idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []),
      mutationCount(),
      estimateStorage(),
      requestPersistentStorage(),
    ]);
    const records = await requeueInterruptedDownloadRecords(currentAccountRecords(storedRecords), true);
    set({
      hydrated: true,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      records: recordsById(records),
      pendingMutations,
      storageUsage: storage.usage,
      storageQuota: storage.quota,
      persistentStorage,
    });
    void restoreThenSyncRemoteDownloadPreferences();
    void processDownloadQueue();
    void syncOfflineMutations();
  },
  queueDownloads: async (songs, scope) => {
    await get().hydrate();
    const timestamp = now();
    const accountScope = getOfflineAccountScope();
    const existing = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
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
        accountScope,
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
    void restoreThenSyncRemoteDownloadPreferences();
    void processDownloadQueue();
    await get().refreshStorage();
  },
  removeDownload: async (songId) => {
    const record = await idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, songId).catch(() => undefined);
    if (record && !isOfflineRecordForAccount(record)) return;
    if (record) await deleteCachedUrls(songAssetUrls(record.song));
    await idbDelete(DOWNLOAD_STORE, songId).catch(() => undefined);
    set((state) => {
      const records = { ...state.records };
      delete records[songId];
      return { records };
    });
    void deleteRemoteDownloadPreference({ songId });
    void syncLocalDownloadPreferences();
    await get().refreshStorage();
  },
  removeScope: async (scope) => {
    const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
    for (const record of records) {
      if (!record.pinnedBy.includes(scope)) continue;
      const pinnedBy = record.pinnedBy.filter((item) => item !== scope);
      if (pinnedBy.length === 0) {
        await get().removeDownload(record.songId);
      } else {
        await persistRecord({ ...record, pinnedBy, updatedAt: now() });
      }
    }
    void deleteRemoteDownloadPreference({ scope });
    void syncLocalDownloadPreferences();
    await get().refreshStorage();
  },
  retryFailedDownloads: async () => {
    const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
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
    const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
    await Promise.all(
      records.map(async (record) => {
        await deleteCachedUrls(songAssetUrls(record.song));
        await idbDelete(DOWNLOAD_STORE, record.songId).catch(() => undefined);
      }),
    );
    set({ records: {} });
    void deleteRemoteDownloadPreference({ clearAll: true });
    void syncLocalDownloadPreferences();
    await get().refreshStorage();
  },
  clearPlaybackCache: async () => {
    await clearCache(OFFLINE_PLAYBACK_CACHE);
    await get().refreshStorage();
  },
  prefetchUpcoming: async (queue, currentIndex) => {
    if (prefetchRunning) return;
    if (shouldSkipSpeculativeMediaFetch()) return;
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
