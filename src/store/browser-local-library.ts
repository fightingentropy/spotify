"use client";

import { create } from "zustand";
import type { PlayerSong } from "@/types/player";

type DirectoryPickerMode = "read" | "readwrite";
type WellKnownDirectory =
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos";
type PermissionStateValue = "granted" | "denied" | "prompt";

type BrowserWritable = {
  write: (data: Blob | BufferSource | string) => Promise<void>;
  close: () => Promise<void>;
};

type BrowserFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<BrowserWritable>;
};

type BrowserDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<BrowserHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<BrowserFileHandle>;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<BrowserDirectoryHandle>;
  queryPermission?: (descriptor?: { mode?: DirectoryPickerMode }) => Promise<PermissionStateValue>;
  requestPermission?: (descriptor?: { mode?: DirectoryPickerMode }) => Promise<PermissionStateValue>;
};

type BrowserHandle = BrowserFileHandle | BrowserDirectoryHandle;

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: DirectoryPickerMode;
      startIn?: WellKnownDirectory;
    }) => Promise<BrowserDirectoryHandle>;
  };

type LocalSidecar = {
  version?: number;
  title?: string;
  artist?: string;
  coverFile?: string;
  lyricsFile?: string;
  updatedAt?: string;
};

type LocalSongEntry = {
  song: PlayerSong;
  audioFileHandle: BrowserFileHandle | null;
  parentDirectoryHandle: BrowserDirectoryHandle | null;
  pathParts: string[];
  stem: string;
  sidecar: LocalSidecar;
  writable: boolean;
};

export type BrowserLocalSongEdits = {
  title: string;
  artist: string;
  coverFile?: File | null;
  lyricsFile?: File | null;
  lyricsText?: string;
};

export type SaveDownloadedTrackInput = {
  title: string;
  artist: string;
  audioBlob: Blob;
  audioFileName: string;
  coverBlob?: Blob | null;
  coverFileName?: string;
  lyricsText?: string;
};

type BrowserLocalLibraryState = {
  supported: boolean;
  hydrated: boolean;
  directoryName: string;
  songs: PlayerSong[];
  status: "idle" | "scanning" | "ready" | "error";
  error: string | null;
  writable: boolean;
  pickedFileMode: boolean;
  scannedAt: number | null;
  hydrateCapabilities: () => void;
  chooseDirectory: () => Promise<void>;
  rescan: () => Promise<void>;
  loadPickedFiles: (files: FileList | File[]) => void;
  saveDownloadedTrack: (input: SaveDownloadedTrackInput) => Promise<PlayerSong>;
  replaceSong: (song: PlayerSong) => void;
};

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
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const LYRICS_EXTENSIONS = [".lrc", ".txt"];
const DIRECTORY_PICKER_ID = "waveform-music-library";
const HANDLE_DB_NAME = "waveform-local-library";
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE_NAME = "handles";
const HANDLE_KEY = "directory";
const FOLDER_NAME_STORAGE_KEY = "wf_browser_local_folder_name";

let activeDirectoryHandle: BrowserDirectoryHandle | null = null;
const entriesById = new Map<string, LocalSongEntry>();
const objectUrls = new Set<string>();

function getDirectoryPicker(): DirectoryPickerWindow["showDirectoryPicker"] | null {
  if (typeof window === "undefined") return null;
  return (window as DirectoryPickerWindow).showDirectoryPicker ?? null;
}

export function isBrowserFolderAccessSupported(): boolean {
  return !!getDirectoryPicker();
}

export function isBrowserLocalSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return (
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    song.id.startsWith("browser-local:") ||
    song.id.startsWith("picked-file:") ||
    song.audioUrl.startsWith("blob:")
  );
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function stemOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(0, idx) : name;
}

function normalizePath(parts: string[]): string {
  return parts.join("/");
}

function songIdForPath(parts: string[]): string {
  return `browser-local:${encodeURIComponent(normalizePath(parts))}`;
}

function createTrackedObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function clearTrackedObjectUrls() {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}

