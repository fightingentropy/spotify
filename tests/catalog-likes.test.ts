import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { normalizeCatalogLike, readCatalogLikes, setCatalogLike } from "../src/server/catalog-likes";
import type { LibrarySource } from "../src/server/local-library-scan";

let directory: string;
let source: LibrarySource;
const track = {
  discoverTrackId: "40EB7ABUO6MoWMUwPKptJ7",
  title: "Let It Go",
  artist: "James Bay",
  audioUrl: "/api/files/local/.discover/preview.opus?spotify_sig=temporary",
  imageUrl: "/api/files/local/.discover/cover.jpg?spotify_sig=temporary",
};

beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "spotify-catalog-likes-test-"));
  source = { key: "owner", root: resolve(directory, "music"), cachePath: resolve(directory, "cache", "library.json"), artworkDir: resolve(directory, "artwork"), shared: true };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("durable catalog likes", () => {
  test("stores metadata without expired streams, signatures, or arbitrary media paths", () => {
    const song = normalizeCatalogLike(track)!;
    expect(song.id).toBe(`catalog:${track.discoverTrackId}`);
    expect(song.audioUrl).toBe("");
    expect(song.imageUrl).toBe("/apple-icon.png");
    expect(song.preview).toBe(true);
    expect(normalizeCatalogLike({ ...track, discoverTrackId: "../../private" })).toBeNull();
    expect(normalizeCatalogLike({ ...track, title: "" })).toBeNull();
    expect(normalizeCatalogLike({ ...track, discoverTrackId: "yt:abcdefghijk", artist: "" })?.youtubeVideoId).toBe("abcdefghijk");
  });

  test("survives a fresh disk read, preserves the like time, and supports unlike", async () => {
    const song = normalizeCatalogLike(track, "2026-09-23T21:00:00.000Z")!;
    await setCatalogLike(source, song, true);
    await setCatalogLike(source, { ...song, likedAt: "2026-09-24T21:00:00.000Z" }, true);
    expect(await readCatalogLikes(source)).toEqual([song]);
    expect(await readFile(resolve(directory, "cache", "catalog-likes.json"), "utf8")).not.toContain("spotify_sig");
    await setCatalogLike(source, song, false);
    expect(await readCatalogLikes(source)).toEqual([]);
  });

  test("concurrent saves retain every like and stay within the account's library", async () => {
    const songs = Array.from({ length: 8 }, (_, index) => normalizeCatalogLike({ ...track, discoverTrackId: String(index).padStart(22, "a") })!);
    await Promise.all(songs.map((song) => setCatalogLike(source, song, true)));
    expect((await readCatalogLikes(source)).map((song) => song.id).sort()).toEqual(songs.map((song) => song.id).sort());
    const other = { ...source, key: "other", root: resolve(directory, "other"), cachePath: resolve(directory, "other-cache", "library.json") };
    expect(await readCatalogLikes(other)).toEqual([]);
  });

  test("does not overwrite a corrupt likes file with an empty list", async () => {
    await mkdir(resolve(directory, "cache"));
    const path = resolve(directory, "cache", "catalog-likes.json");
    await writeFile(path, "corrupt data");
    await expect(setCatalogLike(source, normalizeCatalogLike(track)!, true)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corrupt data");
  });
});
