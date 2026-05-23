"use client";

import { useRef } from "react";
import { FolderOpen, Loader2, Music2, RefreshCw, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export default function BrowserLocalFolderSettings() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const supported = useBrowserLocalLibraryStore((state) => state.supported);
  const hydrated = useBrowserLocalLibraryStore((state) => state.hydrated);
  const directoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const songs = useBrowserLocalLibraryStore((state) => state.songs);
  const status = useBrowserLocalLibraryStore((state) => state.status);
  const error = useBrowserLocalLibraryStore((state) => state.error);
  const writable = useBrowserLocalLibraryStore((state) => state.writable);
  const pickedFileMode = useBrowserLocalLibraryStore((state) => state.pickedFileMode);
  const chooseDirectory = useBrowserLocalLibraryStore((state) => state.chooseDirectory);
  const rescan = useBrowserLocalLibraryStore((state) => state.rescan);
  const loadPickedFiles = useBrowserLocalLibraryStore((state) => state.loadPickedFiles);

  const busy = status === "scanning";
  const hasSongs = songs.length > 0;
  const hasSavedFolder = Boolean(directoryName) && !pickedFileMode;
  const statusLabel = busy
    ? "Scanning"
    : hasSongs
      ? `${songs.length.toLocaleString()} local ${songs.length === 1 ? "track" : "tracks"}`
      : hydrated && !supported
        ? "File picker mode"
        : "No folder selected";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Local Folder</h2>
        <p className="text-sm opacity-70 mb-4">
          Choose a folder on this device for Waveform to read, play, and optionally save music to.
          Your selection is remembered across visits.
        </p>

        <div className="rounded border border-black/10 dark:border-white/10 p-4">
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
                  {hasSongs && !pickedFileMode ? ` · ${writable ? "Writable" : "Read only"}` : ""}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {supported ? (
                <button
                  type="button"
                  onClick={() => void chooseDirectory()}
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
                    ref={inputRef}
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
                    onClick={() => inputRef.current?.click()}
                    className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background sm:flex-none"
                  >
                    <Upload size={16} />
                    Choose Files
                  </button>
                </>
              )}

              {hasSavedFolder && supported ? (
                <button
                  type="button"
                  onClick={() => void rescan()}
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

          {hasSavedFolder && status === "idle" && !hasSongs ? (
            <p className="mt-3 text-sm text-foreground/60">
              Your <span className="font-medium text-foreground">{directoryName}</span> folder is
              remembered. Click Reconnect if tracks do not load automatically.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