function readCachedFolderName(): string {
  try {
    return localStorage.getItem(FOLDER_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeCachedFolderName(name: string) {
  try {
    localStorage.setItem(FOLDER_NAME_STORAGE_KEY, name);
  } catch {}
}

function clearCachedFolderName() {
  try {
    localStorage.removeItem(FOLDER_NAME_STORAGE_KEY);
  } catch {}
}

function openDirectoryHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HANDLE_STORE_NAME);
    };
  });
}

async function persistDirectoryHandle(handle: BrowserDirectoryHandle): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDirectoryHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to save folder handle"));
    tx.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY);
  });
  db.close();
}

async function readPersistedDirectoryHandle(): Promise<BrowserDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDirectoryHandleDb();
    const handle = await new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, "readonly");
      const request = tx.objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () =>
        resolve((request.result as BrowserDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Failed to read folder handle"));
    });
    db.close();
    if (handle?.kind === "directory") return handle;
    return null;
  } catch {
    return null;
  }
}

async function clearPersistedDirectoryHandle(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDirectoryHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to clear folder handle"));
      tx.objectStore(HANDLE_STORE_NAME).delete(HANDLE_KEY);
    });
    db.close();
  } catch {}
}

async function restoreSavedDirectoryAccess(): Promise<"granted" | "prompt" | "missing"> {
  const handle = await readPersistedDirectoryHandle();
  if (!handle) return "missing";

  activeDirectoryHandle = handle;
  if (!handle.queryPermission) return "granted";

  const writePermission = await handle
    .queryPermission({ mode: "readwrite" })
    .catch(() => "prompt" as const);
  if (writePermission === "granted") return "granted";

  const readPermission = await handle.queryPermission({ mode: "read" }).catch(() => "prompt" as const);
  return readPermission === "granted" ? "granted" : "prompt";
}

async function restoreSavedLibrary(
  apply: (partial: Partial<BrowserLocalLibraryState>) => void,
): Promise<boolean> {
  const access = await restoreSavedDirectoryAccess();
  if (access === "missing") {
    const cachedName = readCachedFolderName();
    if (cachedName) {
      apply({ directoryName: cachedName, status: "idle", error: null });
    }
    return false;
  }

  const folderName = activeDirectoryHandle?.name || readCachedFolderName() || "Music";
  apply({ status: "scanning", error: null, directoryName: folderName });

  if (activeDirectoryHandle) {
    const canAccess =
      (await requestDirectoryPermission(activeDirectoryHandle, "readwrite")) ||
      (await requestDirectoryPermission(activeDirectoryHandle, "read"));
    if (!canAccess) {
      apply({ status: "idle", error: null, directoryName: folderName });
      return false;
    }
  }

  try {
    const result = await scanActiveDirectory();
    writeCachedFolderName(result.directoryName);
    apply({
      directoryName: result.directoryName,
      songs: result.songs,
      status: "ready",
      error: null,
      writable: result.writable,
      pickedFileMode: false,
      scannedAt: Date.now(),
    });
    return true;
  } catch (error) {
    apply({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to restore folder",
    });
    return false;
  }
}

function sanitizeFileSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
  return safe || "Unknown";
}

function parseTitleArtist(stem: string, parentName: string, sidecar: LocalSidecar) {
  const sidecarTitle = typeof sidecar.title === "string" ? sidecar.title.trim() : "";
  const sidecarArtist = typeof sidecar.artist === "string" ? sidecar.artist.trim() : "";
  if (sidecarTitle && sidecarArtist) {
    return { title: sidecarTitle, artist: sidecarArtist };
  }

  const dashIndex = stem.indexOf(" - ");
  if (dashIndex > 0) {
    const artist = stem.slice(0, dashIndex).trim();
    const title = stem.slice(dashIndex + 3).trim();
    if (artist && title) {
      return {
        title: sidecarTitle || title,
        artist: sidecarArtist || artist,
      };
    }
  }

  return {
    title: sidecarTitle || stem,
    artist: sidecarArtist || parentName || "Unknown Artist",
  };
}

