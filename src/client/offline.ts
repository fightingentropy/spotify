"use client";

import { create } from "zustand";
import type { PlayerSong } from "@/types/player";
import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { isOfflinePlaybackSong, preferOfflinePlaybackSong } from "@/lib/player-song";
import {
  deleteNativeOfflineFiles,
  isNativeOfflineStorageAvailable,
  nativeOfflineAssetWebUrl,
  saveNativeOfflineAsset,
  verifyNativeOfflineAsset,
  type NativeOfflineAsset,
  type NativeOfflineAssetKind,
  type NativeOfflineFiles,
} from "@/client/capacitor-offline";

export type DownloadScope = "home" | "liked" | `playlist:${string}` | `song:${string}`;
export type OfflineDownloadStatus = "queued" | "downloading" | "downloaded" | "failed";

export type OfflineDownloadRecord = {
  songId: string;
  song: PlayerSong;
  audioUrl: string;
  imageUrl: string;
  lyricsUrl?: string;
  nativeFiles?: NativeOfflineFiles;
  accountScope?: string;
  deviceId?: string;
  status: OfflineDownloadStatus;
  progress: number;
  size: number;
  error?: string;
  pinnedBy: DownloadScope[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  verifiedAt?: number;
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
export type OfflineVerificationStatus = "idle" | "checking" | "ok" | "repair-needed" | "failed";

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
  nativeStorage: boolean;
  verificationStatus: OfflineVerificationStatus;
  verificationCheckedAt: number | null;
  verifiedDownloads: number;
  missingDownloads: number;
  verificationError: string | null;
  hydrate: () => Promise<void>;
  queueDownloads: (songs: PlayerSong[], scope: DownloadScope) => Promise<void>;
  removeDownload: (songId: string) => Promise<void>;
  removeScope: (scope: DownloadScope) => Promise<void>;
  retryFailedDownloads: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  clearPlaybackCache: () => Promise<void>;
  verifyDownloads: () => Promise<void>;
  prefetchUpcoming: (queue: PlayerSong[], currentIndex: number) => Promise<void>;
  syncMutations: () => Promise<void>;
  refreshStorage: () => Promise<void>;
};

const DB_NAME = "spotify_offline_v1";
const DB_VERSION = 3;
const LEGACY_DOWNLOAD_STORE = "downloads";
const DOWNLOAD_STORE = "downloads_v2";
// Exported so offline-api-snapshots.ts shares the exact store name and a single
// open/upgrade path (see openOfflineDb) — a DB_VERSION bump can't desync the two.
export const API_SNAPSHOT_STORE = "api_snapshots";
const MUTATION_STORE = "mutations";
const DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT = "accountScope_updatedAt";
const DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT = "accountScope_status_updatedAt";
export const OFFLINE_MEDIA_CACHE = "spotify-media-v1";
export const OFFLINE_PLAYBACK_CACHE = "spotify-playback-v1";
const OFFLINE_ACCOUNT_SCOPE_STORAGE_KEY = "spotify_offline_account_scope";
const OFFLINE_DEVICE_ID_STORAGE_KEY = "spotify_offline_device_id";
const OFFLINE_SYNC_EVENT = "spotify-offline-sync";
const PLAYBACK_WARM_BYTES = 512 * 1024;
const PLAYBACK_WARM_TIMEOUT_MS = 4_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_CACHE_WRITE_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRY_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_000;
const STALE_DOWNLOADING_MS = 2 * 60 * 1_000;
const STALE_SYNCING_MUTATION_MS = 60 * 1_000;
const MUTATION_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MUTATION_ATTEMPTS = 5;
const HYDRATE_DOWNLOAD_RECORD_LIMIT = 160;
const MAX_DOWNLOAD_RECORDS_IN_MEMORY = 420;

let dbPromise: Promise<IDBDatabase> | null = null;
let hydrateStarted = false;
let listenersAttached = false;
let downloadPumpRunning = false;
let downloadPumpRerunRequested = false;
let syncRunning = false;
let prefetchRunning = false;
const priorityDownloadQueue: string[] = [];
let currentOfflineAccountScope = readStoredOfflineAccountScope();
let currentOfflineDeviceId = readStoredOfflineDeviceId();

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

function downloadRecordKey(
  songId: string,
  scope: string | null | undefined = currentOfflineAccountScope,
): IDBValidKey {
  return [normalizeOfflineAccountScope(scope), songId];
}

function scopedDownloadRecord(
  record: OfflineDownloadRecord,
  fallbackScope: string | null | undefined = currentOfflineAccountScope,
): OfflineDownloadRecord {
  return {
    ...record,
    accountScope: normalizeOfflineAccountScope(record.accountScope ?? fallbackScope),
  };
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

function readStoredOfflineDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const stored = localStorage.getItem(OFFLINE_DEVICE_ID_STORAGE_KEY);
    if (stored && stored.length > 0) return stored;
    const next = `device:${randomId()}`;
    localStorage.setItem(OFFLINE_DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "browser";
  }
}

function getOfflineDeviceId(): string {
  if (!currentOfflineDeviceId) currentOfflineDeviceId = readStoredOfflineDeviceId();
  return currentOfflineDeviceId;
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

function scheduleBackgroundOfflineWork(callback: () => void): void {
  if (typeof window === "undefined") {
    callback();
    return;
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  };
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: 4_000 });
    return;
  }
  window.setTimeout(callback, 1_000);
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasCacheStorage(): boolean {
  return typeof caches !== "undefined";
}

function ensureDownloadIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains(DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT)) {
    store.createIndex(DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT, ["accountScope", "updatedAt"]);
  }
  if (!store.indexNames.contains(DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT)) {
    store.createIndex(DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT, ["accountScope", "status", "updatedAt"]);
  }
}

function rawStoreCount(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Failed to count ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to count ${storeName}`));
  });
}

function rawStoreGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error(`Failed to read ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to read ${storeName}`));
    tx.onabort = () => reject(tx.error ?? new Error(`Aborted reading ${storeName}`));
  });
}

function rawStorePutAll<T>(db: IDBDatabase, storeName: string, values: T[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const value of values) store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`));
    tx.onabort = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`));
  });
}

async function migrateLegacyDownloadStore(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains(LEGACY_DOWNLOAD_STORE) || !db.objectStoreNames.contains(DOWNLOAD_STORE)) return;
  if ((await rawStoreCount(db, DOWNLOAD_STORE).catch(() => 0)) > 0) return;
  const legacyRecords = await rawStoreGetAll<OfflineDownloadRecord>(db, LEGACY_DOWNLOAD_STORE).catch(() => []);
  const migrated = legacyRecords
    .filter((record) => record && typeof record.songId === "string" && record.songId.length > 0)
    .map((record) => scopedDownloadRecord(record));
  if (migrated.length > 0) await rawStorePutAll(db, DOWNLOAD_STORE, migrated);
}

export function openOfflineDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("IndexedDB is not available"));
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let downloadStore: IDBObjectStore | null = null;
      if (!db.objectStoreNames.contains(DOWNLOAD_STORE)) {
        downloadStore = db.createObjectStore(DOWNLOAD_STORE, { keyPath: ["accountScope", "songId"] });
      } else {
        downloadStore = request.transaction?.objectStore(DOWNLOAD_STORE) ?? null;
      }
      if (downloadStore) ensureDownloadIndexes(downloadStore);
      if (!db.objectStoreNames.contains(API_SNAPSHOT_STORE)) {
        db.createObjectStore(API_SNAPSHOT_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(MUTATION_STORE)) {
        db.createObjectStore(MUTATION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      migrateLegacyDownloadStore(db)
        .catch(() => undefined)
        .then(() => resolve(db));
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("Failed to open offline database"));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("Offline database upgrade is blocked by another tab"));
    };
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
    tx.onabort = () => reject(tx.error ?? new Error(`Aborted reading ${storeName}`));
  });
}

type DownloadRecordPageOptions = {
  scope?: string | null;
  status?: OfflineDownloadStatus;
  offset?: number;
  limit?: number;
  direction?: IDBCursorDirection;
};

export type OfflineDownloadRecordPage = {
  records: OfflineDownloadRecord[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

function downloadRangeForAccount(
  scope: string,
  status?: OfflineDownloadStatus,
): IDBKeyRange {
  const normalizedScope = normalizeOfflineAccountScope(scope);
  return status
    ? IDBKeyRange.bound(
        [normalizedScope, status, 0],
        [normalizedScope, status, Number.MAX_SAFE_INTEGER],
      )
    : IDBKeyRange.bound(
        [normalizedScope, 0],
        [normalizedScope, Number.MAX_SAFE_INTEGER],
      );
}

async function countDownloadRecordsForAccount(options: DownloadRecordPageOptions = {}): Promise<number> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_STORE, "readonly");
    const store = tx.objectStore(DOWNLOAD_STORE);
    const index = store.index(
      options.status ? DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT : DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT,
    );
    const request = index.count(
      downloadRangeForAccount(options.scope ?? currentOfflineAccountScope, options.status),
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to count downloads"));
    tx.onerror = () => reject(tx.error ?? new Error("Failed to count downloads"));
    tx.onabort = () => reject(tx.error ?? new Error("Aborted counting downloads"));
  });
}

async function readDownloadRecordsForAccount(
  options: DownloadRecordPageOptions = {},
): Promise<OfflineDownloadRecordPage> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const direction = options.direction ?? "prev";
  const scope = options.scope ?? currentOfflineAccountScope;

  const db = await openOfflineDb();
  const total = await countDownloadRecordsForAccount({ scope, status: options.status });
  const records = await new Promise<OfflineDownloadRecord[]>((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_STORE, "readonly");
    const store = tx.objectStore(DOWNLOAD_STORE);
    const index = store.index(
      options.status ? DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT : DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT,
    );
    const request = index.openCursor(downloadRangeForAccount(scope, options.status), direction);
    const page: OfflineDownloadRecord[] = [];
    let skipped = 0;

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || page.length >= limit) {
        resolve(page);
        return;
      }
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }

      const record = cursor.value as OfflineDownloadRecord;
      if (isOfflineRecordForAccount(record, scope)) page.push(record);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to read downloads"));
    tx.onerror = () => reject(tx.error ?? new Error("Failed to read downloads"));
    tx.onabort = () => reject(tx.error ?? new Error("Aborted reading downloads"));
  });

  return {
    records,
    total,
    offset,
    limit,
    hasMore: offset + records.length < total,
  };
}

export async function readDownloadedRecordsPage(options: Omit<DownloadRecordPageOptions, "status"> = {}): Promise<OfflineDownloadRecordPage> {
  return readDownloadRecordsForAccount({ ...options, status: "downloaded" });
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error(`Failed to read ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to read ${storeName}`));
    tx.onabort = () => reject(tx.error ?? new Error(`Aborted reading ${storeName}`));
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
    tx.onabort = () => reject(tx.error ?? new Error(`Failed to delete from ${storeName}`));
  });
}

function recordsById(records: OfflineDownloadRecord[]): Record<string, OfflineDownloadRecord> {
  const map: Record<string, OfflineDownloadRecord> = {};
  for (const record of records) {
    const scoped = scopedDownloadRecord(record);
    map[scoped.songId] = scoped;
  }
  return map;
}

function capRecordsInMemory(records: Record<string, OfflineDownloadRecord>): Record<string, OfflineDownloadRecord> {
  const values = Object.values(records);
  if (values.length <= MAX_DOWNLOAD_RECORDS_IN_MEMORY) return records;
  return recordsById(
    values
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_DOWNLOAD_RECORDS_IN_MEMORY),
  );
}

export function mergeOfflineDownloadRecords(records: OfflineDownloadRecord[]): void {
  if (records.length === 0) return;
  useOfflineStore.setState((state) => ({
    records: capRecordsInMemory({
      ...state.records,
      ...recordsById(records),
    }),
  }));
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isNetworkUnavailable(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isTransientNetworkError(error: unknown): boolean {
  if (isNetworkUnavailable()) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|load failed|network|offline|cancelled|canceled|timed out|abort/i.test(message);
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
  if (navigator.onLine === false) return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !!(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
}

function songAssetUrlEntries(song: PlayerSong): Array<{ kind: NativeOfflineAssetKind; url: string }> {
  const entries: Array<{ kind: NativeOfflineAssetKind; url?: string }> = [
    { kind: "audio", url: song.audioUrl },
    { kind: "image", url: song.imageUrl },
    { kind: "lyrics", url: song.lyricsUrl },
  ];
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (!entry.url || !sameOriginCacheableUrl(entry.url)) return [];
    const url = resolveUrl(entry.url);
    if (seen.has(url)) return [];
    seen.add(url);
    return [{ kind: entry.kind, url }];
  });
}

function songAssetUrls(song: PlayerSong): string[] {
  return songAssetUrlEntries(song).map((entry) => entry.url);
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

async function pruneRuntimeCaches(): Promise<void> {
  if (!hasCacheStorage()) return;
  const cacheNames = (await caches.keys()).filter((name) => /^spotify-v\d+-runtime$/.test(name));
  await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName).catch(() => false)));
}

async function cacheDurableUrlOnce(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<number> {
  try {
    return await cacheUrl(url, OFFLINE_MEDIA_CACHE, onProgress);
  } catch (error) {
    // Only evict cached media under genuine quota pressure. Pruning on any error
    // (timeouts, transient network failures) needlessly destroyed half the
    // playback cache and all runtime caches.
    if (!(error instanceof DOMException && error.name === "QuotaExceededError")) {
      throw error;
    }
    await prunePlaybackCache();
    await pruneRuntimeCaches();
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

// Native (iOS/Android) downloads bypass the Cache API staging step entirely:
// the webview origin is capacitor://localhost and the Cache API rejects
// non-http(s) request URLs, so cache.put can never persist anything there.
// Instead, fetch the blob (the patched window.fetch rewrites the URL to the
// remote origin) and hand it straight to the native filesystem.
async function fetchDownloadBlob(
  absoluteUrl: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Blob> {
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

  try {
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
      if (stalled) throw new Error("Download stalled while connecting");
      throw error;
    }
    if (!response.ok) throw new Error(`Download failed with ${response.status}`);

    const totalRaw = Number(response.headers.get("content-length") || 0);
    const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
    const contentType = response.headers.get("content-type") || "";

    if (!response.body) {
      const blob = await withTimeout(
        response.blob(),
        DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
        "Download response timed out",
      );
      onProgress?.(blob.size, total);
      return blob;
    }

    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
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
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
    return new Blob(chunks, contentType ? { type: contentType } : undefined);
  } finally {
    if (stallTimeoutId) clearTimeout(stallTimeoutId);
  }
}

async function downloadAssetToNative(options: {
  songId: string;
  kind: NativeOfflineAssetKind;
  url: string;
  onProgress?: (loaded: number, total: number | null) => void;
}): Promise<{ asset: NativeOfflineAsset; bytes: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const blob = await fetchDownloadBlob(options.url, options.onProgress);
      if (blob.size <= 0) throw new Error("Downloaded media file is empty");
      const asset = await saveNativeOfflineAsset({
        songId: options.songId,
        kind: options.kind,
        url: options.url,
        blob,
      });
      if (!asset) throw new Error("Native offline storage is not available");
      return { asset, bytes: blob.size };
    } catch (error) {
      lastError = error;
      if (attempt >= DOWNLOAD_RETRY_ATTEMPTS) break;
      await sleep(DOWNLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed");
}

async function readCachedAssetBlob(url: string): Promise<Blob | null> {
  if (!hasCacheStorage()) return null;
  const absoluteUrl = resolveUrl(url);
  const cache = await caches.open(OFFLINE_MEDIA_CACHE);
  const response = await cache.match(absoluteUrl);
  if (!response?.ok) return null;
  return response.blob().catch(() => null);
}

async function saveCachedAssetToNative(options: {
  songId: string;
  kind: NativeOfflineAssetKind;
  url: string;
}): Promise<NativeOfflineAsset | null> {
  if (!isNativeOfflineStorageAvailable()) return null;
  const blob = await readCachedAssetBlob(options.url);
  if (!blob || blob.size <= 0) throw new Error("Cached media file is empty");
  return saveNativeOfflineAsset({
    songId: options.songId,
    kind: options.kind,
    url: options.url,
    blob,
  });
}

async function verifyCachedAsset(url: string): Promise<boolean> {
  if (!hasCacheStorage()) return false;
  try {
    const cache = await caches.open(OFFLINE_MEDIA_CACHE);
    const response = await cache.match(resolveUrl(url));
    if (!response?.ok) return false;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0) return true;
    const blob = await withTimeout(
      response.clone().blob().catch(() => null),
      DOWNLOAD_CACHE_WRITE_TIMEOUT_MS,
      "Reading cached download timed out",
    );
    return !!blob && blob.size > 0;
  } catch {
    return false;
  }
}

async function verifyOrRepairRecord(record: OfflineDownloadRecord): Promise<{
  ok: boolean;
  record: OfflineDownloadRecord;
}> {
  const entries = songAssetUrlEntries(record.song);
  if (entries.length === 0) return { ok: false, record };

  const nativeAvailable = isNativeOfflineStorageAvailable();
  let nextNativeFiles = record.nativeFiles;
  let repairedNativeFiles = false;

  for (const entry of entries) {
    if (nativeAvailable) {
      const nativeAsset = nextNativeFiles?.[entry.kind];
      if (await verifyNativeOfflineAsset(nativeAsset)) continue;
      if (await verifyCachedAsset(entry.url)) {
        const repairedAsset = await saveCachedAssetToNative({
          songId: record.songId,
          kind: entry.kind,
          url: entry.url,
        });
        if (repairedAsset) {
          nextNativeFiles = { ...(nextNativeFiles ?? {}), [entry.kind]: repairedAsset };
          repairedNativeFiles = true;
          continue;
        }
      }
      return { ok: false, record };
    }

    if (!(await verifyCachedAsset(entry.url))) {
      return { ok: false, record };
    }
  }

  if (repairedNativeFiles) {
    const nextRecord = {
      ...record,
      nativeFiles: nextNativeFiles,
      verifiedAt: now(),
      error: undefined,
      updatedAt: now(),
    };
    await persistRecord(nextRecord);
    return { ok: true, record: nextRecord };
  }

  const verifiedRecord = {
    ...record,
    verifiedAt: now(),
  };
  await persistRecord(verifiedRecord).catch(() => undefined);
  return { ok: true, record: verifiedRecord };
}

function setRecordState(record: OfflineDownloadRecord): void {
  const scoped = scopedDownloadRecord(record);
  useOfflineStore.setState((state) => ({
    records: capRecordsInMemory({
      ...state.records,
      [scoped.songId]: scoped,
    }),
  }));
}

async function persistRecord(record: OfflineDownloadRecord): Promise<void> {
  const scoped = scopedDownloadRecord(record);
  await idbPut(DOWNLOAD_STORE, scoped);
  setRecordState(scoped);
}

// Persist the pump's terminal result without clobbering concurrent edits.
// queueDownloads may have added a new scope to pinnedBy (or refreshed `song`)
// while the download was in flight; re-read the latest record and merge the
// completion patch so those changes survive the pump's stale `working` snapshot.
async function persistDownloadResult(
  working: OfflineDownloadRecord,
  patch: Partial<OfflineDownloadRecord>,
): Promise<OfflineDownloadRecord> {
  const latest = await idbGet<OfflineDownloadRecord>(
    DOWNLOAD_STORE,
    downloadRecordKey(working.songId, working.accountScope),
  ).catch(() => undefined);
  const base = isOfflineRecordForAccount(latest, working.accountScope) ? latest : working;
  const pinnedBy = Array.from(new Set([...base.pinnedBy, ...working.pinnedBy]));
  const merged: OfflineDownloadRecord = {
    ...working,
    ...base,
    ...patch,
    pinnedBy,
    nativeFiles: patch.nativeFiles ?? working.nativeFiles ?? base.nativeFiles,
  };
  await persistRecord(merged);
  return merged;
}

async function readDownloadRecordsByStatus(
  status: OfflineDownloadStatus,
  limit: number,
  direction: IDBCursorDirection = "prev",
): Promise<OfflineDownloadRecord[]> {
  return (
    await readDownloadRecordsForAccount({
      status,
      limit,
      direction,
    }).catch(() => ({
      records: [] as OfflineDownloadRecord[],
      total: 0,
      offset: 0,
      limit,
      hasMore: false,
    }))
  ).records;
}

async function readFirstDownloadRecordByStatus(
  status: OfflineDownloadStatus,
  direction: IDBCursorDirection = "next",
): Promise<OfflineDownloadRecord | null> {
  const records = await readDownloadRecordsByStatus(status, 1, direction);
  return records[0] ?? null;
}

async function readHydrateDownloadRecords(): Promise<OfflineDownloadRecord[]> {
  const [active, failed, downloaded] = await Promise.all([
    Promise.all([
      readDownloadRecordsByStatus("downloading", 40, "next"),
      readDownloadRecordsByStatus("queued", 40, "next"),
    ]).then((groups) => groups.flat()),
    readDownloadRecordsByStatus("failed", 40, "prev"),
    readDownloadRecordsByStatus("downloaded", HYDRATE_DOWNLOAD_RECORD_LIMIT, "prev"),
  ]);
  const byId = recordsById([...active, ...failed, ...downloaded]);
  return Object.values(byId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DOWNLOAD_RECORDS_IN_MEMORY);
}

function canProcessDownloadOnThisDevice(record: OfflineDownloadRecord): boolean {
  return record.deviceId === getOfflineDeviceId();
}

function enqueuePriorityDownloadIds(songIds: string[]): void {
  for (const songId of songIds) {
    const existingIndex = priorityDownloadQueue.indexOf(songId);
    if (existingIndex >= 0) priorityDownloadQueue.splice(existingIndex, 1);
    priorityDownloadQueue.push(songId);
  }
}

async function readPriorityQueuedDownloadRecord(): Promise<OfflineDownloadRecord | null> {
  while (priorityDownloadQueue.length > 0) {
    const songId = priorityDownloadQueue.shift();
    if (!songId) continue;
    const record = await idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, downloadRecordKey(songId)).catch(() => undefined);
    if (!record || record.status !== "queued" || !isOfflineRecordForAccount(record)) continue;
    return record;
  }
  return null;
}

async function readNextQueuedDownloadRecord(): Promise<OfflineDownloadRecord | null> {
  return (await readPriorityQueuedDownloadRecord()) ?? readFirstDownloadRecordByStatus("queued", "prev");
}

async function quarantineForeignQueuedDownloadRecord(
  record: OfflineDownloadRecord,
): Promise<OfflineDownloadRecord> {
  const quarantined: OfflineDownloadRecord = {
    ...record,
    status: "failed",
    progress: 0,
    error: "Download was queued on another device. Tap download to save it here.",
    updatedAt: now(),
  };
  await idbPut(DOWNLOAD_STORE, scopedDownloadRecord(quarantined)).catch(() => undefined);
  return quarantined;
}

async function requeueInterruptedDownloadRecords(
  records: OfflineDownloadRecord[],
  force = false,
): Promise<OfflineDownloadRecord[]> {
  const timestamp = now();
  const nextRecords = await Promise.all(
    records.map(async (record) => {
      if (
        (record.status === "queued" || record.status === "downloading") &&
        !canProcessDownloadOnThisDevice(record)
      ) {
        return quarantineForeignQueuedDownloadRecord(record);
      }
      if (record.status !== "downloading") return record;
      if (!force && timestamp - record.updatedAt < STALE_DOWNLOADING_MS) return record;
      const queued: OfflineDownloadRecord = {
        ...record,
        status: "queued",
        progress: 0,
        error: undefined,
        updatedAt: timestamp,
      };
      await idbPut(DOWNLOAD_STORE, scopedDownloadRecord(queued)).catch(() => undefined);
      return queued;
    }),
  );
  return nextRecords;
}

async function recoverInterruptedDownloads(force = false): Promise<void> {
  if (downloadPumpRunning) return;
  const records = await readDownloadRecordsByStatus("downloading", 80, "next");
  const nextRecords = await requeueInterruptedDownloadRecords(records, force);
  mergeOfflineDownloadRecords(nextRecords);
}

async function processDownloadQueue(): Promise<void> {
  if (downloadPumpRunning) {
    downloadPumpRerunRequested = true;
    return;
  }
  if (isNetworkUnavailable()) return;
  downloadPumpRunning = true;
  try {
    await requeueInterruptedDownloadRecords(await readDownloadRecordsByStatus("downloading", 80, "next"));
    let quarantinedForeignQueuedRecords = 0;
    for (;;) {
      const record = await readNextQueuedDownloadRecord();
      if (!record) break;
      if (isNetworkUnavailable()) break;
      if (!canProcessDownloadOnThisDevice(record)) {
        const quarantined = await quarantineForeignQueuedDownloadRecord(record);
        setRecordState(quarantined);
        quarantinedForeignQueuedRecords += 1;
        if (quarantinedForeignQueuedRecords >= 20) break;
        continue;
      }

      let working: OfflineDownloadRecord = {
        ...record,
        status: "downloading",
        progress: 0,
        error: undefined,
        updatedAt: now(),
      };
      await persistRecord(working);

      try {
        const assetEntries = songAssetUrlEntries(working.song);
        if (assetEntries.length === 0) throw new Error("No cacheable media URLs for this song");

        let completedAssets = 0;
        let totalBytes = 0;
        let nativeFiles: NativeOfflineFiles | undefined = working.nativeFiles;
        for (const asset of assetEntries) {
          const { kind, url } = asset;
          const onProgress = (loaded: number, total: number | null) => {
            const assetProgress = total ? Math.min(1, loaded / total) : loaded > 0 ? 0.5 : 0;
            working = {
              ...working,
              progress: Math.min(0.98, (completedAssets + assetProgress) / assetEntries.length),
              updatedAt: now(),
            };
            setRecordState(working);
          };
          let bytes: number;
          if (isNativeOfflineStorageAvailable()) {
            const result = await downloadAssetToNative({
              songId: working.songId,
              kind,
              url,
              onProgress,
            });
            nativeFiles = { ...(nativeFiles ?? {}), [kind]: result.asset };
            bytes = result.bytes;
          } else {
            bytes = await cacheDurableUrl(url, onProgress);
            const nativeAsset = await saveCachedAssetToNative({
              songId: working.songId,
              kind,
              url,
            });
            if (nativeAsset) {
              nativeFiles = { ...(nativeFiles ?? {}), [kind]: nativeAsset };
            }
          }
          completedAssets += 1;
          totalBytes += bytes;
          working = {
            ...working,
            nativeFiles,
            progress: Math.min(0.98, completedAssets / assetEntries.length),
            size: totalBytes,
            updatedAt: now(),
          };
          setRecordState(working);
        }

        working = await persistDownloadResult(working, {
          nativeFiles,
          status: "downloaded",
          progress: 1,
          size: totalBytes,
          error: undefined,
          updatedAt: now(),
          lastAccessedAt: now(),
          verifiedAt: now(),
        });
      } catch (error) {
        const waitingForNetwork = isTransientNetworkError(error);
        working = await persistDownloadResult(working, {
          status: waitingForNetwork ? "queued" : "failed",
          progress: waitingForNetwork ? 0 : working.progress,
          error: waitingForNetwork
            ? "Waiting for connection"
            : error instanceof Error
              ? error.message
              : "Download failed",
          updatedAt: now(),
        });
        if (waitingForNetwork) break;
      }

      await useOfflineStore.getState().refreshStorage();
    }
  } finally {
    downloadPumpRunning = false;
    if (downloadPumpRerunRequested && !isNetworkUnavailable()) {
      downloadPumpRerunRequested = false;
      void processDownloadQueue();
    }
  }
}

async function refreshDownloadRecordsForCurrentAccount(): Promise<void> {
  const records = await readHydrateDownloadRecords();
  const nextRecords = await requeueInterruptedDownloadRecords(records, true);
  useOfflineStore.setState({ records: capRecordsInMemory(recordsById(nextRecords)) });
}

export function setOfflineAccountScope(scope: string | null | undefined): void {
  const nextScope = normalizeOfflineAccountScope(scope);
  if (currentOfflineAccountScope === nextScope) return;
  currentOfflineAccountScope = nextScope;
  writeStoredOfflineAccountScope(nextScope);
  if (!useOfflineStore.getState().hydrated) return;
  void (async () => {
    await refreshDownloadRecordsForCurrentAccount();
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
    void recoverInterruptedDownloads();
    void processDownloadQueue();
  });
}

// NOTE: The public readOfflineApiSnapshot / writeOfflineApiSnapshot /
// removeOfflineApiSnapshots helpers live in offline-api-snapshots.ts (the module
// api.ts imports). The duplicates that used to live here were unused and have been
// removed to avoid a second, drift-prone copy of the snapshot logic.

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

// Mutations persisted as "syncing" before performMutation runs are stranded forever
// if the tab crashes mid-sync. Requeue stale ones so they get retried, mirroring
// requeueInterruptedDownloadRecords for downloads.
async function requeueStaleSyncingMutations(mutations: OfflineMutation[]): Promise<OfflineMutation[]> {
  const timestamp = now();
  return Promise.all(
    mutations.map(async (mutation) => {
      if (mutation.status !== "syncing") return mutation;
      if (timestamp - mutation.updatedAt < STALE_SYNCING_MUTATION_MS) return mutation;
      const requeued = {
        ...mutation,
        status: "queued" as const,
        updatedAt: timestamp,
      } as OfflineMutation;
      await idbPut(MUTATION_STORE, requeued).catch(() => undefined);
      return requeued;
    }),
  );
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

async function mutationFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MUTATION_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function performMutation(mutation: OfflineMutation): Promise<void> {
  if (mutation.type === "like") {
    const response = await mutationFetch("/api/likes", {
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
    const response = await mutationFetch(`/api/playlist/${encodeURIComponent(mutation.payload.playlistId)}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songIds: mutation.payload.songIds }),
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw Object.assign(new Error(`Request failed with ${response.status}`), { status: response.status });
    return;
  }

  const metaResponse = await mutationFetch(`/api/songs/${encodeURIComponent(mutation.payload.songId)}`, {
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
    const assetResponse = await mutationFetch(`/api/songs/${encodeURIComponent(mutation.payload.songId)}/assets`, {
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
  try {
    const recovered = await requeueStaleSyncingMutations(
      currentAccountMutations(await idbGetAll<OfflineMutation>(MUTATION_STORE)),
    );
    // Recovered mutations are now "queued", so the pending count picks them up again.
    await refreshMutationCount();
    const mutations = recovered
      .filter((mutation) => mutation.status !== "syncing")
      // A permanently-rejected mutation (e.g. a 400) that has exhausted its retries
      // stays terminally "failed" and is no longer re-synced automatically.
      .filter((mutation) => !(mutation.status === "failed" && mutation.attempts >= MAX_MUTATION_ATTEMPTS))
      .sort((left, right) => left.createdAt - right.createdAt);

    if (mutations.length === 0) {
      setMutationStatus("idle");
      await refreshMutationCount();
      return;
    }

    // Only flip the visible status once there is real work: every app launch
    // runs this sync, and marking it "syncing" before the empty check made the
    // status pill flash at the top on each cold start.
    setMutationStatus("syncing");
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
        const reachedAttemptCap = nextStatus === "failed" && syncing.attempts >= MAX_MUTATION_ATTEMPTS;
        const baseError = error instanceof Error ? error.message : "Sync failed";
        const failed = {
          ...syncing,
          status: nextStatus,
          error: reachedAttemptCap ? `${baseError} (gave up after ${syncing.attempts} attempts)` : baseError,
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
  return resolveOfflineDownloadRecordSong(record, song);
}

export function resolveOfflineDownloadRecordSong(
  record: OfflineDownloadRecord,
  song: PlayerSong = record.song,
): PlayerSong {
  const nativeAudioUrl = nativeOfflineAssetWebUrl(record.nativeFiles?.audio);
  if (nativeAudioUrl) {
    return {
      ...record.song,
      ...song,
      source: "offline",
      album: song.album ?? record.song.album,
      duration: song.duration ?? record.song.duration,
      audioBitDepth: song.audioBitDepth ?? record.song.audioBitDepth,
      audioSampleRate: song.audioSampleRate ?? record.song.audioSampleRate,
      audioUrl: nativeAudioUrl,
      imageUrl: nativeOfflineAssetWebUrl(record.nativeFiles?.image) ?? record.imageUrl ?? song.imageUrl,
      lyricsUrl: nativeOfflineAssetWebUrl(record.nativeFiles?.lyrics) ?? record.lyricsUrl ?? song.lyricsUrl ?? record.song.lyricsUrl,
    };
  }
  if (isNativeOfflineStorageAvailable()) return song;

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

function scopeDownloadStateFromRecords(
  scopedRecords: OfflineDownloadRecord[],
  cacheableCount: number,
  scope: DownloadScope,
): OfflineDownloadStatus | "partial" | "none" {
  const pinned = scopedRecords.filter((record) => record.pinnedBy.includes(scope));
  if (cacheableCount === 0) return "none";
  if (pinned.length === 0) return "none";
  if (pinned.some((record) => record.status === "queued" || record.status === "downloading")) return "downloading";
  if (pinned.some((record) => record.status === "failed")) return "failed";
  if (pinned.length === cacheableCount && pinned.every((record) => record.status === "downloaded")) {
    return "downloaded";
  }
  return "partial";
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
    .filter((record): record is OfflineDownloadRecord => !!record);
  return scopeDownloadStateFromRecords(scopedRecords, cacheableSongs.length, scope);
}

// Authoritative scope state read straight from IndexedDB. The in-memory `records`
// map is capped (HYDRATE_DOWNLOAD_RECORD_LIMIT / MAX_DOWNLOAD_RECORDS_IN_MEMORY), so
// for scopes with more songs than the cap the synchronous selector can report a
// fully-downloaded collection as "partial"/"none". Reading per-song from IDB avoids
// that without loading the whole store.
export async function readScopeDownloadState(
  songs: PlayerSong[],
  scope: DownloadScope,
): Promise<OfflineDownloadStatus | "partial" | "none"> {
  const cacheableSongs = songs.filter(canCacheSong);
  if (cacheableSongs.length === 0) return "none";
  if (!hasIndexedDb()) return getScopeDownloadState(useOfflineStore.getState().records, songs, scope);
  const records = await Promise.all(
    cacheableSongs.map((song) =>
      idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, downloadRecordKey(song.id)).catch(() => undefined),
    ),
  );
  const scopedRecords = records.filter(
    (record): record is OfflineDownloadRecord => isOfflineRecordForAccount(record),
  );
  return scopeDownloadStateFromRecords(scopedRecords, cacheableSongs.length, scope);
}

// Total bytes of every downloaded record for the current account, read from IDB so
// the OfflineSettings total stays correct beyond the in-memory record cap.
export async function readDownloadedBytesTotal(scope: string = currentOfflineAccountScope): Promise<number> {
  if (!hasIndexedDb()) {
    return Object.values(useOfflineStore.getState().records).reduce(
      (total, record) => total + (record.status === "downloaded" ? record.size : 0),
      0,
    );
  }
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_STORE, "readonly");
    const store = tx.objectStore(DOWNLOAD_STORE);
    const index = store.index(DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT);
    const request = index.openCursor(downloadRangeForAccount(scope, "downloaded"));
    let total = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(total);
        return;
      }
      const record = cursor.value as OfflineDownloadRecord;
      if (typeof record.size === "number" && record.size > 0) total += record.size;
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to total downloads"));
    tx.onerror = () => reject(tx.error ?? new Error("Failed to total downloads"));
  });
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
  nativeStorage: isNativeOfflineStorageAvailable(),
  verificationStatus: "idle",
  verificationCheckedAt: null,
  verifiedDownloads: 0,
  missingDownloads: 0,
  verificationError: null,
  hydrate: async () => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    attachBrowserListeners();
    const [storedRecords, pendingMutations, storage, persistentStorage] = await Promise.all([
      readHydrateDownloadRecords().catch(() => []),
      mutationCount(),
      estimateStorage(),
      requestPersistentStorage(),
    ]);
    const records = await requeueInterruptedDownloadRecords(storedRecords, true);
    set({
      hydrated: true,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      records: capRecordsInMemory(recordsById(records)),
      pendingMutations,
      storageUsage: storage.usage,
      storageQuota: storage.quota,
      persistentStorage,
      nativeStorage: isNativeOfflineStorageAvailable(),
    });
    scheduleBackgroundOfflineWork(() => {
      void processDownloadQueue();
      void syncOfflineMutations();
    });
  },
  queueDownloads: async (songs, scope) => {
    await get().hydrate();
    const timestamp = now();
    const accountScope = getOfflineAccountScope();
    const deviceId = getOfflineDeviceId();
    const queuedSongIds: string[] = [];
    for (const song of songs) {
      if (!canCacheSong(song)) continue;
      const existing = await idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, downloadRecordKey(song.id, accountScope)).catch(() => undefined);
      const current = isOfflineRecordForAccount(existing, accountScope) ? existing : undefined;
      const pinnedBy = Array.from(new Set([...(current?.pinnedBy ?? []), scope]));
      const record: OfflineDownloadRecord = {
        songId: song.id,
        song,
        audioUrl: song.audioUrl,
        imageUrl: song.imageUrl,
        lyricsUrl: song.lyricsUrl,
        nativeFiles: current?.nativeFiles,
        accountScope,
        deviceId,
        status: current?.status === "downloaded" ? "downloaded" : "queued",
        progress: current?.status === "downloaded" ? 1 : current?.progress ?? 0,
        size: current?.size ?? 0,
        error: undefined,
        pinnedBy,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastAccessedAt: timestamp,
        verifiedAt: current?.verifiedAt,
      };
      await persistRecord(record);
      if (record.status === "queued") queuedSongIds.push(record.songId);
    }
    enqueuePriorityDownloadIds(queuedSongIds);
    void processDownloadQueue();
    await get().refreshStorage();
  },
  removeDownload: async (songId) => {
    const record = await idbGet<OfflineDownloadRecord>(DOWNLOAD_STORE, downloadRecordKey(songId)).catch(() => undefined);
    if (record && !isOfflineRecordForAccount(record)) return;
    if (record) {
      await deleteCachedUrls(songAssetUrls(record.song));
      await deleteNativeOfflineFiles(record.nativeFiles);
    }
    await idbDelete(DOWNLOAD_STORE, downloadRecordKey(songId)).catch(() => undefined);
    set((state) => {
      const records = { ...state.records };
      delete records[songId];
      return { records };
    });
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
    await get().refreshStorage();
  },
  retryFailedDownloads: async () => {
    const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
    const deviceId = getOfflineDeviceId();
    for (const record of records) {
      if (record.status !== "failed") continue;
      await persistRecord({
        ...record,
        deviceId,
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
        await deleteNativeOfflineFiles(record.nativeFiles);
        await idbDelete(DOWNLOAD_STORE, downloadRecordKey(record.songId, record.accountScope)).catch(() => undefined);
      }),
    );
    set({ records: {} });
    await get().refreshStorage();
  },
  clearPlaybackCache: async () => {
    await clearCache(OFFLINE_PLAYBACK_CACHE);
    await get().refreshStorage();
  },
  verifyDownloads: async () => {
    await get().hydrate();
    set({
      verificationStatus: "checking",
      verificationError: null,
    });

    try {
      const records = currentAccountRecords(await idbGetAll<OfflineDownloadRecord>(DOWNLOAD_STORE).catch(() => []));
      const downloadedRecords = records.filter((record) => record.status === "downloaded");
      let verified = 0;
      let missing = 0;

      for (const record of downloadedRecords) {
        const result = await verifyOrRepairRecord(record);
        if (result.ok) {
          verified += 1;
          continue;
        }
        missing += 1;
        const queued: OfflineDownloadRecord = {
          ...record,
          status: "queued",
          progress: 0,
          error: "Offline file missing; queued for repair",
          updatedAt: now(),
        };
        await persistRecord(queued);
      }

      set({
        verificationStatus: missing > 0 ? "repair-needed" : "ok",
        verificationCheckedAt: now(),
        verifiedDownloads: verified,
        missingDownloads: missing,
        verificationError: null,
      });
      if (missing > 0) void processDownloadQueue();
      await get().refreshStorage();
    } catch (error) {
      set({
        verificationStatus: "failed",
        verificationCheckedAt: now(),
        verificationError: error instanceof Error ? error.message : "Download verification failed",
      });
    }
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
