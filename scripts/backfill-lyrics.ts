// Bulk-fetch lyrics sidecars for the local music library from LRCLIB.
//
// For every audio file without an existing lyrics sidecar, queries
// https://lrclib.net and writes `<stem>.lrc` (synced) or `<stem>.txt` (plain)
// next to the audio file, which the local music server picks up as lyricsUrl
// on its next library scan.
//
// Run on the Mac mini from the app root (needs node_modules/music-metadata):
//   /opt/homebrew/bin/bun scripts/backfill-lyrics.ts
//
// Safe to re-run: files with any lyrics sidecar are skipped.

import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseFile } from "music-metadata";

const musicRoot = resolve(process.env.SPOTIFY_MUSIC_DIR || resolve(homedir(), "Music"));
const cacheDir = resolve(process.env.SPOTIFY_CACHE_DIR || resolve(process.cwd(), "cache"));
const reportPath = resolve(cacheDir, "lyrics-backfill-report.json");

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const REQUEST_DELAY_MS = 350;
// Modest parallelism: LRCLIB round-trips from here run 2-4s, which dominates
// the runtime; three workers keeps the request rate around 1-2/s overall.
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "spotify-selfhost-lyrics-backfill/1.0 (personal library; erlin.hx@gmail.com)";

type LrclibRecord = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

type ReportEntry = {
  file: string;
  title: string;
  artist: string;
  status: "synced" | "plain" | "instrumental" | "miss" | "error" | "skipped-existing";
  matched?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strips remaster/version/mono suffixes that LRCLIB rarely carries:
// "Paranoid - 2009 Remaster" -> "Paranoid", "Wonderful World - Mono" -> ...
function stripVersionSuffix(title: string): string {
  return title
    .replace(/\s*-\s*[^-]*(remaster(ed)?|mono|stereo|version|mix|edit|live|single|deluxe)[^-]*$/i, "")
    .replace(/\s*\((feat\.?|with)[^)]*\)/gi, "")
    .trim();
}

function primaryArtist(artist: string): string {
  return artist.split(/,|;|\sfeat\.?\s|\sft\.?\s|\s&\s|\sx\s/i)[0]?.trim() || artist;
}

function similarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  let shared = 0;
  for (const token of aTokens) if (bTokens.has(token)) shared += 1;
  return shared / Math.max(aTokens.size, bTokens.size);
}

async function lrclibRequest(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`https://lrclib.net${path}`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) {
    console.log("rate limited by lrclib, sleeping 60s");
    await sleep(60_000);
    return lrclibRequest(path);
  }
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function lrclibGet(params: {
  artist: string;
  title: string;
  album?: string;
  duration?: number;
}): Promise<LrclibRecord | null> {
  const search = new URLSearchParams();
  search.set("artist_name", params.artist);
  search.set("track_name", params.title);
  if (params.album) search.set("album_name", params.album);
  if (typeof params.duration === "number" && Number.isFinite(params.duration)) {
    search.set("duration", String(Math.round(params.duration)));
  }
  const { status, body } = await lrclibRequest(`/api/get?${search.toString()}`);
  if (status !== 200 || !body || typeof body !== "object") return null;
  return body as LrclibRecord;
}

async function lrclibSearch(params: {
  artist: string;
  title: string;
  duration?: number;
}): Promise<LrclibRecord | null> {
  const search = new URLSearchParams();
  search.set("track_name", params.title);
  search.set("artist_name", params.artist);
  const { status, body } = await lrclibRequest(`/api/search?${search.toString()}`);
  if (status !== 200 || !Array.isArray(body)) return null;
  const candidates = (body as LrclibRecord[])
    .map((record) => {
      const titleScore = similarity(params.title, record.trackName || "");
      const artistScore = similarity(params.artist, record.artistName || "");
      const durationDelta =
        typeof params.duration === "number" && typeof record.duration === "number"
          ? Math.abs(params.duration - record.duration)
          : null;
      const durationOk = durationDelta === null || durationDelta <= 6;
      const hasLyrics = !!(record.syncedLyrics || record.plainLyrics || record.instrumental);
      const score =
        titleScore * 3 +
        artistScore * 2 +
        (record.syncedLyrics ? 0.5 : 0) -
        (durationDelta === null ? 0 : Math.min(durationDelta, 10) * 0.05);
      return { record, score, ok: durationOk && hasLyrics && titleScore >= 0.45 && artistScore >= 0.4 };
    })
    .filter((entry) => entry.ok)
    .sort((leftEntry, rightEntry) => rightEntry.score - leftEntry.score);
  return candidates[0]?.record ?? null;
}

