// Backfill cover-art sidecars for library songs that have no artwork at all.
//
// A song is considered "missing art" when it has no cover sidecar AND no
// embedded picture. For those, queries the iTunes Search API (multiple query
// shapes, fuzzy-matched) and writes `<stem>.cover.jpg` next to the audio file,
// which the local music server serves as a stable /api/files/local URL after
// its next library scan.
//
// Run on the Mac mini from the app root (needs node_modules/music-metadata):
//   /opt/homebrew/bin/bun scripts/backfill-covers.ts
//
// Safe to re-run: songs with embedded art or an existing sidecar are skipped.

import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseFile } from "music-metadata";

const musicRoot = resolve(process.env.SPOTIFY_MUSIC_DIR || resolve(homedir(), "Music"));
const cacheDir = resolve(process.env.SPOTIFY_CACHE_DIR || resolve(process.cwd(), "cache"));
const reportPath = resolve(cacheDir, "cover-backfill-report.json");
const country = process.env.SPOTIFY_ARTWORK_COUNTRY || "GB";

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

// iTunes Search is rate limited to roughly 20 requests/minute per IP.
const REQUEST_DELAY_MS = 3_200;
// Deezer's public API is far more generous; a small courtesy delay is plenty.
const DEEZER_DELAY_MS = 350;
const USER_AGENT = "spotify-selfhost-cover-backfill/1.0 (personal library)";
// Edition noise that, when present in a candidate but NOT in the wanted title,
// means we matched a remix/live/cover edition — deprioritise it so the original
// release art wins (e.g. prefer "Sober" over "Sober (Version 6)").
const VERSION_NOISE =
  /(remix|live|version|extended|sped\s*up|slowed|karaoke|cover|instrumental|tribute|acoustic|remaster|\bedit\b|\bmix\b)/i;

type ItunesResult = {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};

type ReportEntry = {
  file: string;
  title: string;
  artist: string;
  status: "fixed" | "miss" | "error" | "has-art";
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
  // Space-insensitive: "Side Kick" vs "Sidekick", "XXX TENTACION" vs "XXXTENTACION".
  const aTight = a.replace(/\s+/g, "");
  const bTight = b.replace(/\s+/g, "");
  if (aTight === bTight) return 0.97;
  if (a.includes(b) || b.includes(a) || aTight.includes(bTight) || bTight.includes(aTight)) {
    return 0.85;
  }
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  let shared = 0;
  for (const token of aTokens) if (bTokens.has(token)) shared += 1;
  return shared / Math.max(aTokens.size, bTokens.size);
}

async function itunesSearch(term: string, entity: "song" | "album"): Promise<ItunesResult[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", entity);
  url.searchParams.set("limit", "10");
  url.searchParams.set("country", country);
  url.searchParams.set("term", term);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 403 || response.status === 429) {
    console.log(`itunes rate limited (${response.status}), sleeping 90s`);
    await sleep(90_000);
    return itunesSearch(term, entity);
  }
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as { results?: ItunesResult[] } | null;
  return Array.isArray(payload?.results) ? payload.results : [];
}

type DeezerTrack = {
  title?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_xl?: string; cover_big?: string };
};

// Deezer has broader catalogue coverage than iTunes for this library (mainstream
// + Greek/Albanian) and returns the actual release rather than the karaoke /
// string-quartet covers iTunes Search surfaces for many well-known tracks
// (it returned "Vitamin String Quartet - B.Y.O.B." for System Of A Down). Results
// are mapped into the iTunes shape so pickBest/downloadArtwork stay shared;
// cover_xl is already 1000x1000.
async function deezerSearch(term: string): Promise<ItunesResult[]> {
  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", term);
  url.searchParams.set("limit", "10");

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as { data?: DeezerTrack[] } | null;
  const tracks = Array.isArray(payload?.data) ? payload.data : [];
  return tracks.map((track) => ({
    artistName: track.artist?.name,
    trackName: track.title,
    collectionName: track.album?.title,
    artworkUrl100: track.album?.cover_xl || track.album?.cover_big,
  }));
}

function pickBest(
  results: ItunesResult[],
  meta: { artist: string; title: string; album?: string },
): { result: ItunesResult; score: number } | null {
  const scored = results
    .filter((result) => result.artworkUrl100)
    .map((result) => {
      const artistScore = Math.max(
        similarity(meta.artist, result.artistName || ""),
        similarity(primaryArtist(meta.artist), result.artistName || ""),
      );
      const titleScore = Math.max(
        similarity(meta.title, result.trackName || ""),
        similarity(stripVersionSuffix(meta.title), result.trackName || ""),
        meta.album ? similarity(meta.album, result.collectionName || "") : 0,
      );
      const editionPenalty =
        VERSION_NOISE.test(result.trackName || "") && !VERSION_NOISE.test(meta.title) ? 0.6 : 0;
      return {
        result,
        score: artistScore * 2 + titleScore * 3 - editionPenalty,
        artistScore,
        titleScore,
      };
    })
    .filter((entry) => entry.artistScore >= 0.45 && entry.titleScore >= 0.45)
    .sort((leftEntry, rightEntry) => rightEntry.score - leftEntry.score);
  return scored[0] ?? null;
}

