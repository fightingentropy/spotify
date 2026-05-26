"use client";

import { useEffect, type MouseEvent } from "react";
import { CheckCircle2, CircleArrowDown, Loader2, RefreshCw, X } from "lucide-react";
import {
  getScopeDownloadState,
  getSongDownloadState,
  type DownloadScope,
  useOfflineStore,
} from "@/client/offline";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";

type OfflineSongDownloadButtonProps = {
  song: PlayerSong;
  className?: string;
};

type OfflineBulkDownloadButtonProps = {
  songs: PlayerSong[];
  scope: DownloadScope;
  label?: string;
  className?: string;
  iconOnly?: boolean;
};

function canCacheSong(song: PlayerSong): boolean {
  if (song.source === "browser-local" || song.source === "picked-file") return false;
  if (!song.audioUrl || /^(blob:|data:)/i.test(song.audioUrl)) return false;
  try {
    return new URL(song.audioUrl, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

export function OfflineSongDownloadButton({ song, className }: OfflineSongDownloadButtonProps) {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const record = useOfflineStore((state) => state.records[song.id]);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const removeDownload = useOfflineStore((state) => state.removeDownload);
  const status = getSongDownloadState(record);
  const busy = status === "queued" || status === "downloading";

  if (!canCacheSong(song)) return null;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (busy) return;
    if (status === "downloaded") {
      await removeDownload(song.id);
      return;
    }
    await queueDownloads([song], `song:${song.id}`);
  }

  const title =
    status === "downloaded"
      ? "Remove offline download"
      : status === "failed"
        ? "Retry offline download"
        : busy
          ? "Downloading"
          : "Download for offline playback";

  const Icon =
    status === "downloaded"
      ? CheckCircle2
      : status === "failed"
        ? RefreshCw
        : busy
          ? Loader2
          : CircleArrowDown;

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={handleClick}
      disabled={busy}
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        status === "downloaded"
          ? "text-emerald-500"
          : status === "failed"
            ? "text-red-300"
            : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
        busy && "cursor-wait opacity-70",
        className,
      )}
    >
      <Icon size={18} className={cn(busy && "animate-spin")} />
    </button>
  );
}

export function OfflineBulkDownloadButton({
  songs,
  scope,
  label = "Download",
  className,
  iconOnly = false,
}: OfflineBulkDownloadButtonProps) {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const records = useOfflineStore((state) => state.records);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const removeScope = useOfflineStore((state) => state.removeScope);
  const status = getScopeDownloadState(records, songs, scope);
  const cacheableSongs = songs.filter(canCacheSong);
  const busy = status === "downloading";
  const downloaded = status === "downloaded";

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  async function handleClick() {
    if (busy || cacheableSongs.length === 0) return;
    if (downloaded) {
      await removeScope(scope);
      return;
    }
    await queueDownloads(cacheableSongs, scope);
  }

  const Icon = downloaded ? X : status === "failed" ? RefreshCw : busy ? Loader2 : CircleArrowDown;
  const text = downloaded
    ? "Remove downloads"
    : status === "failed"
      ? "Retry downloads"
      : status === "partial"
        ? "Finish download"
        : busy
          ? "Downloading"
          : label;

  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      disabled={busy || cacheableSongs.length === 0}
      onClick={handleClick}
      className={cn(
        iconOnly
          ? "grid h-11 w-11 place-items-center rounded-full"
          : "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium",
        "shrink-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        downloaded
          ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"
          : "bg-white/[0.08] text-white/[0.78] hover:bg-white/[0.12] hover:text-white",
        (busy || cacheableSongs.length === 0) && "cursor-wait opacity-70",
        className,
      )}
    >
      <Icon size={iconOnly ? 24 : 17} className={cn(busy && "animate-spin")} />
      {!iconOnly ? <span>{text}</span> : null}
    </button>
  );
}
