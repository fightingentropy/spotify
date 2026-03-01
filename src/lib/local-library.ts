import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseFile } from "music-metadata";
import { db } from "@/lib/db";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";
import { env } from "@/lib/env";
import {
  getObjectAbsolutePath,
  putObjectFromBuffer,
  putObjectFromFilePath,
} from "@/lib/storage";

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".wav",
  ".aif",
  ".aiff",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".wma",
]);

const COVER_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const LYRICS_EXTENSIONS = [".lrc", ".txt"];
const LYRICS_EXTENSION_SET = new Set(LYRICS_EXTENSIONS);

type ExistingSong = {
  id: string;
  imageUrl: string;
  lyricsUrl: string | null;
};

type LyricsIndex = Map<string, string[]>;

export type ImportLocalLibraryOptions = {
  userId: string;
  sourceDir?: string;
  includeCoverFiles?: boolean;
  includeLyricsFiles?: boolean;
};

export type ImportLocalLibraryResult = {
  sourceDir: string;
  scanned: number;
  imported: number;
  updated: number;
  converted: number;
  skipped: number;
  errors: Array<{ file: string; message: string }>;
};

function sanitizeSegment(segment: string): string {
  const safe = segment.trim().replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ");
  return safe.length > 0 ? safe : "untitled";
}

function buildMusicBasePath(artist: string, title: string): string {
  return join("music", sanitizeSegment(artist), sanitizeSegment(title)).replaceAll("\\", "/");
}

function toApiFileUrl(key: string): string {
  return `/api/files/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFilesByExtensions(
  dir: string,
  allowedExtensions: Set<string>,
  acc: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFilesByExtensions(abs, allowedExtensions, acc);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (allowedExtensions.has(extname(entry.name).toLowerCase())) {
      acc.push(abs);
    }
  }
}

async function walkAudioFiles(dir: string, acc: string[]): Promise<void> {
  await walkFilesByExtensions(dir, AUDIO_EXTENSIONS, acc);
}

async function walkLyricsFiles(dir: string, acc: string[]): Promise<void> {
  await walkFilesByExtensions(dir, LYRICS_EXTENSION_SET, acc);
}

function normalizeLookupName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sharedPrefixLength(leftPath: string, rightPath: string): number {
  const left = leftPath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const right = rightPath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());

  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

async function buildLyricsIndex(sourceDir: string): Promise<LyricsIndex> {
  const lyricsFiles: string[] = [];
  await walkLyricsFiles(sourceDir, lyricsFiles);

  const index: LyricsIndex = new Map();
  for (const lyricsPath of lyricsFiles) {
    const key = normalizeLookupName(basename(lyricsPath, extname(lyricsPath)));
    if (!key) continue;
    const entries = index.get(key) ?? [];
    entries.push(lyricsPath);
    index.set(key, entries);
  }
  return index;
}

function findLyricsFromIndex(
  index: LyricsIndex,
  audioPath: string,
  sourceBaseName: string,
): string | null {
  const key = normalizeLookupName(sourceBaseName);
  if (!key) return null;
  const candidates = index.get(key);
  if (!candidates || candidates.length === 0) return null;

  const audioDir = dirname(audioPath);
  let bestPath: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    let score = sharedPrefixLength(audioDir, dirname(candidate));
    const segments = candidate
      .split(/[\\/]/)
      .map((part) => part.toLowerCase());
    if (segments.includes("lyrics")) {
      score += 0.25;
    }
    if (score > bestScore) {
      bestPath = candidate;
      bestScore = score;
    }
  }

  return bestPath;
}

async function runFfmpegToFlac(inputPath: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-map_metadata",
      "0",
      "-c:a",
      "flac",
      outputPath,
    ];

    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(new Error(`ffmpeg failed: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const details = stderr.trim();
      reject(
        new Error(
          details
            ? `ffmpeg exited with code ${code}: ${details}`
            : `ffmpeg exited with code ${code}`,
        ),
      );
    });
  });
}

function extFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  return ".jpg";
}

async function findFirstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function coverCandidates(dirPath: string, stem: string): string[] {
  return [
    ...COVER_EXTENSIONS.map((ext) => join(dirPath, `${stem}${ext}`)),
    ...COVER_EXTENSIONS.map((ext) => join(dirPath, `cover${ext}`)),
    ...COVER_EXTENSIONS.map((ext) => join(dirPath, `folder${ext}`)),
  ];
}

function lyricsCandidates(dirPath: string, stem: string): string[] {
  return [
    ...LYRICS_EXTENSIONS.map((ext) => join(dirPath, `${stem}${ext}`)),
    ...LYRICS_EXTENSIONS.map((ext) => join(dirPath, `lyrics${ext}`)),
  ];
}

