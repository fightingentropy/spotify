"use client";

export type OfflineApiSnapshot<T = unknown> = {
  url: string;
  data: T;
  etag?: string | null;
  fetchedAt: number;
  updatedAt: number;
};

const DB_NAME = "spotify_offline_v1";
const DB_VERSION = 3;
const DOWNLOAD_STORE = "downloads_v2";
const API_SNAPSHOT_STORE = "api_snapshots";
const MUTATION_STORE = "mutations";
const DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT = "accountScope_updatedAt";
const DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT = "accountScope_status_updatedAt";

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function ensureDownloadIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains(DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT)) {
    store.createIndex(DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT, ["accountScope", "updatedAt"]);
  }
  if (!store.indexNames.contains(DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT)) {
    store.createIndex(DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT, ["accountScope", "status", "updatedAt"]);
  }
}

function openOfflineDb(): Promise<IDBDatabase> {
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
      resolve(db);
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
  fetchedAt = Date.now(),
): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const snapshot: OfflineApiSnapshot<T> = {
      url,
      data,
      etag: etag ?? null,
      fetchedAt,
      updatedAt: Date.now(),
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
