"use client";

import { useEffect, type CSSProperties, type MouseEvent } from "react";
import { CheckCircle2, CircleArrowDown, RefreshCw, X } from "lucide-react";
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

function DownloadProgressPie({
  progress,
  size = 18,
}: {
  progress: number;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const style = {
    width: size,
    height: size,
    background: `conic-gradient(currentColor ${Math.round(clamped * 360)}deg, color-mix(in srgb, currentColor 22%, transparent) 0deg)`,
  } satisfies CSSProperties;

  return (
    <span
      aria-hidden
      className="relative block rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_52%,transparent)]"
      style={style}
    >
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
    </span>
  );
}

function scopeProgress(
  records: Record<string, { pinnedBy: DownloadScope[]; progress: number; status: string } | undefined>,
  songs: PlayerSong[],
  scope: DownloadScope,
): number {
  const cacheableSongs = songs.filter(canCacheSong);
  if (cacheableSongs.length === 0) return 0;
  const total = cacheableSongs.reduce((sum, song) => {
    const record = records[song.id];
    if (!record?.pinnedBy.includes(scope)) return sum;
    if (record.status === "downloaded") return sum + 1;
    return sum + Math.max(0, Math.min(1, record.progress || 0));
  }, 0);
  return total / cacheableSongs.length;
}

export function OfflineSongDownloadButton({ song, className }: OfflineSongDownloadButtonProps) {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const record = useOfflineStore((state) => state.records[song.id]);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const removeDownload = useOfflineStore((state) => state.removeDownload);
  const status = getSongDownloadState(record);
  const busy = status === "queued" || status === "downloading";
  const progress = busy ? Math.max(0, Math.min(1, record?.progress ?? 0)) : 0;
  const progressPercent = Math.round(progress * 100);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!canCacheSong(song)) return null;

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
          ? `Downloading ${progressPercent}%`
          : "Download for offline playback";

  const Icon =
    status === "downloaded"
      ? CheckCircle2
      : status === "failed"
        ? RefreshCw
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
        busy && "cursor-wait text-emerald-400",
        className,
      )}
    >
      {busy ? <DownloadProgressPie progress={progress} /> : <Icon size={18} />}
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
  const progress = busy ? scopeProgress(records, songs, scope) : 0;
  const progressPercent = Math.round(progress * 100);

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

  const Icon = downloaded ? X : status === "failed" ? RefreshCw : CircleArrowDown;
  const text = downloaded
    ? "Remove downloads"
    : status === "failed"
      ? "Retry downloads"
      : status === "partial"
        ? "Finish download"
        : busy
          ? `Downloading ${progressPercent}%`
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
        busy && "cursor-wait text-emerald-300",
        cacheableSongs.length === 0 && "cursor-wait opacity-70",
        className,
      )}
    >
      {busy ? <DownloadProgressPie progress={progress} size={iconOnly ? 24 : 17} /> : <Icon size={iconOnly ? 24 : 17} />}
      {!iconOnly ? <span>{text}</span> : null}
    </button>
  );
}
