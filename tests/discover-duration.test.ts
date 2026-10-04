import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  configureDiscover, discoverCatalogMetadata, findDiscoverStagedSong,
  handleDiscoverStageNow, handleDiscoverStagingStatus,
} from "../src/server/local-discover";
import type { LibrarySource } from "../src/server/local-library-scan";
import { applyDiscoverStaging, discoverStagedToPlayerSong, type DiscoverTrendingTrack } from "../src/worker/discover";

function wav(seconds: number): Buffer<ArrayBuffer> {
  const samples = seconds * 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

test("repairs existing staged audio once, preserves files, and recovers new-stage duration without downloading twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spotify-discover-duration-"));
  const source: LibrarySource = { key: "duration-test", root: join(directory, "music"), cachePath: join(directory, "cache/library.json"), artworkDir: join(directory, "artwork"), shared: true };
  const manifestPath = join(dirname(source.cachePath), "discover-staging.json");
  const audioPath = join(source.root, ".discover/existing/recording.wav");
  const original = wav(1.5);
  let downloads = 0;
  configureDiscover({
    librarySourceForRequest: () => source,
    currentUserIdForRequest: () => "test-user",
    forbiddenLibraryResponse: () => new Response(null, { status: 403 }),
    notFound: () => new Response(null, { status: 404 }),
    ffmpegPath: () => "unused",
    materializeLicensedStreamToResponse: async () => { downloads++; return new Response(wav(2.25), { headers: { "content-type": "audio/wav" } }); },
    licensedMediaRequestHeaders: () => ({}),
    signMediaUrl: url => url,
  });
  try {
    await mkdir(dirname(audioPath), { recursive: true });
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(audioPath, original);
    await writeFile(manifestPath, JSON.stringify({ version: 1, entries: { existing: {
      trackId: "existing", stagedRelPath: ".discover/existing/recording.wav", finalRelPath: "recording.wav", finalId: "local-server:existing",
      title: "Existing", artist: "Artist", durationMs: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now(), providerDownload: true,
    } } }));
    const details = await findDiscoverStagedSong(source, "local-server:existing");
    expect(details).toMatchObject({ duration: 1.5, staged: true, discoverTrackId: "existing" });
    expect((await discoverCatalogMetadata(source, "existing")).duration).toBe(1.5);
    const persisted = await readFile(manifestPath, "utf8");
    expect(JSON.parse(persisted).entries.existing.durationMs).toBe(1500);
    expect(await readFile(audioPath)).toEqual(original);
    expect(downloads).toBe(0);
    // A status read must reuse persisted duration, not parse every audio file again.
    await writeFile(audioPath, wav(3));
    const status = await (await handleDiscoverStagingStatus(new Request("http://local/api/discover/staging"))).json();
    expect(status.entries[0].duration).toBe(1.5);
    expect(await readFile(manifestPath, "utf8")).toBe(persisted);
    await writeFile(audioPath, original);
    const existing = await (await handleDiscoverStageNow(new Request("http://local/api/discover/stage", { method: "POST", body: JSON.stringify({ trackId: "existing", title: "Existing", artist: "Artist", preview: true }) }))).json();
    expect(existing.duration).toBe(1.5);
    expect(downloads).toBe(0);
    const stage = () => handleDiscoverStageNow(new Request("http://local/api/discover/stage", { method: "POST", body: JSON.stringify({ trackId: "new", title: "New", artist: "Artist", resolved: { licensedStream: { type: "direct" } } }) }));
    const created = await (await stage()).json();
    expect(created.duration).toBe(2.25);
    expect(downloads).toBe(1);
    expect((await (await stage()).json()).duration).toBe(2.25);
    expect(downloads).toBe(1);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).entries.new.durationMs).toBe(2250);
    expect(await findDiscoverStagedSong({ ...source, shared: false }, "local-server:existing")).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the chart overlay uses staged audio length and does not erase good metadata with invalid status", () => {
  const track: DiscoverTrendingTrack = { id: "chart", title: "Chart", artist: "Artist", album: "", imageUrl: "", spotifyUrl: "", durationMs: null };
  const ready = { trackId: "chart", id: "local-server:chart", audioUrl: "/api/files/local/.discover/chart/song.flac", duration: 225.868 };
  const overlaid = applyDiscoverStaging([track], new Map([[track.id, ready]]))[0];
  expect(overlaid.durationMs).toBe(225868);
  expect(discoverStagedToPlayerSong(overlaid).duration).toBe(225.868);
  for (const duration of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(applyDiscoverStaging([{ ...track, durationMs: 181270 }], new Map([[track.id, { ...ready, duration }]]))[0].durationMs).toBe(181270);
  }
});