type EmbeddedAudioMetadata = {
  title?: string;
  artist?: string;
  imageUrl?: string;
  lyricsUrl?: string;
  audioBitDepth?: number;
  audioSampleRate?: number;
};

async function parseEmbeddedMetadata(
  file: File,
  options?: { skipCovers?: boolean },
): Promise<EmbeddedAudioMetadata> {
  try {
    const { parseBlob, selectCover } = await import("music-metadata");
    const metadata = await parseBlob(file, {
      duration: false,
      skipCovers: options?.skipCovers ?? false,
    });

    const result: EmbeddedAudioMetadata = {};
    const embeddedTitle = metadata.common.title?.trim();
    const embeddedArtist =
      metadata.common.artist?.trim() ||
      metadata.common.albumartist?.trim() ||
      metadata.common.artists?.find((value) => value.trim())?.trim();

    if (embeddedTitle) {
      result.title = embeddedTitle;
    }
    if (embeddedArtist) {
      result.artist = embeddedArtist;
    }

    if (!options?.skipCovers) {
      const picture = selectCover(metadata.common.picture);
      if (picture?.data?.length) {
        result.imageUrl = createTrackedObjectUrl(
          new Blob([picture.data.slice()], { type: picture.format || "image/jpeg" }),
        );
      }
    }

    const embeddedLyrics = metadata.common.lyrics?.filter(Boolean).join("\n\n").trim();
    if (embeddedLyrics) {
      result.lyricsUrl = createTrackedObjectUrl(
        new Blob([embeddedLyrics], { type: "text/plain;charset=utf-8" }),
      );
    }

    const bits = metadata.format.bitsPerSample;
    if (typeof bits === "number" && Number.isFinite(bits)) {
      result.audioBitDepth = Math.round(bits);
    }
    const sampleRate = metadata.format.sampleRate;
    if (typeof sampleRate === "number" && Number.isFinite(sampleRate)) {
      result.audioSampleRate = Math.round(sampleRate);
    }

    return result;
  } catch {
    return {};
  }
}

async function requestDirectoryPermission(
  handle: BrowserDirectoryHandle,
  mode: DirectoryPickerMode,
): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) {
    return true;
  }

  const current = await handle.queryPermission({ mode }).catch(() => "prompt" as const);
  if (current === "granted") return true;
  const next = await handle.requestPermission({ mode }).catch(() => "denied" as const);
  return next === "granted";
}

async function getOptionalFileHandle(
  dirHandle: BrowserDirectoryHandle,
  fileName: string | undefined,
): Promise<BrowserFileHandle | null> {
  if (!fileName) return null;
  try {
    return await dirHandle.getFileHandle(fileName);
  } catch {
    return null;
  }
}

