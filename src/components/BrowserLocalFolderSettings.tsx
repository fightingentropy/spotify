"use client";

import { useRef, type InputHTMLAttributes } from "react";
import { FolderOpen, Loader2, Music2, RefreshCw, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export default function BrowserLocalFolderSettings() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const supported = useBrowserLocalLibraryStore((state) => state.supported);
  const folderPickerKind = useBrowserLocalLibraryStore((state) => state.folderPickerKind);
  const hydrated = useBrowserLocalLibraryStore((state) => state.hydrated);
  const directoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const songs = useBrowserLocalLibraryStore((state) => state.songs);
  const status = useBrowserLocalLibraryStore((state) => state.status);
  const error = useBrowserLocalLibraryStore((state) => state.error);
  const writable = useBrowserLocalLibraryStore((state) => state.writable);
  const pickedFileMode = useBrowserLocalLibraryStore((state) => state.pickedFileMode);
  const chooseDirectory = useBrowserLocalLibraryStore((state) => state.chooseDirectory);
  const rescan = useBrowserLocalLibraryStore((state) => state.rescan);
  const loadPickedFolder = useBrowserLocalLibraryStore((state) => state.loadPickedFolder);
  const loadPickedFiles = useBrowserLocalLibraryStore((state) => state.loadPickedFiles);

  const busy = status === "scanning";
  const hasSongs = songs.length > 0;
  const hasSavedFolder = Boolean(directoryName) && !pickedFileMode;
  const usesFolderPicker = folderPickerKind === "handle" || folderPickerKind === "webkit";
  const statusLabel = busy
    ? "Scanning"
    : hasSongs
      ? `${songs.length.toLocaleString()} local ${songs.length === 1 ? "track" : "tracks"}`
      : hydrated && !usesFolderPicker
        ? "File picker mode"
        : folderPickerKind === "webkit" && hasSavedFolder
          ? "Reconnect folder"
          : "No folder selected";

  const openFolderPicker = () => {
    if (folderPickerKind === "webkit") {
      folderInputRef.current?.click();
      return;
    }
    void chooseDirectory();
  };

  const reconnectFolder = () => {
    if (folderPickerKind === "webkit") {
      folderInputRef.current?.click();
      return;
    }
    void rescan();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Local Folder</h2>
        <p className="text-sm opacity-70 mb-4">
          Choose a folder on this device for Waveform to read, play, and optionally save music to.
          {folderPickerKind === "webkit"
            ? " On iPhone and iPad, pick a folder from Files or iCloud Drive."
            : " Your selection stays in this browser and is remembered across visits."}
        </p>

        <div className="rounded border border-black/10 dark:border-white/10 p-4">
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files && event.target.files.length > 0) {
                loadPickedFolder(event.target.files);
              }
              event.currentTarget.value = "";
            }}
            {...({ webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>)}
          />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
                <Music2 size={20} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {directoryName || "On-device music"}
                </div>
                <div className="truncate text-xs text-foreground/60">
                  {statusLabel}
                  {hasSongs && !pickedFileMode && folderPickerKind === "handle"
                    ? ` · ${writable ? "Writable" : "Read only"}`
                    : ""}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {usesFolderPicker ? (
                <button
                  type="button"
                  onClick={openFolderPicker}
                  disabled={busy}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-60 sm:flex-none"
                >
                  {busy ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <FolderOpen size={16} />
                  )}
                  {hasSongs || hasSavedFolder ? "Change Folder" : "Choose Folder"}
                </button>
              ) : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      if (event.target.files) {
                        loadPickedFiles(event.target.files);
                      }
                      event.currentTarget.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background sm:flex-none"
                  >
                    <Upload size={16} />
                    Choose Files
                  </button>
                </>
              )}

              {hasSavedFolder && usesFolderPicker ? (
                <button
                  type="button"
                  onClick={reconnectFolder}
                  disabled={busy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-medium disabled:opacity-60 dark:border-white/15"
                  title={hasSongs ? "Rescan folder" : "Reconnect folder"}
                >
                  <RefreshCw size={16} className={cn(busy && "animate-spin")} />
                  <span className="hidden sm:inline">{hasSongs ? "Rescan" : "Reconnect"}</span>
                </button>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </div>
          ) : null}

          {hasSavedFolder && status === "idle" && !hasSongs && folderPickerKind === "handle" ? (
            <p className="mt-3 text-sm text-foreground/60">
              Your <span className="font-medium text-foreground">{directoryName}</span> folder is
              remembered. Click Reconnect if tracks do not load automatically.
            </p>
          ) : null}

          {hasSavedFolder && status === "idle" && !hasSongs && folderPickerKind === "webkit" ? (
            <p className="mt-3 text-sm text-foreground/60">
              Your <span className="font-medium text-foreground">{directoryName}</span> folder was
              remembered. Tap Reconnect and choose the same folder in Files or iCloud Drive to load
              tracks again.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
