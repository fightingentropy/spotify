"use client";

import {
  PLAYBACK_STATE_PENDING_SYNC_STORAGE_KEY,
  PLAYBACK_STATE_STORAGE_KEY,
} from "@/lib/playback-state";

export type OfflineCacheDiagnostics = {
  name: string;
  entries: number;
  estimatedBytes: number | null;
  byteEntries: number;
};

export type OfflineIndexedDbDiagnostics = {
  available: boolean;
  apiSnapshots: number | null;
  downloads: number | null;
  mutations: number | null;
  error?: string;
};

export type OfflineDiagnostics = {
  checkedAt: number;
  online: boolean | null;
  serviceWorker: {
    supported: boolean;
    controlled: boolean;
    registrationState: string | null;
  };
  caches: OfflineCacheDiagnostics[];
  indexedDb: OfflineIndexedDbDiagnostics;
  playbackState: {
    saved: boolean;
    pendingSync: boolean;
    updatedAt: number | null;
  };
};

const DB_NAME = "spotify_offline_v1";
const DOWNLOAD_STORE = "downloads_v2";
const API_SNAPSHOT_STORE = "api_snapshots";
const MUTATION_STORE = "mutations";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasCacheStorage(): boolean {
  return typeof caches !== "undefined";
}

function normalizedCacheKey(input: RequestInfo | URL): string {
  const value = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  return new URL(value, location.origin).toString();
}

async function getServiceWorkerDiagnostics(): Promise<OfflineDiagnostics["serviceWorker"]> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { supported: false, controlled: false, registrationState: null };
  }
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  return {
    supported: true,
    controlled: Boolean(navigator.serviceWorker.controller),
    registrationState:
      registration?.active?.state ??
      registration?.waiting?.state ??
      registration?.installing?.state ??
      null,
  };
}

async function responseKnownBytes(cache: Cache, request: Request): Promise<number | null> {
  const response = await cache.match(request).catch(() => undefined);
  if (!response) return null;
  const contentLength = Number(response.headers.get("content-length") || 0);
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
}

async function getCacheDiagnostics(): Promise<OfflineCacheDiagnostics[]> {
  if (!hasCacheStorage()) return [];
  const names = (await caches.keys().catch(() => [])).filter((name) => name.startsWith("spotify"));
  const diagnostics = await Promise.all(
    names.sort().map(async (name) => {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      let estimatedBytes = 0;
      let byteEntries = 0;
      for (const request of requests) {
        const bytes = await responseKnownBytes(cache, request);
        if (bytes == null) continue;
        estimatedBytes += bytes;
        byteEntries += 1;
      }
      return {
        name,
        entries: requests.length,
        estimatedBytes: byteEntries > 0 ? estimatedBytes : null,
        byteEntries,
      };
    }),
  );
  return diagnostics;
}

function openExistingOfflineDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("IndexedDB is not available"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error("Offline database has not been initialized"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open offline database"));
    request.onblocked = () => reject(new Error("Offline database is blocked by another tab"));
  });
}

function countStore(db: IDBDatabase, storeName: string): Promise<number | null> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Failed to count ${storeName}`));
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to count ${storeName}`));
  });
}

async function getIndexedDbDiagnostics(): Promise<OfflineIndexedDbDiagnostics> {
  if (!hasIndexedDb()) {
    return { available: false, apiSnapshots: null, downloads: null, mutations: null };
  }
  let db: IDBDatabase | null = null;
  try {
    db = await openExistingOfflineDb();
    const [apiSnapshots, downloads, mutations] = await Promise.all([
      countStore(db, API_SNAPSHOT_STORE),
      countStore(db, DOWNLOAD_STORE),
      countStore(db, MUTATION_STORE),
    ]);
    return { available: true, apiSnapshots, downloads, mutations };
  } catch (error) {
    return {
      available: true,
      apiSnapshots: null,
      downloads: null,
      mutations: null,
      error: error instanceof Error ? error.message : "Offline database unavailable",
    };
  } finally {
    db?.close();
  }
}

function getPlaybackStateDiagnostics(): OfflineDiagnostics["playbackState"] {
  if (typeof localStorage === "undefined") {
    return { saved: false, pendingSync: false, updatedAt: null };
  }
  try {
    const raw = localStorage.getItem(PLAYBACK_STATE_STORAGE_KEY);
    const pending = localStorage.getItem(PLAYBACK_STATE_PENDING_SYNC_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { updatedAt?: unknown } : null;
    const updatedAt = typeof parsed?.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
      ? parsed.updatedAt
      : null;
    return {
      saved: Boolean(raw),
      pendingSync: Boolean(pending),
      updatedAt,
    };
  } catch {
    return { saved: false, pendingSync: false, updatedAt: null };
  }
}

export async function readOfflineDiagnostics(): Promise<OfflineDiagnostics> {
  const [serviceWorker, cacheDiagnostics, indexedDb] = await Promise.all([
    getServiceWorkerDiagnostics(),
    getCacheDiagnostics(),
    getIndexedDbDiagnostics(),
  ]);
  return {
    checkedAt: Date.now(),
    online: typeof navigator === "undefined" ? null : navigator.onLine,
    serviceWorker,
    caches: cacheDiagnostics,
    indexedDb,
    playbackState: getPlaybackStateDiagnostics(),
  };
}

export function sameCacheRequest(left: RequestInfo | URL, right: RequestInfo | URL): boolean {
  return normalizedCacheKey(left) === normalizedCacheKey(right);
}
