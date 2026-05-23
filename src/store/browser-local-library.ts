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
  folderPickerKind: FolderPickerKind;
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
  loadPickedFolder: (files: FileList | File[]) => void;
  loadPickedFiles: (files: FileList | File[]) => void;
  saveDownloadedTrack: (input: SaveDownloadedTrackInput) => Promise<PlayerSong>;
  replaceSong: (song: PlayerSong) => void;
};

export type FolderPickerKind = "handle" | "webkit" | "files";

type DirectoryPickerFile = File & { webkitRelativePath?: string };
type PickedFolderFile = {
  file: File;
  relativePath: string;
};
type PersistedPickedFolderFile = {
  relativePath: string;
  file: File;
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
const HANDLE_DB_VERSION = 2;
const HANDLE_STORE_NAME = "handles";
const HANDLE_KEY = "directory";
const PICKED_FOLDER_STORE_NAME = "picked-folder-files";
const FOLDER_NAME_STORAGE_KEY = "wf_browser_local_folder_name";
const FOLDER_ACCESS_KIND_KEY = "wf_browser_local_folder_access_kind";

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

function normalizeRelativePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function pickedFolderFileFromFile(file: DirectoryPickerFile): PickedFolderFile {
  const relativePath = normalizeRelativePath(file.webkitRelativePath?.trim() || file.name);
  return {
    file,
    relativePath: relativePath || file.name,
  };
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

function writeCachedFolderAccessKind(kind: FolderPickerKind) {
  try {
    localStorage.setItem(FOLDER_ACCESS_KIND_KEY, kind);
  } catch {}
}

function readCachedFolderAccessKind(): FolderPickerKind | null {
  try {
    const value = localStorage.getItem(FOLDER_ACCESS_KIND_KEY);
    if (value === "handle" || value === "webkit" || value === "files") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function clearCachedFolderAccessKind() {
  try {
    localStorage.removeItem(FOLDER_ACCESS_KIND_KEY);
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

async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {}
}

function isPersistablePickedFolderFile(entry: PickedFolderFile): boolean {
  const name = entry.file.name.toLowerCase();
  const extension = extensionOf(name);
  return (
    AUDIO_EXTENSIONS.has(extension) ||
    IMAGE_EXTENSIONS.includes(extension) ||
    LYRICS_EXTENSIONS.includes(extension) ||
    name.endsWith(".waveform.json")
  );
}

async function persistPickedFolderSnapshot(files: PickedFolderFile[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await requestPersistentStorage();

  const snapshotFiles = files.filter(isPersistablePickedFolderFile);
  const db = await openDirectoryHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PICKED_FOLDER_STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save offline folder"));
      tx.onabort = () => reject(tx.error ?? new Error("Failed to save offline folder"));

      const store = tx.objectStore(PICKED_FOLDER_STORE_NAME);
      store.clear();
      for (const entry of snapshotFiles) {
        const record: PersistedPickedFolderFile = {
          relativePath: entry.relativePath,
          file: entry.file,
        };
        store.put(record);
      }
    });
  } finally {
    db.close();
  }
}

async function readPickedFolderSnapshot(): Promise<PickedFolderFile[]> {
  if (typeof indexedDB === "undefined") return [];

  const db = await openDirectoryHandleDb();
  try {
    const records = await new Promise<PersistedPickedFolderFile[]>((resolve, reject) => {
      const tx = db.transaction(PICKED_FOLDER_STORE_NAME, "readonly");
      const request = tx.objectStore(PICKED_FOLDER_STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as PersistedPickedFolderFile[]);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to read offline folder"));
      tx.onerror = () => reject(tx.error ?? new Error("Failed to read offline folder"));
    });

    return records
      .filter((record) => record.file instanceof File && record.relativePath)
      .map((record) => ({
        file: record.file,
        relativePath: normalizeRelativePath(record.relativePath) || record.file.name,
      }));
  } catch {
    return [];
  } finally {
    db.close();
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
      folderPickerKind: "handle",
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

async function restorePickedFolderSnapshot(
  apply: (partial: Partial<BrowserLocalLibraryState>) => void,
): Promise<boolean> {
  const cachedName = readCachedFolderName();
  const files = await readPickedFolderSnapshot();

  if (files.length === 0) {
    if (cachedName) {
      apply({
        directoryName: cachedName,
        status: "idle",
        error: null,
        writable: false,
        pickedFileMode: false,
        folderPickerKind: "webkit",
      });
    } else {
      clearCachedFolderAccessKind();
    }
    return false;
  }

  apply({
    directoryName: cachedName || folderNameFromPickedFiles(files),
    status: "scanning",
    error: null,
    writable: false,
    pickedFileMode: false,
    folderPickerKind: "webkit",
  });

  try {
    const result = await scanPickedFolderFiles(files);
    if (result.songs.length === 0) {
      await clearPickedFolderSnapshot();
      clearCachedFolderName();
      clearCachedFolderAccessKind();
      apply({
        directoryName: "",
        songs: [],
        status: "idle",
        error: "No supported audio files found in the saved offline folder",
        writable: false,
        pickedFileMode: false,
        folderPickerKind: "webkit",
        scannedAt: null,
      });
      return false;
    }

    writeCachedFolderName(result.directoryName);
    writeCachedFolderAccessKind("webkit");
    apply({
      directoryName: result.directoryName,
      songs: result.songs,
      status: "ready",
      error: null,
      writable: false,
      pickedFileMode: false,
      folderPickerKind: "webkit",
      scannedAt: Date.now(),
    });
    return true;
  } catch (error) {
    apply({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to restore offline folder",
      writable: false,
      pickedFileMode: false,
      folderPickerKind: "webkit",
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

function directoryKeyForRelativePath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function pathPartsForRelativePath(relativePath: string): string[] {
  return relativePath.split("/").filter(Boolean);
}

function folderNameFromPickedFiles(files: PickedFolderFile[]): string {
  for (const entry of files) {
    const relativePath = entry.relativePath.trim();
    if (!relativePath) continue;
    const [root] = relativePath.split("/");
    if (root) return root;
  }
  return "Music folder";
}

function buildDirectoryIndex(files: PickedFolderFile[]): Map<string, PickedFolderFile[]> {
  const byDirectory = new Map<string, PickedFolderFile[]>();
  for (const entry of files) {
    const relativePath = entry.relativePath || entry.file.name;
    const directoryKey = directoryKeyForRelativePath(relativePath);
    const bucket = byDirectory.get(directoryKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byDirectory.set(directoryKey, [entry]);
    }
  }
  return byDirectory;
}

async function readSidecarFromFiles(
  files: PickedFolderFile[],
  stem: string,
): Promise<LocalSidecar> {
  const sidecarEntry = files.find((entry) => entry.file.name === `${stem}.waveform.json`);
  if (!sidecarEntry) return {};
  try {
    const parsed = JSON.parse(await sidecarEntry.file.text()) as LocalSidecar;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function findCoverFileInDirectory(
  files: PickedFolderFile[],
  stem: string,
  sidecar: LocalSidecar,
): File | null {
  if (sidecar.coverFile) {
    const fromSidecar = files.find((entry) => entry.file.name === sidecar.coverFile);
    if (fromSidecar) return fromSidecar.file;
  }

  for (const ext of IMAGE_EXTENSIONS) {
    for (const candidate of [
      `${stem}${ext}`,
      `${stem}.cover${ext}`,
      `cover${ext}`,
      `folder${ext}`,
    ]) {
      const match = files.find((entry) => entry.file.name === candidate);
      if (match) return match.file;
    }
  }
  return null;
}

function findLyricsFileInDirectory(
  files: PickedFolderFile[],
  stem: string,
  sidecar: LocalSidecar,
): File | null {
  if (sidecar.lyricsFile) {
    const fromSidecar = files.find((entry) => entry.file.name === sidecar.lyricsFile);
    if (fromSidecar) return fromSidecar.file;
  }

  for (const ext of LYRICS_EXTENSIONS) {
    const match = files.find((entry) => entry.file.name === `${stem}${ext}`);
    if (match) return match.file;
  }
  return null;
}

async function songFromPickedFolderFile(
  entry: PickedFolderFile,
  pathParts: string[],
  directoryFiles: PickedFolderFile[],
): Promise<LocalSongEntry> {
  const { file } = entry;
  const stem = stemOf(file.name);
  const sidecar = await readSidecarFromFiles(directoryFiles, stem);
  const parsed = parseTitleArtist(
    stem,
    pathParts.length > 1 ? pathParts[pathParts.length - 2] : "",
    sidecar,
  );

  const coverFile = findCoverFileInDirectory(directoryFiles, stem, sidecar);
  const lyricsFile = findLyricsFileInDirectory(directoryFiles, stem, sidecar);
  const embedded = await parseEmbeddedMetadata(file, {
    skipCovers: Boolean(coverFile),
  });

  const audioUrl = createTrackedObjectUrl(file);
  let imageUrl = "/apple-icon.png";
  if (coverFile) {
    imageUrl = createTrackedObjectUrl(coverFile);
  } else if (embedded.imageUrl) {
    imageUrl = embedded.imageUrl;
  }

  let lyricsUrl: string | undefined;
  if (lyricsFile) {
    lyricsUrl = createTrackedObjectUrl(lyricsFile);
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
    writable: false,
  };

  return {
    song,
    audioFileHandle: null,
    parentDirectoryHandle: null,
    pathParts,
    stem,
    sidecar,
    writable: false,
  };
}

async function scanPickedFolderFiles(files: PickedFolderFile[]): Promise<{
  directoryName: string;
  songs: PlayerSong[];
}> {
  const directoryIndex = buildDirectoryIndex(files);
  const audioFiles = files.filter((entry) => AUDIO_EXTENSIONS.has(extensionOf(entry.file.name)));

  clearTrackedObjectUrls();
  entriesById.clear();
  activeDirectoryHandle = null;

  const entries = await Promise.all(
    audioFiles.map(async (entry) => {
      const relativePath = entry.relativePath || entry.file.name;
      const pathParts = pathPartsForRelativePath(relativePath);
      const directoryKey = directoryKeyForRelativePath(relativePath);
      const directoryFiles = directoryIndex.get(directoryKey) ?? [entry];
      return songFromPickedFolderFile(entry, pathParts, directoryFiles);
    }),
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
    directoryName: folderNameFromPickedFiles(files),
    songs: entries.map((entry) => entry.song),
  };
}

async function scanPickedFolder(filesInput: FileList | File[]): Promise<{
  directoryName: string;
  songs: PlayerSong[];
  files: PickedFolderFile[];
}> {
  const files = Array.from(filesInput, (file) =>
    pickedFolderFileFromFile(file as DirectoryPickerFile),
  );
  const result = await scanPickedFolderFiles(files);
  return { ...result, files };
}

function pickedFileSong(file: File): LocalSongEntry {
  const stem = stemOf(file.name);
  const parsed = parseTitleArtist(stem, "", {});
  const id = `picked-file:${encodeURIComponent(`${file.name}:${file.size}:${file.lastModified}`)}`;
  const song: PlayerSong = {
    id,
    title: parsed.title,
    artist: parsed.artist,
    imageUrl: "/apple-icon.png",
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
    throw new Error("This folder needs write permission to save edits");
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
  folderPickerKind: "files",
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
      const folderPickerKind = resolveFolderPickerKind();
      const supported = folderPickerKind !== "files";
      set({ supported, folderPickerKind, hydrated: true });

      if (folderPickerKind === "handle") {
        await restoreSavedLibrary((partial) => set(partial));
        return;
      }

      if (folderPickerKind === "webkit") {
        const cachedKind = readCachedFolderAccessKind();
        if (cachedKind === "webkit") {
          await restorePickedFolderSnapshot((partial) => set(partial));
        }
      }
    })();
  },
  chooseDirectory: async () => {
    const picker = getDirectoryPicker();
    if (!picker) {
      set({
        status: "error",
        error: "Use Choose Folder to open your music folder in Files or iCloud Drive",
      });
      return;
    }

    set({ status: "scanning", error: null, supported: true, folderPickerKind: "handle" });
    try {
      activeDirectoryHandle = await picker({
        id: DIRECTORY_PICKER_ID,
        mode: "readwrite",
        startIn: "music",
      });
      await persistDirectoryHandle(activeDirectoryHandle);
      const result = await scanActiveDirectory();
      await clearPickedFolderSnapshot();
      writeCachedFolderName(result.directoryName);
      writeCachedFolderAccessKind("handle");
      set({
        directoryName: result.directoryName,
        songs: result.songs,
        status: "ready",
        error: null,
        writable: result.writable,
        pickedFileMode: false,
        folderPickerKind: "handle",
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
    if (get().folderPickerKind === "webkit") {
      set({
        status: "idle",
        error: null,
      });
      return;
    }

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
  loadPickedFolder: (filesInput) => {
    void (async () => {
      set({
        status: "scanning",
        error: null,
        supported: true,
        folderPickerKind: "webkit",
        pickedFileMode: false,
        writable: false,
      });

      try {
        const result = await scanPickedFolder(filesInput);
        if (result.songs.length === 0) {
          await clearPersistedDirectoryHandle();
          await clearPickedFolderSnapshot();
          clearCachedFolderName();
          clearCachedFolderAccessKind();
          set({
            directoryName: "",
            songs: [],
            status: "idle",
            error: "No supported audio files found in that folder",
            writable: false,
            pickedFileMode: false,
            folderPickerKind: "webkit",
            scannedAt: null,
          });
          return;
        }

        await clearPersistedDirectoryHandle();
        let snapshotError: string | null = null;
        try {
          await persistPickedFolderSnapshot(result.files);
        } catch {
          snapshotError =
            "Folder loaded, but this device did not allow Spotify to save it for offline use";
        }
        writeCachedFolderName(result.directoryName);
        writeCachedFolderAccessKind("webkit");
        set({
          directoryName: result.directoryName,
          songs: result.songs,
          status: "ready",
          error: snapshotError,
          writable: false,
          pickedFileMode: false,
          folderPickerKind: "webkit",
          scannedAt: Date.now(),
        });
      } catch (error) {
        set({
          status: "error",
          error: error instanceof Error ? error.message : "Failed to read folder",
          folderPickerKind: "webkit",
        });
      }
    })();
  },
  loadPickedFiles: (filesInput) => {
    void (async () => {
      const files = Array.from(filesInput).filter((file) =>
        AUDIO_EXTENSIONS.has(extensionOf(file.name)),
      );
      clearTrackedObjectUrls();
      entriesById.clear();
      activeDirectoryHandle = null;
      await clearPersistedDirectoryHandle();
      await clearPickedFolderSnapshot();
      clearCachedFolderName();
      clearCachedFolderAccessKind();

      if (files.length === 0) {
        set({
          directoryName: "",
          songs: [],
          status: "idle",
          error: "No supported audio files selected",
          writable: false,
          pickedFileMode: true,
          folderPickerKind: "files",
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
        folderPickerKind: "files",
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
        folderPickerKind: "files",
        scannedAt: Date.now(),
      });
    })();
  },
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
  replaceSong: (song) => {
    set((state) => ({ songs: upsertSong(state.songs, song) }));
  },
}));
