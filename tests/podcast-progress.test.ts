import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  PODCAST_FINISHED_TAIL_SECONDS,
  PODCAST_PROGRESS_MAX_ENTRIES,
  PODCAST_PROGRESS_STORAGE_KEY,
  PODCAST_SHORT_EPISODE_FINISHED_RATIO,
  PODCAST_SHORT_EPISODE_SECONDS,
  clearEpisodeProgress,
  isEpisodeFinished,
  markEpisodeFinished,
  readAllEpisodeProgress,
  readEpisodeProgress,
  writeEpisodeProgress,
} from "../src/client/podcast-progress";

type PatchedGlobal = "window" | "localStorage";
const originalDescriptors = new Map<PatchedGlobal, PropertyDescriptor | undefined>();
let storage: Map<string, string>;

function captureGlobal(key: PatchedGlobal): void {
  if (!originalDescriptors.has(key)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
}

beforeEach(() => {
  storage = new Map<string, string>();
  captureGlobal("window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
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
    },
  });
});

afterEach(() => {
  setSystemTime();
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  originalDescriptors.clear();
});

describe("podcast progress", () => {
  test("write and read roundtrip", () => {
    setSystemTime(new Date(1_000_000));
    writeEpisodeProgress("podcast:show:ep-1", 120, 3600);
    expect(readEpisodeProgress("podcast:show:ep-1")).toEqual({
      time: 120,
      duration: 3600,
      updatedAt: 1_000_000,
    });
    expect(readEpisodeProgress("podcast:show:ep-2")).toBeNull();
  });

  test("ignores invalid writes and keeps a known duration", () => {
    writeEpisodeProgress("", 10, 100);
    writeEpisodeProgress("podcast:show:ep-1", Number.NaN, 100);
    writeEpisodeProgress("podcast:show:ep-1", -5, 100);
    expect(readEpisodeProgress("podcast:show:ep-1")).toBeNull();

    writeEpisodeProgress("podcast:show:ep-1", 30, 100);
    // A later write without a usable duration keeps the stored one.
    writeEpisodeProgress("podcast:show:ep-1", 45, 0);
    expect(readEpisodeProgress("podcast:show:ep-1")?.duration).toBe(100);
    expect(readEpisodeProgress("podcast:show:ep-1")?.time).toBe(45);
  });

  test("finished threshold is the last 30 seconds", () => {
    const duration = 600;
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS - 1, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS + 1, duration, updatedAt: 0 })).toBe(true);
    expect(isEpisodeFinished({ time: duration, duration, updatedAt: 0 })).toBe(true);
    // Unknown duration can never count as finished.
    expect(isEpisodeFinished({ time: 10_000, duration: 0, updatedAt: 0 })).toBe(false);
  });

  test("long episodes keep the 30-second tail rule", () => {
    const duration = 4000;
    expect(isEpisodeFinished({ time: 1, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS + 1, duration, updatedAt: 0 })).toBe(true);
    expect(isEpisodeFinished({ time: duration, duration, updatedAt: 0 })).toBe(true);
  });

  test("short episodes require nearly the full runtime", () => {
    const duration = 20;
    expect(isEpisodeFinished({ time: 1, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration * PODCAST_SHORT_EPISODE_FINISHED_RATIO - 0.1, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: 19.5, duration, updatedAt: 0 })).toBe(true);
    expect(isEpisodeFinished({ time: duration, duration, updatedAt: 0 })).toBe(true);
  });

  test("short-episode rule applies up to the threshold duration", () => {
    const duration = PODCAST_SHORT_EPISODE_SECONDS;
    expect(isEpisodeFinished({ time: duration - PODCAST_FINISHED_TAIL_SECONDS + 1, duration, updatedAt: 0 })).toBe(false);
    expect(isEpisodeFinished({ time: duration * PODCAST_SHORT_EPISODE_FINISHED_RATIO, duration, updatedAt: 0 })).toBe(true);
  });

  test("markEpisodeFinished snaps the position to the end", () => {
    markEpisodeFinished("podcast:show:missing");
    expect(readEpisodeProgress("podcast:show:missing")).toBeNull();

    writeEpisodeProgress("podcast:show:ep-1", 30, 600);
    markEpisodeFinished("podcast:show:ep-1");
    const progress = readEpisodeProgress("podcast:show:ep-1");
    expect(progress?.time).toBe(600);
    expect(progress ? isEpisodeFinished(progress) : false).toBe(true);
  });

  test("clearEpisodeProgress removes the entry", () => {
    writeEpisodeProgress("podcast:show:ep-1", 30, 600);
    clearEpisodeProgress("podcast:show:ep-1");
    expect(readEpisodeProgress("podcast:show:ep-1")).toBeNull();
  });

  test("caps the map to the newest entries", () => {
    const extra = 5;
    for (let index = 0; index < PODCAST_PROGRESS_MAX_ENTRIES + extra; index += 1) {
      setSystemTime(new Date(1_000_000 + index));
      writeEpisodeProgress(`podcast:show:ep-${index}`, 60, 600);
    }
    const all = readAllEpisodeProgress();
    expect(Object.keys(all).length).toBe(PODCAST_PROGRESS_MAX_ENTRIES);
    for (let index = 0; index < extra; index += 1) {
      expect(readEpisodeProgress(`podcast:show:ep-${index}`)).toBeNull();
    }
    expect(readEpisodeProgress(`podcast:show:ep-${extra}`)).not.toBeNull();
    expect(readEpisodeProgress(`podcast:show:ep-${PODCAST_PROGRESS_MAX_ENTRIES + extra - 1}`)).not.toBeNull();
  });

  test("re-writing an old entry refreshes it past eviction", () => {
    for (let index = 0; index < PODCAST_PROGRESS_MAX_ENTRIES; index += 1) {
      setSystemTime(new Date(1_000_000 + index));
      writeEpisodeProgress(`podcast:show:ep-${index}`, 60, 600);
    }
    setSystemTime(new Date(2_000_000));
    writeEpisodeProgress("podcast:show:ep-0", 90, 600);
    setSystemTime(new Date(2_000_001));
    writeEpisodeProgress("podcast:show:ep-new", 10, 600);
    // ep-0 was refreshed, so the next-oldest entry (ep-1) is evicted instead.
    expect(readEpisodeProgress("podcast:show:ep-0")?.time).toBe(90);
    expect(readEpisodeProgress("podcast:show:ep-1")).toBeNull();
  });

  test("tolerates corrupt storage", () => {
    storage.set(PODCAST_PROGRESS_STORAGE_KEY, "{not json");
    expect(readEpisodeProgress("podcast:show:ep-1")).toBeNull();
    writeEpisodeProgress("podcast:show:ep-1", 30, 600);
    expect(readEpisodeProgress("podcast:show:ep-1")?.time).toBe(30);

    storage.set(
      PODCAST_PROGRESS_STORAGE_KEY,
      JSON.stringify({ good: { time: 5, duration: 10, updatedAt: 1 }, bad: { time: "x" } }),
    );
    expect(readEpisodeProgress("good")).toEqual({ time: 5, duration: 10, updatedAt: 1 });
    expect(readEpisodeProgress("bad")).toBeNull();
  });
});