async function readSidecar(
  dirHandle: BrowserDirectoryHandle,
  stem: string,
): Promise<LocalSidecar> {
  const handle = await getOptionalFileHandle(dirHandle, `${stem}.waveform.json`);
  if (!handle) return {};
  try {
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text()) as LocalSidecar;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function findCoverHandle(
  dirHandle: BrowserDirectoryHandle,
  stem: string,
  sidecar: LocalSidecar,
): Promise<BrowserFileHandle | null> {
  const fromSidecar = await getOptionalFileHandle(dirHandle, sidecar.coverFile);
  if (fromSidecar) return fromSidecar;

  const candidates = [
    ...IMAGE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...IMAGE_EXTENSIONS.map((ext) => `${stem}.cover${ext}`),
    ...IMAGE_EXTENSIONS.map((ext) => `cover${ext}`),
    ...IMAGE_EXTENSIONS.map((ext) => `folder${ext}`),
  ];

  for (const candidate of candidates) {
    const handle = await getOptionalFileHandle(dirHandle, candidate);
    if (handle) return handle;
  }
  return null;
}

async function findLyricsHandle(
  dirHandle: BrowserDirectoryHandle,
  stem: string,
  sidecar: LocalSidecar,
): Promise<BrowserFileHandle | null> {
  const fromSidecar = await getOptionalFileHandle(dirHandle, sidecar.lyricsFile);
  if (fromSidecar) return fromSidecar;

  for (const ext of LYRICS_EXTENSIONS) {
    const handle = await getOptionalFileHandle(dirHandle, `${stem}${ext}`);
    if (handle) return handle;
  }
  return null;
}

async function collectAudioFiles(
  dirHandle: BrowserDirectoryHandle,
  pathParts: string[],
  acc: Array<{
    fileHandle: BrowserFileHandle;
    parentDirectoryHandle: BrowserDirectoryHandle;
    pathParts: string[];
  }>,
) {
  for await (const handle of dirHandle.values()) {
    if (handle.kind === "directory") {
      if (handle.name === ".waveform" || handle.name === "node_modules") continue;
      await collectAudioFiles(handle, [...pathParts, handle.name], acc);
      continue;
    }

    if (AUDIO_EXTENSIONS.has(extensionOf(handle.name))) {
      acc.push({
        fileHandle: handle,
        parentDirectoryHandle: dirHandle,
        pathParts: [...pathParts, handle.name],
      });
    }
  }
}

async function songFromAudioHandle(input: {
  fileHandle: BrowserFileHandle;
  parentDirectoryHandle: BrowserDirectoryHandle;
  pathParts: string[];
  writable: boolean;
}): Promise<LocalSongEntry> {
  const { fileHandle, parentDirectoryHandle, pathParts, writable } = input;
  const file = await fileHandle.getFile();
  const stem = stemOf(file.name);
  const sidecar = await readSidecar(parentDirectoryHandle, stem);
  const parsed = parseTitleArtist(
    stem,
    pathParts.length > 1 ? pathParts[pathParts.length - 2] : "",
    sidecar,
  );

  const coverHandle = await findCoverHandle(parentDirectoryHandle, stem, sidecar);
  const lyricsHandle = await findLyricsHandle(parentDirectoryHandle, stem, sidecar);
  const embedded = await parseEmbeddedMetadata(file, {
    skipCovers: Boolean(coverHandle),
  });

  const audioUrl = createTrackedObjectUrl(file);
  let imageUrl = "/waveform.svg";
  if (coverHandle) {
    imageUrl = createTrackedObjectUrl(await coverHandle.getFile());
  } else if (embedded.imageUrl) {
    imageUrl = embedded.imageUrl;
  }

  let lyricsUrl: string | undefined;
  if (lyricsHandle) {
    lyricsUrl = createTrackedObjectUrl(await lyricsHandle.getFile());
  } else if (embedded.lyricsUrl) {
    lyricsUrl = embedded.lyricsUrl;
  }

  const song: PlayerSong = {
    id: songIdForPath(pathParts),
    title: embedded.title || parsed.title,
    artist: embedded.artist || parsed.artist,
    imageUrl,
    audioUrl,
    lyricsUrl,
    audioBitDepth: embedded.audioBitDepth,
    audioSampleRate: embedded.audioSampleRate,
    createdAt: new Date(file.lastModified || Date.now()).toISOString(),
    source: "browser-local",
    localPath: normalizePath(pathParts),
    writable,
  };

  return {
    song,
    audioFileHandle: fileHandle,
    parentDirectoryHandle,
    pathParts,
    stem,
    sidecar,
    writable,
  };
}

async function scanActiveDirectory(): Promise<{
  directoryName: string;
  songs: PlayerSong[];
  writable: boolean;
}> {
  if (!activeDirectoryHandle) {
    throw new Error("Choose a music folder first");
  }

  const writable = await requestDirectoryPermission(activeDirectoryHandle, "readwrite");
  const files: Array<{
    fileHandle: BrowserFileHandle;
    parentDirectoryHandle: BrowserDirectoryHandle;
    pathParts: string[];
  }> = [];

  clearTrackedObjectUrls();
  entriesById.clear();
  await collectAudioFiles(activeDirectoryHandle, [], files);

  const entries = await Promise.all(
    files.map((file) => songFromAudioHandle({ ...file, writable })),
  );
  entries.sort((left, right) => {
    const byArtist = left.song.artist.localeCompare(right.song.artist);
    if (byArtist !== 0) return byArtist;
    return left.song.title.localeCompare(right.song.title);
  });

  for (const entry of entries) {
    entriesById.set(entry.song.id, entry);
  }

  return {
    directoryName: activeDirectoryHandle.name || "Music",
    songs: entries.map((entry) => entry.song),
    writable,
  };
}

function pickedFileSong(file: File): LocalSongEntry {
  const stem = stemOf(file.name);
  const parsed = parseTitleArtist(stem, "", {});
  const id = `picked-file:${encodeURIComponent(`${file.name}:${file.size}:${file.lastModified}`)}`;
  const song: PlayerSong = {
    id,
    title: parsed.title,
    artist: parsed.artist,
    imageUrl: "/waveform.svg",
    audioUrl: createTrackedObjectUrl(file),
    createdAt: new Date(file.lastModified || Date.now()).toISOString(),
    source: "picked-file",
    localPath: file.name,
    writable: false,
  };

  return {
    song,
    audioFileHandle: null,
    parentDirectoryHandle: null,
    pathParts: [file.name],
    stem,
    sidecar: {},
    writable: false,
  };
}

async function pickedFileSongWithMetadata(file: File): Promise<LocalSongEntry> {
  const entry = pickedFileSong(file);
  const embedded = await parseEmbeddedMetadata(file);
  entry.song = {
    ...entry.song,
    title: embedded.title || entry.song.title,
    artist: embedded.artist || entry.song.artist,
    imageUrl: embedded.imageUrl || entry.song.imageUrl,
    lyricsUrl: embedded.lyricsUrl,
    audioBitDepth: embedded.audioBitDepth,
    audioSampleRate: embedded.audioSampleRate,
  };
  return entry;
}

async function writeBlobFile(
  dirHandle: BrowserDirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<BrowserFileHandle> {
  const handle = await dirHandle.getFileHandle(fileName, { create: true });
  if (!handle.createWritable) {
    throw new Error("This browser cannot write files in the selected folder");
  }
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle;
}

async function writeTextFile(
  dirHandle: BrowserDirectoryHandle,
  fileName: string,
  text: string,
): Promise<BrowserFileHandle> {
  return writeBlobFile(dirHandle, fileName, new Blob([text], { type: "text/plain;charset=utf-8" }));
}

function extForBlob(blob: Blob, fallbackName: string, fallbackExt: string): string {
  const nameExt = extensionOf(fallbackName);
  if (nameExt) return nameExt;
  const type = blob.type.toLowerCase();
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  return fallbackExt;
}

async function ensureWritableFolder(): Promise<BrowserDirectoryHandle> {
  if (!activeDirectoryHandle) {
    const access = await restoreSavedDirectoryAccess();
    if (access === "missing") {
      const picker = getDirectoryPicker();
      if (!picker) {
        throw new Error("Folder write access is not available in this browser");
      }
      activeDirectoryHandle = await picker({
        id: DIRECTORY_PICKER_ID,
        mode: "readwrite",
        startIn: "music",
      });
      await persistDirectoryHandle(activeDirectoryHandle);
      writeCachedFolderName(activeDirectoryHandle.name || "Music");
    }
  }

  if (!activeDirectoryHandle) {
    throw new Error("Choose a music folder first");
  }

  const writable = await requestDirectoryPermission(activeDirectoryHandle, "readwrite");
  if (!writable) {
    throw new Error("Waveform needs folder write permission to save there");
  }
  return activeDirectoryHandle;
}

export async function saveBrowserLocalSongEdits(
  song: PlayerSong,
  edits: BrowserLocalSongEdits,
): Promise<PlayerSong> {
  const entry = entriesById.get(song.id);
  if (!entry?.parentDirectoryHandle) {
    throw new Error("Choose a writable folder before editing local songs");
  }

  const canWrite = await requestDirectoryPermission(entry.parentDirectoryHandle, "readwrite");
  if (!canWrite) {
    throw new Error("Waveform needs folder write permission to save changes");
  }

  const title = edits.title.trim();
  const artist = edits.artist.trim();
  if (!title || !artist) {
    throw new Error("Title and artist are required");
  }

  const nextSidecar: LocalSidecar = {
    ...entry.sidecar,
    version: 1,
    title,
    artist,
    updatedAt: new Date().toISOString(),
  };

  let imageUrl = song.imageUrl;
  let lyricsUrl = song.lyricsUrl;

  if (edits.coverFile) {
    const ext = extForBlob(edits.coverFile, edits.coverFile.name, ".jpg");
    const coverName = `${entry.stem}.cover${ext}`;
    await writeBlobFile(entry.parentDirectoryHandle, coverName, edits.coverFile);
    nextSidecar.coverFile = coverName;
    imageUrl = createTrackedObjectUrl(edits.coverFile);
  }

  if (edits.lyricsFile) {
    const ext = LYRICS_EXTENSIONS.includes(extensionOf(edits.lyricsFile.name))
      ? extensionOf(edits.lyricsFile.name)
      : ".lrc";
    const lyricsName = `${entry.stem}${ext}`;
    await writeBlobFile(entry.parentDirectoryHandle, lyricsName, edits.lyricsFile);
    nextSidecar.lyricsFile = lyricsName;
    lyricsUrl = createTrackedObjectUrl(edits.lyricsFile);
  } else if (edits.lyricsText?.trim()) {
    const lyricsName = `${entry.stem}.lrc`;
    const fileHandle = await writeTextFile(
      entry.parentDirectoryHandle,
      lyricsName,
      edits.lyricsText.trim(),
    );
    nextSidecar.lyricsFile = lyricsName;
    lyricsUrl = createTrackedObjectUrl(await fileHandle.getFile());
  }

  await writeTextFile(
    entry.parentDirectoryHandle,
    `${entry.stem}.waveform.json`,
    `${JSON.stringify(nextSidecar, null, 2)}\n`,
  );

  const updatedSong: PlayerSong = {
    ...song,
    title,
    artist,
    imageUrl,
    lyricsUrl,
    writable: true,
  };
  entry.song = updatedSong;
  entry.sidecar = nextSidecar;
  entry.writable = true;
  entriesById.set(song.id, entry);
  return updatedSong;
}

async function saveDownloadedTrackToFolder(input: SaveDownloadedTrackInput): Promise<PlayerSong> {
  const root = await ensureWritableFolder();
  const artistSegment = sanitizeFileSegment(input.artist);
  const titleSegment = sanitizeFileSegment(input.title);
  const artistDir = await root.getDirectoryHandle(artistSegment, { create: true });
  const songDir = await artistDir.getDirectoryHandle(titleSegment, { create: true });
  const audioExt = extForBlob(input.audioBlob, input.audioFileName, ".flac");
  const audioStem = sanitizeFileSegment(`${input.artist} - ${input.title}`);
  const audioName = `${audioStem}${audioExt}`;
  const audioHandle = await writeBlobFile(songDir, audioName, input.audioBlob);

  const sidecar: LocalSidecar = {
    version: 1,
    title: input.title,
    artist: input.artist,
    updatedAt: new Date().toISOString(),
  };

  if (input.coverBlob) {
    const coverExt = extForBlob(input.coverBlob, input.coverFileName || "cover.jpg", ".jpg");
    const coverName = `cover${coverExt}`;
    await writeBlobFile(songDir, coverName, input.coverBlob);
    sidecar.coverFile = coverName;
  }

  if (input.lyricsText?.trim()) {
    const lyricsName = `${titleSegment}.lrc`;
    await writeTextFile(songDir, lyricsName, input.lyricsText.trim());
    sidecar.lyricsFile = lyricsName;
  }

  await writeTextFile(
    songDir,
    `${audioStem}.waveform.json`,
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );

  const entry = await songFromAudioHandle({
    fileHandle: audioHandle,
    parentDirectoryHandle: songDir,
    pathParts: [artistSegment, titleSegment, audioName],
    writable: true,
  });
  entriesById.set(entry.song.id, entry);
  return entry.song;
}

function upsertSong(songs: PlayerSong[], song: PlayerSong): PlayerSong[] {
  const index = songs.findIndex((item) => item.id === song.id);
  if (index < 0) {
    return [...songs, song].sort((left, right) => {
      const byArtist = left.artist.localeCompare(right.artist);
      if (byArtist !== 0) return byArtist;
      return left.title.localeCompare(right.title);
    });
  }
  const next = songs.slice();
  next[index] = song;
  return next;
}

export const useBrowserLocalLibraryStore = create<BrowserLocalLibraryState>((set, get) => ({
  supported: false,
  hydrated: false,
  directoryName: "",
  songs: [],
  status: "idle",
  error: null,
  writable: false,
  pickedFileMode: false,
  scannedAt: null,
  hydrateCapabilities: () => {
    if (get().hydrated) return;

    void (async () => {
      const supported = isBrowserFolderAccessSupported();
      set({ supported, hydrated: true });
      if (!supported) return;
      await restoreSavedLibrary((partial) => set(partial));
    })();
  },
  chooseDirectory: async () => {
    const picker = getDirectoryPicker();
    if (!picker) {
      set({
        supported: false,
        status: "error",
        error: "Folder access is not available in this browser",
      });
      return;
    }

    set({ status: "scanning", error: null, supported: true });
    try {
      activeDirectoryHandle = await picker({
        id: DIRECTORY_PICKER_ID,
        mode: "readwrite",
        startIn: "music",
      });
      await persistDirectoryHandle(activeDirectoryHandle);
      const result = await scanActiveDirectory();
      writeCachedFolderName(result.directoryName);
      set({
        directoryName: result.directoryName,
        songs: result.songs,
        status: "ready",
        error: null,
        writable: result.writable,
        pickedFileMode: false,
        scannedAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set({ status: get().songs.length > 0 ? "ready" : "idle", error: null });
        return;
      }
      set({
        status: "error",
        error: error instanceof Error ? error.message : "Failed to open folder",
      });
    }
  },
  rescan: async () => {
    if (!activeDirectoryHandle) {
      const access = await restoreSavedDirectoryAccess();
      if (access === "missing") {
        set({
          status: "error",
          error: "Choose a music folder in Settings first",
        });
        return;
      }
    }

    await restoreSavedLibrary((partial) => set(partial));
  },
  loadPickedFiles: (filesInput) => {
    void (async () => {
      const files = Array.from(filesInput).filter((file) =>
        AUDIO_EXTENSIONS.has(extensionOf(file.name)),
      );
      clearTrackedObjectUrls();
      entriesById.clear();
      activeDirectoryHandle = null;
      void clearPersistedDirectoryHandle();
      clearCachedFolderName();

      if (files.length === 0) {
        set({
          directoryName: "",
          songs: [],
          status: "idle",
          error: "No supported audio files selected",
          writable: false,
          pickedFileMode: true,
          scannedAt: null,
        });
        return;
      }

      set({
        directoryName: "Selected files",
        songs: [],
        status: "scanning",
        error: null,
        writable: false,
        pickedFileMode: true,
        scannedAt: null,
      });

      const entries = await Promise.all(files.map(pickedFileSongWithMetadata));
      for (const entry of entries) {
        entriesById.set(entry.song.id, entry);
      }
      set({
        directoryName: "Selected files",
        songs: entries.map((entry) => entry.song),
        status: "ready",
        error: null,
        writable: false,
        pickedFileMode: true,
        scannedAt: Date.now(),
      });
    })();
  },
  saveDownloadedTrack: async (input) => {
    set({ error: null });
    const song = await saveDownloadedTrackToFolder(input);
    set((state) => ({
      supported: true,
      directoryName: activeDirectoryHandle?.name || state.directoryName || "Music",
      songs: upsertSong(state.songs, song),
      status: "ready",
      error: null,
      writable: true,
      pickedFileMode: false,
      scannedAt: Date.now(),
    }));
    return song;
  },
  replaceSong: (song) => {
    set((state) => ({ songs: upsertSong(state.songs, song) }));
  },
}));
