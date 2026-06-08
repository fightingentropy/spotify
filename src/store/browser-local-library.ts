"use client";

import { create } from "zustand";
import { isBrowserLocalSong } from "@/lib/browser-local-song";
import type { PlayerSong } from "@/types/player";

export { isBrowserLocalSong };

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
  folderPickerKind: FolderPickerKind;
  hydrated: boolean;
  directoryName: string;
  songs: PlayerSong[];
  status: "idle" | "scanning" | "ready" | "error";
  error: string | null;
  writable: boolean;
  pickedFileMode: boolean;
  scannedAt: number | null;
  saveDownloadedTrack: (input: SaveDownloadedTrackInput) => Promise<PlayerSong>;
};

export type FolderPickerKind = "handle" | "webkit" | "files";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const LYRICS_EXTENSIONS = [".lrc", ".txt"];
const DIRECTORY_PICKER_ID = "spotify-music-library";
const HANDLE_DB_NAME = "spotify-local-library";
const HANDLE_DB_VERSION = 2;
const HANDLE_STORE_NAME = "handles";
const HANDLE_KEY = "directory";
const PICKED_FOLDER_STORE_NAME = "picked-folder-files";
const FOLDER_NAME_STORAGE_KEY = "spotify_browser_local_folder_name";
const FOLDER_ACCESS_KIND_KEY = "spotify_browser_local_folder_access_kind";

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

export function isWebkitDirectorySupported(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input");
  input.type = "file";
  return "webkitdirectory" in input;
}

export function resolveFolderPickerKind(): FolderPickerKind {
  if (isBrowserFolderAccessSupported()) return "handle";
  if (isWebkitDirectorySupported()) return "webkit";
  return "files";
}

export function isBrowserFolderPickerSupported(): boolean {
  const kind = resolveFolderPickerKind();
  return kind === "handle" || kind === "webkit";
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

function writeCachedFolderName(name: string) {
  try {
    localStorage.setItem(FOLDER_NAME_STORAGE_KEY, name);
  } catch {}
}

function writeCachedFolderAccessKind(kind: FolderPickerKind) {
  try {
    localStorage.setItem(FOLDER_ACCESS_KIND_KEY, kind);
  } catch {}
}

function openDirectoryHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(PICKED_FOLDER_STORE_NAME)) {
        db.createObjectStore(PICKED_FOLDER_STORE_NAME, { keyPath: "relativePath" });
      }
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

async function clearPickedFolderSnapshot(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  let db: IDBDatabase | null = null;
  try {
    db = await openDirectoryHandleDb();
    const database = db;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(PICKED_FOLDER_STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to clear offline folder"));
      tx.objectStore(PICKED_FOLDER_STORE_NAME).clear();
    });
  } catch {}
  db?.close();
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
  duration?: number;
  audioBitDepth?: number;
  audioSampleRate?: number;
};

async function parseEmbeddedMetadata(
  file: File,
  options?: { skipCovers?: boolean; skipLyrics?: boolean },
): Promise<EmbeddedAudioMetadata> {
  try {
    const { parseBlob, selectCover } = await import("music-metadata");
    const metadata = await parseBlob(file, {
      duration: true,
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

    if (!options?.skipLyrics) {
      const embeddedLyrics = metadata.common.lyrics?.filter(Boolean).join("\n\n").trim();
      if (embeddedLyrics) {
        result.lyricsUrl = createTrackedObjectUrl(
          new Blob([embeddedLyrics], { type: "text/plain;charset=utf-8" }),
        );
      }
    }

    const bits = metadata.format.bitsPerSample;
    if (typeof bits === "number" && Number.isFinite(bits)) {
      result.audioBitDepth = Math.round(bits);
    }
    const sampleRate = metadata.format.sampleRate;
    if (typeof sampleRate === "number" && Number.isFinite(sampleRate)) {
      result.audioSampleRate = Math.round(sampleRate);
    }
    const duration = metadata.format.duration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      result.duration = duration;
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
  const handle = await getOptionalFileHandle(dirHandle, `${stem}.spotify.json`);
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
    skipLyrics: Boolean(lyricsHandle),
  });

  const audioUrl = createTrackedObjectUrl(file);
  let imageUrl = "/apple-icon.png";
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
    duration: embedded.duration,
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
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
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
    throw new Error("This folder needs write permission to save songs");
  }
  return activeDirectoryHandle;
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
    `${audioStem}.spotify.json`,
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

export const useBrowserLocalLibraryStore = create<BrowserLocalLibraryState>((set) => ({
  supported: false,
  folderPickerKind: "files",
  hydrated: false,
  directoryName: "",
  songs: [],
  status: "idle",
  error: null,
  writable: false,
  pickedFileMode: false,
  scannedAt: null,
  saveDownloadedTrack: async (input) => {
    set({ error: null });
    const song = await saveDownloadedTrackToFolder(input);
    await clearPickedFolderSnapshot();
    writeCachedFolderAccessKind("handle");
    set((state) => ({
      supported: true,
      directoryName: activeDirectoryHandle?.name || state.directoryName || "Music",
      songs: upsertSong(state.songs, song),
      status: "ready",
      error: null,
      writable: true,
      pickedFileMode: false,
      folderPickerKind: "handle",
      scannedAt: Date.now(),
    }));
    return song;
  },
}));
