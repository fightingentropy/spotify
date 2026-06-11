import { afterEach, describe, expect, test } from "bun:test";
import {
  clearPlaybackStatePendingSync,
  coercePlaybackState,
  markPlaybackStatePendingSync,
  readPlaybackStatePendingSyncUpdatedAt,
  removeLocalPlaybackState,
  writeLocalPlaybackState,
  writeServerPlaybackState,
} from "../src/client/playback-state";
import { PLAYBACK_STATE_PENDING_SYNC_STORAGE_KEY, PLAYBACK_STATE_STORAGE_KEY } from "../src/lib/playback-state";

// Track which globals installBrowserState (and the offline test) overrode so we
// can restore them after each test instead of leaking the mutated globalThis.
type PatchedGlobal = "window" | "navigator" | "localStorage" | "fetch";
const originalDescriptors = new Map<PatchedGlobal, PropertyDescriptor | undefined>();

function captureGlobal(key: PatchedGlobal): void {
  if (!originalDescriptors.has(key)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
}

function restorePatchedGlobals(): void {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  originalDescriptors.clear();
}

afterEach(() => {
  restorePatchedGlobals();
});

function installBrowserState(options: { online?: boolean } = {}) {
  const storage = new Map<string, string>();
  captureGlobal("window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  captureGlobal("navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: options.online ?? true },
  });
  captureGlobal("localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
    },
  });
  return storage;
}

describe("playback state sync", () => {
  test("preserves podcast playback metadata", () => {
    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [
        {
          id: "podcast:show:episode",
          title: "Episode",
          artist: "Show",
          imageUrl: "/cover.jpg",
          audioUrl: "https://example.com/episode.mp3",
          source: "podcast",
          description: "A useful description",
          link: "https://example.com/show-notes",
          duration: 123,
        },
      ],
      currentIndex: 0,
      currentTime: 42,
      isPlaying: true,
      updatedAt: 99,
      deviceId: "device-1",
    });

    expect(state?.song.description).toBe("A useful description");
    expect(state?.song.link).toBe("https://example.com/show-notes");
    expect(state?.currentTime).toBe(42);
    expect(state?.updatedAt).toBe(99);
  });

  test("rejects non-portable browser-local playback state", () => {
    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [
        {
          id: "browser-local:episode",
          title: "Local",
          artist: "Files",
          imageUrl: "/cover.jpg",
          audioUrl: "blob:http://localhost/audio",
          source: "browser-local",
        },
      ],
      currentIndex: 0,
      currentTime: 42,
      isPlaying: false,
    });

    expect(state).toBeNull();
  });

  test("marks playback state pending instead of fetching while offline", async () => {
    const storage = installBrowserState({ online: false });
    let fetchCalls = 0;
    captureGlobal("fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });

    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [{
        id: "song-1",
        title: "Song",
        artist: "Artist",
        imageUrl: "/cover.jpg",
        audioUrl: "/api/files/song.flac",
      }],
      currentIndex: 0,
      currentTime: 12,
      updatedAt: 123,
      deviceId: "device-1",
    });

    expect(state).not.toBeNull();
    const response = await writeServerPlaybackState(state!);
    expect(response).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(storage.get(PLAYBACK_STATE_PENDING_SYNC_STORAGE_KEY)).toBe("123");
  });

  test("clears pending playback marker when local state is removed", () => {
    const storage = installBrowserState();
    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [{
        id: "song-1",
        title: "Song",
        artist: "Artist",
        imageUrl: "/cover.jpg",
        audioUrl: "/api/files/song.flac",
      }],
      currentIndex: 0,
      updatedAt: 456,
      deviceId: "device-1",
    });

    expect(state).not.toBeNull();
    writeLocalPlaybackState(state!);
    markPlaybackStatePendingSync(456);
    expect(readPlaybackStatePendingSyncUpdatedAt()).toBe(456);
    removeLocalPlaybackState();
    expect(storage.has(PLAYBACK_STATE_STORAGE_KEY)).toBe(false);
    expect(readPlaybackStatePendingSyncUpdatedAt()).toBeNull();
    clearPlaybackStatePendingSync();
  });
});
