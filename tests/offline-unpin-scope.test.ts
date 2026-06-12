import { afterAll, beforeEach, describe, expect, test } from "bun:test";
// Type-only import: erased at runtime, so the offline module is only evaluated
// by the dynamic import below, after the IndexedDB shim is installed.
import type { DownloadScope, OfflineDownloadRecord } from "../src/client/offline";

// Minimal in-memory IndexedDB shim covering the surface unpinScope touches
// (open/get/put/delete/getAll). Installed before the offline module's first
// openOfflineDb call so the cached dbPromise resolves against this fake.
type AnyRecord = Record<string, unknown>;

class FakeRequest {
  result: unknown;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeObjectStore {
  readonly indexNames = { contains: () => true };

  constructor(
    readonly data: Map<string, unknown>,
    private readonly keyPath: string | string[],
  ) {}

  private encodeKey(key: unknown): string {
    return JSON.stringify(key);
  }

  private keyOf(value: AnyRecord): string {
    if (Array.isArray(this.keyPath)) return JSON.stringify(this.keyPath.map((field) => value[field]));
    return JSON.stringify(value[this.keyPath]);
  }

  get(key: unknown): FakeRequest {
    const request = new FakeRequest();
    setTimeout(() => {
      request.result = this.data.get(this.encodeKey(key));
      request.onsuccess?.();
    }, 0);
    return request;
  }

  put(value: AnyRecord): FakeRequest {
    const request = new FakeRequest();
    this.data.set(this.keyOf(value), value);
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }

  delete(key: unknown): FakeRequest {
    const request = new FakeRequest();
    this.data.delete(this.encodeKey(key));
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }

  getAll(): FakeRequest {
    const request = new FakeRequest();
    setTimeout(() => {
      request.result = [...this.data.values()];
      request.onsuccess?.();
    }, 0);
    return request;
  }

  count(): FakeRequest {
    const request = new FakeRequest();
    setTimeout(() => {
      request.result = this.data.size;
      request.onsuccess?.();
    }, 0);
    return request;
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly db: FakeDatabase) {
    setTimeout(() => this.oncomplete?.(), 0);
  }

  objectStore(name: string): FakeObjectStore {
    return this.db.store(name);
  }
}

class FakeDatabase {
  private readonly stores = new Map<string, FakeObjectStore>();
  onversionchange: (() => void) | null = null;

  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  constructor() {
    this.createObjectStore("downloads_v2", { keyPath: ["accountScope", "songId"] });
    this.createObjectStore("api_snapshots", { keyPath: "url" });
    this.createObjectStore("mutations", { keyPath: "id" });
  }

  createObjectStore(name: string, options: { keyPath: string | string[] }): FakeObjectStore {
    const store = new FakeObjectStore(new Map(), options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  store(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Missing store ${name}`);
    return store;
  }

  transaction(): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {}
}

const fakeDb = new FakeDatabase();
const hadIndexedDb = "indexedDB" in globalThis;
const originalIndexedDb = (globalThis as AnyRecord).indexedDB;

(globalThis as AnyRecord).indexedDB = {
  open: () => {
    const request = {
      result: fakeDb,
      error: null,
      transaction: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  },
};

const { useOfflineStore } = await import("../src/client/offline");

function makeRecord(songId: string, pinnedBy: DownloadScope[], overrides: Partial<OfflineDownloadRecord> = {}): OfflineDownloadRecord {
  return {
    songId,
    song: {
      id: songId,
      title: `Title ${songId}`,
      artist: "Artist",
      imageUrl: `/api/image/${songId}`,
      audioUrl: `/api/audio/${songId}`,
    },
    audioUrl: `/api/audio/${songId}`,
    imageUrl: `/api/image/${songId}`,
    accountScope: "anonymous",
    deviceId: "server",
    status: "downloaded",
    progress: 1,
    size: 1024,
    pinnedBy,
    createdAt: 111,
    updatedAt: 111,
    lastAccessedAt: 111,
    ...overrides,
  };
}

const downloads = fakeDb.store("downloads_v2").data;

function seedRecord(record: OfflineDownloadRecord, keyScope = record.accountScope): void {
  downloads.set(JSON.stringify([keyScope, record.songId]), record);
}

function readRecord(songId: string, scope = "anonymous"): OfflineDownloadRecord | undefined {
  return downloads.get(JSON.stringify([scope, songId])) as OfflineDownloadRecord | undefined;
}

describe("offline store unpinScope", () => {
  beforeEach(() => {
    downloads.clear();
    fakeDb.store("mutations").data.clear();
    useOfflineStore.setState({ records: {} });
  });

  afterAll(() => {
    if (hadIndexedDb) (globalThis as AnyRecord).indexedDB = originalIndexedDb;
    else delete (globalThis as AnyRecord).indexedDB;
  });

  test("removes only the given scope when other pins remain", async () => {
    seedRecord(makeRecord("song-1", ["liked", "home"]));

    await useOfflineStore.getState().unpinScope("song-1", "liked");

    const stored = readRecord("song-1");
    expect(stored).toBeDefined();
    expect(stored?.pinnedBy).toEqual(["home"]);
    expect(stored?.status).toBe("downloaded");
    expect(useOfflineStore.getState().records["song-1"]?.pinnedBy).toEqual(["home"]);
  });

  test("removes the download when the last pin is released", async () => {
    seedRecord(makeRecord("song-2", ["liked"]));

    await useOfflineStore.getState().unpinScope("song-2", "liked");

    expect(readRecord("song-2")).toBeUndefined();
    expect(useOfflineStore.getState().records["song-2"]).toBeUndefined();
  });

  test("leaves records not pinned by the scope untouched", async () => {
    seedRecord(makeRecord("song-3", ["home"]));

    await useOfflineStore.getState().unpinScope("song-3", "liked");

    const stored = readRecord("song-3");
    expect(stored?.pinnedBy).toEqual(["home"]);
    expect(stored?.updatedAt).toBe(111);
  });

  test("is a no-op when no record exists", async () => {
    await useOfflineStore.getState().unpinScope("missing-song", "liked");

    expect(downloads.size).toBe(0);
  });

  test("ignores records belonging to another account", async () => {
    seedRecord(makeRecord("song-4", ["liked"], { accountScope: "someone-else" }), "anonymous");

    await useOfflineStore.getState().unpinScope("song-4", "liked");

    expect(readRecord("song-4")?.pinnedBy).toEqual(["liked"]);
  });
});