async function downloadArtwork(artworkUrl100: string): Promise<Uint8Array | null> {
  const highRes = artworkUrl100.replace(/\/[0-9]+x[0-9]+bb\.(jpg|jpeg|png|webp)$/i, "/600x600bb.$1");
  const response = await fetch(highRes, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) return null;
  const data = new Uint8Array(await response.arrayBuffer());
  return data.byteLength >= 1024 ? data : null;
}

async function findArtwork(meta: {
  artist: string;
  title: string;
  album?: string;
}): Promise<{ data: Uint8Array; matched: string } | null> {
  const attempts: Array<{ label: string; term: string; entity: "song" | "album" }> = [
    { label: "song:artist+title", term: `${meta.artist} ${meta.title}`, entity: "song" },
    {
      label: "song:clean",
      term: `${primaryArtist(meta.artist)} ${stripVersionSuffix(meta.title)}`,
      entity: "song",
    },
  ];
  if (meta.album) {
    attempts.push({
      label: "album",
      term: `${primaryArtist(meta.artist)} ${meta.album}`,
      entity: "album",
    });
  }

  // Deezer first (see deezerSearch): clean primary-artist + de-versioned title,
  // then the raw tags. Falls through to iTunes below when Deezer has no match.
  const deezerTerms = [
    `${primaryArtist(meta.artist)} ${stripVersionSuffix(meta.title)}`,
    `${meta.artist} ${meta.title}`,
  ];
  for (const term of deezerTerms) {
    if (!term.trim()) continue;
    const results = await deezerSearch(term);
    await sleep(DEEZER_DELAY_MS);
    const best = pickBest(results, meta);
    if (!best?.result.artworkUrl100) continue;
    const data = await downloadArtwork(best.result.artworkUrl100);
    if (data) {
      return {
        data,
        matched: `deezer (${best.result.artistName} - ${best.result.trackName || best.result.collectionName})`,
      };
    }
  }

  for (const attempt of attempts) {
    if (!attempt.term.trim()) continue;
    const results = await itunesSearch(attempt.term, attempt.entity);
    await sleep(REQUEST_DELAY_MS);
    const best = pickBest(results, meta);
    if (!best?.result.artworkUrl100) continue;
    const data = await downloadArtwork(best.result.artworkUrl100);
    if (data) return { data, matched: `${attempt.label} (${best.result.artistName} - ${best.result.trackName || best.result.collectionName})` };
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

function hasCoverSidecar(audioPath: string): boolean {
  const stem = audioPath.replace(/\.[^.]+$/, "");
  return [
    `${stem}.cover.jpg`,
    `${stem}.cover.jpeg`,
    `${stem}.cover.png`,
    `${stem}.cover.webp`,
    `${stem}.jpg`,
    `${stem}.jpeg`,
    `${stem}.png`,
    `${stem}.webp`,
  ].some((candidate) => existsSync(candidate));
}

async function main(): Promise<void> {
  const files = await listAudioFiles(musicRoot);
  console.log(`scanning ${files.length} audio files under ${musicRoot}`);

  const report: ReportEntry[] = [];
  let fixed = 0;
  let miss = 0;
  let hasArt = 0;
  let errors = 0;
  let processed = 0;

  for (const file of files) {
    processed += 1;
    try {
      if (hasCoverSidecar(file)) {
        hasArt += 1;
        continue;
      }

      const metadata = await parseFile(file, { duration: false, skipCovers: false }).catch(() => null);
      if (metadata?.common?.picture?.[0]?.data?.byteLength) {
        hasArt += 1;
        continue;
      }

      const fileName = file.split("/").pop() || file;
      const fallbackTitle = fileName.replace(/\.[^.]+$/, "");
      const title = metadata?.common?.title?.trim() || fallbackTitle;
      const artist = metadata?.common?.artist?.trim() || "";
      const album = metadata?.common?.album?.trim() || undefined;

      if (!artist) {
        report.push({ file, title, artist, status: "miss", matched: "no-artist-tag" });
        miss += 1;
        continue;
      }

      const found = await findArtwork({ artist, title, album });
      if (!found) {
        report.push({ file, title, artist, status: "miss" });
        miss += 1;
        continue;
      }

      const stem = file.replace(/\.[^.]+$/, "");
      await writeFile(`${stem}.cover.jpg`, found.data);
      report.push({ file, title, artist, status: "fixed", matched: found.matched });
      fixed += 1;
      console.log(`fixed: ${title} — ${artist} [${found.matched}]`);
    } catch (error) {
      errors += 1;
      report.push({
        file,
        title: "",
        artist: "",
        status: "error",
        matched: error instanceof Error ? error.message : String(error),
      });
    }

    if (processed % 50 === 0) {
      console.log(`${processed}/${files.length} | fixed=${fixed} miss=${miss} has-art=${hasArt} err=${errors}`);
    }
  }

  await writeFile(
    reportPath,
    `${JSON.stringify({ summary: { fixed, miss, hasArt, errors }, report: report.filter((entry) => entry.status !== "has-art") }, null, 2)}\n`,
    "utf8",
  );
  console.log(`done: fixed=${fixed} miss=${miss} has-art=${hasArt} err=${errors} (report: ${reportPath})`);
}

await main();
