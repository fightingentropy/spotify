"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleArrowDown, RefreshCw, X } from "lucide-react";
import {
  getScopeDownloadState,
  getSongDownloadState,
  readScopeDownloadState,
  type DownloadScope,
  useOfflineStore,
} from "@/client/offline";
import { impactLight } from "@/lib/haptics";
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
  hideWhenDownloaded?: boolean;
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const actionPendingRef = useRef(false);
  const confirmTitleId = useId();
  const confirmDescriptionId = useId();
  const hydrate = useOfflineStore((state) => state.hydrate);
  const record = useOfflineStore((state) => state.records[song.id]);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const removeDownload = useOfflineStore((state) => state.removeDownload);
  const status = getSongDownloadState(record);
  const inFlight = status === "queued" || status === "downloading";
  const busy = actionPending || inFlight;
  const progress = busy ? Math.max(0, Math.min(1, record?.progress ?? 0)) : 0;
  const progressPercent = Math.round(progress * 100);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    actionPendingRef.current = actionPending;
  }, [actionPending]);

  useEffect(() => {
    if (status !== "downloaded" && confirmOpen) {
      setConfirmOpen(false);
    }
  }, [confirmOpen, status]);

  useEffect(() => {
    if (!confirmOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => {
      cancelButtonRef.current?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (actionPendingRef.current) return;
        setConfirmOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [confirmOpen]);

  if (!canCacheSong(song)) return null;

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (actionPending) return;
    void impactLight();
    if (status === "downloaded") {
      setConfirmOpen(true);
      return;
    }
    // Allow cancelling a queued/in-flight download: removing the IDB record + cached
    // URLs is enough because the download pump re-reads IDB each iteration and
    // tolerates a vanished record.
    if (inFlight) {
      setActionError(null);
      setActionPending(true);
      try {
        await removeDownload(song.id);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not cancel download");
      } finally {
        setActionPending(false);
      }
      return;
    }
    setActionError(null);
    setActionPending(true);
    try {
      await queueDownloads([song], `song:${song.id}`);
    } catch (error) {
      console.error("Failed to queue offline download", error);
      setActionError(error instanceof Error ? error.message : "Could not start download");
    } finally {
      setActionPending(false);
    }
  }

  async function handleRemoveDownload(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setActionPending(true);
    setActionError(null);
    try {
      await removeDownload(song.id);
      setConfirmOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove download");
    } finally {
      setActionPending(false);
    }
  }

  const title =
    status === "downloaded"
      ? "Remove offline download"
      : actionError
        ? actionError
        : status === "failed"
        ? "Retry offline download"
        : inFlight
          ? `Downloading ${progressPercent}% · tap to cancel`
          : "Download for offline playback";

  const Icon =
    status === "downloaded"
      ? CheckCircle2
      : status === "failed"
        ? RefreshCw
        : CircleArrowDown;

  return (
    <>
      <button
        type="button"
        aria-label={title}
        title={title}
        onClick={handleClick}
        disabled={actionPending}
        className={cn(
          "group relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
          status === "downloaded"
            ? "text-emerald-500"
            : status === "failed" || actionError
              ? "text-red-300"
              : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
          inFlight && "text-emerald-400 hover:text-white",
          actionPending && "cursor-wait",
          className,
        )}
      >
        {inFlight ? (
          <>
            <DownloadProgressPie progress={progress} />
            <X
              size={14}
              className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 group-hover:block group-focus-visible:block"
            />
          </>
        ) : actionPending ? (
          <DownloadProgressPie progress={progress} />
        ) : (
          <Icon size={18} />
        )}
      </button>

      {confirmOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                if (actionPending) return;
                setConfirmOpen(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={confirmTitleId}
                aria-describedby={confirmDescriptionId}
                className="w-full max-w-sm rounded-2xl border border-white/15 bg-zinc-950 p-5 text-white shadow-[0_20px_80px_rgba(0,0,0,0.65)]"
                onClick={(event) => event.stopPropagation()}
              >
                <h2 id={confirmTitleId} className="text-lg font-semibold">Remove download?</h2>
                <p id={confirmDescriptionId} className="mt-2 text-sm leading-6 text-white/70">
                  This will delete the offline copy of "{song.title}" from this device.
                </p>
                {actionError ? (
                  <div role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {actionError}
                  </div>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    ref={cancelButtonRef}
                    type="button"
                    className="h-10 rounded-full border border-white/20 px-4 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    disabled={actionPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmOpen(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="h-10 rounded-full bg-emerald-500 px-4 text-sm font-semibold text-black transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                    disabled={actionPending}
                    onClick={handleRemoveDownload}
                  >
                    {actionPending ? "Removing..." : "Remove download"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function OfflineBulkDownloadButton({
  songs,
  scope,
  label = "Download",
  className,
  iconOnly = false,
  hideWhenDownloaded = false,
}: OfflineBulkDownloadButtonProps) {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const records = useOfflineStore((state) => state.records);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const removeScope = useOfflineStore((state) => state.removeScope);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const actionPendingRef = useRef(false);
  const confirmTitleId = useId();
  const confirmDescriptionId = useId();
  const inMemoryStatus = getScopeDownloadState(records, songs, scope);
  const [idbStatus, setIdbStatus] = useState<ReturnType<typeof getScopeDownloadState> | null>(null);
  // The in-memory record map is capped, so for big collections it can mis-report a
  // fully-downloaded scope as "partial"/"none". Prefer the authoritative IDB read.
  const status = idbStatus ?? inMemoryStatus;
  const cacheableSongs = songs.filter(canCacheSong);
  const inFlight = status === "downloading";
  const busy = actionPending || inFlight;
  const downloaded = status === "downloaded";
  const progress = busy ? scopeProgress(records, songs, scope) : 0;
  const progressPercent = Math.round(progress * 100);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    let cancelled = false;
    readScopeDownloadState(songs, scope)
      .then((next) => {
        if (!cancelled) setIdbStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [records, songs, scope]);

  useEffect(() => {
    actionPendingRef.current = actionPending;
  }, [actionPending]);

  useEffect(() => {
    if (status !== "downloaded" && confirmOpen) {
      setConfirmOpen(false);
    }
  }, [confirmOpen, status]);

  useEffect(() => {
    if (!confirmOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => {
      cancelButtonRef.current?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (actionPendingRef.current) return;
        setConfirmOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [confirmOpen]);

  if (downloaded && hideWhenDownloaded) return null;

  async function handleClick() {
    if (actionPending || cacheableSongs.length === 0) return;
    void impactLight();
    setActionError(null);
    if (downloaded) {
      setConfirmOpen(true);
      return;
    }
    // Allow cancelling an in-progress collection download: removeScope clears the IDB
    // records + cached URLs, and the pump tolerates the vanished records mid-run.
    if (inFlight) {
      setActionPending(true);
      try {
        await removeScope(scope);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not cancel downloads");
      } finally {
        setActionPending(false);
      }
      return;
    }
    setActionPending(true);
    try {
      await queueDownloads(cacheableSongs, scope);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start downloads");
    } finally {
      setActionPending(false);
    }
  }

  async function handleRemoveScope(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setActionPending(true);
    setActionError(null);
    try {
      await removeScope(scope);
      setConfirmOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove downloads");
    } finally {
      setActionPending(false);
    }
  }

  const Icon = downloaded ? X : status === "failed" ? RefreshCw : inFlight ? X : CircleArrowDown;
  const text = actionError
    ? "Retry downloads"
    : downloaded
      ? "Remove downloads"
      : status === "failed"
        ? "Retry downloads"
        : inFlight
          ? `Downloading ${progressPercent}% · cancel`
          : status === "partial"
            ? "Finish download"
            : label;
  const title = actionError || text;

  return (
    <>
      <button
        type="button"
        aria-label={title}
        title={title}
        disabled={actionPending || cacheableSongs.length === 0}
        onClick={handleClick}
        className={cn(
          iconOnly
            ? "grid h-11 w-11 place-items-center rounded-full"
            : "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium",
          "shrink-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
          downloaded
            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"
            : actionError
              ? "bg-red-500/15 text-red-300 hover:bg-red-500/20"
              : "bg-white/[0.08] text-white/[0.78] hover:bg-white/[0.12] hover:text-white",
          inFlight && "text-emerald-300",
          actionPending && "cursor-wait",
          cacheableSongs.length === 0 && "cursor-wait opacity-70",
          className,
        )}
      >
        {busy ? <DownloadProgressPie progress={progress} size={iconOnly ? 24 : 17} /> : <Icon size={iconOnly ? 24 : 17} />}
        {!iconOnly ? <span>{text}</span> : null}
      </button>

      {confirmOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                if (actionPending) return;
                setConfirmOpen(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={confirmTitleId}
                aria-describedby={confirmDescriptionId}
                className="w-full max-w-sm rounded-2xl border border-white/15 bg-zinc-950 p-5 text-white shadow-[0_20px_80px_rgba(0,0,0,0.65)]"
                onClick={(event) => event.stopPropagation()}
              >
                <h2 id={confirmTitleId} className="text-lg font-semibold">Remove downloads?</h2>
                <p id={confirmDescriptionId} className="mt-2 text-sm leading-6 text-white/70">
                  This will remove offline copies for this collection from this device.
                </p>
                {actionError ? (
                  <div role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {actionError}
                  </div>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    ref={cancelButtonRef}
                    type="button"
                    className="h-10 rounded-full border border-white/20 px-4 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    disabled={actionPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmOpen(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="h-10 rounded-full bg-emerald-500 px-4 text-sm font-semibold text-black transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                    disabled={actionPending}
                    onClick={handleRemoveScope}
                  >
                    {actionPending ? "Removing..." : "Remove downloads"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
