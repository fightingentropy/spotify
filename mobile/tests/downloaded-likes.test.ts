import { describe, expect, test } from "bun:test";
import { downloadedLikedSongs, mergeDownloadedLikes } from "../src/lib/downloaded-likes";
import type { OfflineDownloadRecord } from "../src/lib/offline-download-queue";

function record(id: string, overrides: Partial<OfflineDownloadRecord> = {}): OfflineDownloadRecord {
  return {
    songId: id, accountScope: "owner", scopes: ["liked"], status: "ready",
    audioPath: `offline-media/${id}/audio.flac`, updatedAt: 1,
    song: { id, title: id, artist: "Artist", imageUrl: "/cover.jpg", audioUrl: "/audio.flac" },
    ...overrides,
  };
}

describe("downloaded Liked Songs recovery", () => {
  test("an empty server response retains the account's liked downloads only", () => {
    const records = {
      liked: record("liked"),
      other: record("other", { accountScope: "other-account" }),
      cache: record("cache", { scopes: ["playback-cache"] }),
      direct: record("direct", { scopes: ["song:direct"] }),
      queued: record("queued", { status: "queued" }),
      missing: record("missing", { audioPath: undefined }),
    };
    const recovered = downloadedLikedSongs(records, "owner");
    expect(mergeDownloadedLikes([], recovered, { liked: true }).map((s) => s.id)).toEqual(["liked"]);
    expect(downloadedLikedSongs(records, "anonymous")).toEqual([]);
    expect(downloadedLikedSongs(records, "")).toEqual([]);
  });

  test("a confirmed unlike survives recovery and a canonical map change", () => {
    const canonical = (id: string) => id === "copy" ? "original" : id;
    expect(downloadedLikedSongs({ copy: record("copy") }, "owner", ["original"], canonical)).toEqual([]);
  });

  test("optimistic and queued unlikes hide a download while its pin still exists", () => {
    const saved = downloadedLikedSongs({ liked: record("liked") }, "owner");
    expect(mergeDownloadedLikes([], saved, {})).toEqual([]);
    expect(mergeDownloadedLikes([], saved, { liked: true })).toHaveLength(1);
  });

  test("a returning catalog keeps fresh metadata and avoids canonical duplicates", () => {
    const canonical = (id: string) => id === "copy" ? "original" : id;
    const remote = { ...record("original").song, title: "Updated title" };
    const result = mergeDownloadedLikes([remote], [record("copy").song, record("extra").song],
      { original: true, copy: true, extra: true }, canonical);
    expect(result.map((s) => s.id)).toEqual(["original", "extra"]);
    expect(result[0]?.title).toBe("Updated title");
  });
});