export async function importLocalLibrary(
  options: ImportLocalLibraryOptions,
): Promise<ImportLocalLibraryResult> {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();

  const sourceDir = options.sourceDir?.trim() || env.LOCAL_MUSIC_SOURCE_DIR;
  const includeCoverFiles =
    options.includeCoverFiles ?? env.LOCAL_IMPORT_USE_COVER_FILES;
  const includeLyricsFiles =
    options.includeLyricsFiles ?? env.LOCAL_IMPORT_USE_LYRICS_FILES;

  const sourceStat = await stat(sourceDir).catch(() => null);
  if (!sourceStat || !sourceStat.isDirectory()) {
    throw new Error(`Source music directory not found: ${sourceDir}`);
  }

  const audioFiles: string[] = [];
  await walkAudioFiles(sourceDir, audioFiles);
  audioFiles.sort((a, b) => a.localeCompare(b));
  const lyricsIndex = includeLyricsFiles
    ? await buildLyricsIndex(sourceDir)
    : new Map<string, string[]>();

  const result: ImportLocalLibraryResult = {
    sourceDir,
    scanned: audioFiles.length,
    imported: 0,
    updated: 0,
    converted: 0,
    skipped: 0,
    errors: [],
  };

  for (const audioPath of audioFiles) {
    try {
      const fileName = basename(audioPath);
      const sourceExt = extname(fileName).toLowerCase();
      const sourceBaseName = basename(fileName, sourceExt);
      const sourceFolder = dirname(audioPath);

      const metadata = await parseFile(audioPath, {
        duration: false,
        skipCovers: false,
      }).catch(() => null);

      const title =
        metadata?.common.title?.trim() ||
        basename(sourceBaseName || fileName, extname(fileName));
      const artist =
        metadata?.common.artist?.trim() ||
        metadata?.common.albumartist?.trim() ||
        "Unknown Artist";
      const audioBitDepth =
        typeof metadata?.format.bitsPerSample === "number" &&
        Number.isFinite(metadata.format.bitsPerSample)
          ? Math.round(metadata.format.bitsPerSample)
          : null;
      const audioSampleRate =
        typeof metadata?.format.sampleRate === "number" &&
        Number.isFinite(metadata.format.sampleRate)
          ? Math.round(metadata.format.sampleRate)
          : null;
      const basePath = buildMusicBasePath(artist, title);
      const audioKey = `${basePath}/audio/${randomUUID()}.flac`;
      const audioPathInStorage = getObjectAbsolutePath(audioKey);
      const audioUrl = toApiFileUrl(audioKey);

      const existingRows = (await (db`
        SELECT "id", "imageUrl", "lyricsUrl"
        FROM "Song"
        WHERE "userId" = ${options.userId}
          AND lower("title") = lower(${title})
          AND lower("artist") = lower(${artist})
        LIMIT 1
      ` as any)) as ExistingSong[];
      const existing = existingRows[0] ?? null;

      if (sourceExt === ".flac") {
        await putObjectFromFilePath(audioKey, audioPath, "audio/flac");
      } else {
        await runFfmpegToFlac(audioPath, audioPathInStorage);
        result.converted += 1;
      }

      let imageUrl = existing?.imageUrl || "/waveform.svg";
      if (includeCoverFiles) {
        const sidecarCover = await findFirstExisting(
          coverCandidates(sourceFolder, sourceBaseName),
        );
        if (sidecarCover) {
          const coverExt = extname(sidecarCover).toLowerCase();
          const imageKey = `${basePath}/cover/${randomUUID()}${coverExt === ".jpeg" ? ".jpg" : coverExt}`;
          await putObjectFromFilePath(imageKey, sidecarCover);
          imageUrl = toApiFileUrl(imageKey);
        }
      }
      if (imageUrl === "/waveform.svg" && metadata?.common.picture?.[0]) {
        const picture = metadata.common.picture[0];
        const pictureExt = extFromMimeType(picture.format || "image/jpeg");
        const imageKey = `${basePath}/cover/${randomUUID()}${pictureExt}`;
        await putObjectFromBuffer(
          imageKey,
          Buffer.from(picture.data),
          picture.format || "image/jpeg",
        );
        imageUrl = toApiFileUrl(imageKey);
      }

      let lyricsUrl: string | null = existing?.lyricsUrl || null;
      if (includeLyricsFiles) {
        let sidecarLyrics = await findFirstExisting(
          lyricsCandidates(sourceFolder, sourceBaseName),
        );
        if (!sidecarLyrics) {
          sidecarLyrics = findLyricsFromIndex(
            lyricsIndex,
            audioPath,
            sourceBaseName,
          );
        }
        if (sidecarLyrics) {
          const lyricsExt = extname(sidecarLyrics).toLowerCase() === ".lrc" ? ".lrc" : ".txt";
          const lyricsKey = `${basePath}/lyrics/${randomUUID()}${lyricsExt}`;
          await putObjectFromFilePath(lyricsKey, sidecarLyrics, "text/plain; charset=utf-8");
          lyricsUrl = toApiFileUrl(lyricsKey);
        } else {
          const embeddedLyrics = metadata?.common.lyrics?.filter(Boolean).join("\n\n").trim();
          if (embeddedLyrics) {
            const lyricsKey = `${basePath}/lyrics/${randomUUID()}.txt`;
            await putObjectFromBuffer(
              lyricsKey,
              Buffer.from(embeddedLyrics, "utf8"),
              "text/plain; charset=utf-8",
            );
            lyricsUrl = toApiFileUrl(lyricsKey);
          }
        }
      }

      if (existing) {
        await db`
          UPDATE "Song"
          SET
            "title" = ${title},
            "artist" = ${artist},
            "audioUrl" = ${audioUrl},
            "imageUrl" = ${imageUrl},
            "lyricsUrl" = ${lyricsUrl},
            "audioBitDepth" = ${audioBitDepth},
            "audioSampleRate" = ${audioSampleRate}
          WHERE "id" = ${existing.id}
        `;
        result.updated += 1;
      } else {
        await db`
          INSERT INTO "Song" (
            "id",
            "title",
            "artist",
            "imageUrl",
            "audioUrl",
            "lyricsUrl",
            "audioBitDepth",
            "audioSampleRate",
            "userId"
          )
          VALUES (
            ${randomUUID()},
            ${title},
            ${artist},
            ${imageUrl},
            ${audioUrl},
            ${lyricsUrl},
            ${audioBitDepth},
            ${audioSampleRate},
            ${options.userId}
          )
        `;
        result.imported += 1;
      }
    } catch (error) {
      result.errors.push({
        file: audioPath,
        message: error instanceof Error ? error.message : "Import failed",
      });
      result.skipped += 1;
    }
  }

  return result;
}