async function findLyrics(meta: {
  artist: string;
  title: string;
  album?: string;
  duration?: number;
}): Promise<{ record: LrclibRecord; matched: string } | null> {
  const attempts: Array<{ label: string; run: () => Promise<LrclibRecord | null> }> = [
    { label: "get:exact", run: () => lrclibGet(meta) },
    {
      label: "get:no-album",
      run: () => lrclibGet({ artist: meta.artist, title: meta.title, duration: meta.duration }),
    },
    {
      label: "get:clean",
      run: () =>
        lrclibGet({
          artist: primaryArtist(meta.artist),
          title: stripVersionSuffix(meta.title),
          duration: meta.duration,
        }),
    },
    {
      label: "search",
      run: () =>
        lrclibSearch({
          artist: primaryArtist(meta.artist),
          title: stripVersionSuffix(meta.title),
          duration: meta.duration,
        }),
    },
  ];

  for (const attempt of attempts) {
    const record = await attempt.run();
    await sleep(REQUEST_DELAY_MS);
    if (record && (record.syncedLyrics || record.plainLyrics || record.instrumental)) {
      return { record, matched: attempt.label };
    }
  }
  return null;
}

async function listAudioFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        queue.push(full);
        continue;
      }
      if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  return out.sort();
}

function hasLyricsSidecar(audioPath: string): boolean {
  const stem = audioPath.replace(/\.[^.]+$/, "");
  return [
    `${stem}.lrc`,
    `${stem}.lyrics.lrc`,
    `${stem}.txt`,
    `${stem}.lyrics.txt`,
  ].some((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  const files = await listAudioFiles(musicRoot);
  console.log(`scanning ${files.length} audio files under ${musicRoot}`);

  const report: ReportEntry[] = [];
  let synced = 0;
  let plain = 0;
  let instrumental = 0;
  let miss = 0;
  let errors = 0;
  let processed = 0;
  let nextIndex = 0;

  const writeReport = () =>
    writeFile(
      reportPath,
      `${JSON.stringify({ summary: { synced, plain, instrumental, miss, errors }, report }, null, 2)}\n`,
      "utf8",
    );

  async function processFile(file: string): Promise<void> {
    if (hasLyricsSidecar(file)) {
      report.push({ file, title: "", artist: "", status: "skipped-existing" });
      return;
    }

    try {
      const metadata = await parseFile(file, { duration: true, skipCovers: true }).catch(() => null);
      const fileName = file.split("/").pop() || file;
      const fallbackTitle = fileName.replace(/\.[^.]+$/, "");
      const title = metadata?.common?.title?.trim() || fallbackTitle;
      const artist = metadata?.common?.artist?.trim() || "";
      const album = metadata?.common?.album?.trim() || undefined;
      const duration =
        typeof metadata?.format?.duration === "number" && Number.isFinite(metadata.format.duration)
          ? metadata.format.duration
          : undefined;

      if (!artist) {
        report.push({ file, title, artist, status: "miss", matched: "no-artist-tag" });
        miss += 1;
        return;
      }

      const found = await findLyrics({ artist, title, album, duration });
      if (!found) {
        report.push({ file, title, artist, status: "miss" });
        miss += 1;
      } else if (found.record.instrumental) {
        report.push({ file, title, artist, status: "instrumental", matched: found.matched });
        instrumental += 1;
      } else if (found.record.syncedLyrics?.trim()) {
        const stem = file.replace(/\.[^.]+$/, "");
        await writeFile(`${stem}.lrc`, `${found.record.syncedLyrics.trim()}\n`, "utf8");
        report.push({ file, title, artist, status: "synced", matched: found.matched });
        synced += 1;
      } else if (found.record.plainLyrics?.trim()) {
        const stem = file.replace(/\.[^.]+$/, "");
        await writeFile(`${stem}.txt`, `${found.record.plainLyrics.trim()}\n`, "utf8");
        report.push({ file, title, artist, status: "plain", matched: found.matched });
        plain += 1;
      } else {
        report.push({ file, title, artist, status: "miss" });
        miss += 1;
      }
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error: ${file.split("/").pop()}: ${message}`);
      report.push({
        file,
        title: "",
        artist: "",
        status: "error",
        matched: message,
      });
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      await processFile(files[index]);
      processed += 1;
      if (processed % 25 === 0) {
        console.log(
          `${processed}/${files.length} | synced=${synced} plain=${plain} instrumental=${instrumental} miss=${miss} err=${errors}`,
        );
      }
      if (processed % 100 === 0) {
        await writeReport().catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  await writeReport();
  console.log(
    `done: synced=${synced} plain=${plain} instrumental=${instrumental} miss=${miss} err=${errors} (report: ${reportPath})`,
  );
}

await main();
