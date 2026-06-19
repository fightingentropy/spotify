"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  Boxes,
  Camera,
  CheckCircle2,
  Cloud,
  Cog,
  Database,
  HardDrive,
  Heart,
  Loader2,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { readOfflineDiagnostics, type OfflineDiagnostics } from "@/client/offline-diagnostics";
import { formatBytes, readDownloadedBytesTotal, useOfflineStore } from "@/client/offline";
import type { LikedPayload } from "@/client/api";

// Flat, hairline-separated settings rows — a web port of the mobile Downloads
// screen (mobile/src/components/OfflineSettings.tsx). Actions live inline on the
// rows they relate to (Verify on the verification row, Retry only when a
// download failed) instead of a free-floating button bar.

const AMBER = "#fbbf24";
const MUTED = "#b3b3b3";

function MiniButton({
  label,
  onClick,
  busy,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.12] px-3.5 text-[13px] font-semibold transition hover:bg-white/[0.16] disabled:cursor-wait disabled:opacity-50"
      style={{ color: tone === "warn" ? AMBER : "#ededed" }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : null}
      {label}
    </button>
  );
}

function Row({
  icon: Icon,
  iconColor,
  busy,
  leading,
  title,
  titleColor,
  value,
  valueSub,
  right,
  first,
}: {
  icon: LucideIcon;
  iconColor?: string;
  busy?: boolean;
  leading?: ReactNode;
  title: string;
  titleColor?: string;
  value?: string;
  valueSub?: string;
  right?: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[56px] items-center gap-3 py-2.5 ${first ? "" : "border-t border-white/10"}`}
    >
      <div className="flex w-[18px] shrink-0 justify-center">
        {leading ? (
          leading
        ) : busy ? (
          <Loader2 size={18} className="animate-spin" style={{ color: iconColor ?? MUTED }} />
        ) : (
          <Icon size={18} style={{ color: iconColor ?? MUTED }} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium" style={{ color: titleColor ?? "#ededed" }}>
          {title}
        </div>
        {valueSub ? <div className="mt-0.5 truncate text-xs text-white/50">{valueSub}</div> : null}
      </div>
      {value ? (
        <span className="shrink-0 text-[14px]" style={{ color: MUTED }}>
          {value}
        </span>
      ) : null}
      {right}
    </div>
  );
}

function FooterButton({
  icon: Icon,
  label,
  tone = "default",
  busy,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onClick: () => void;
}) {
  const fg = tone === "danger" ? "#f8717a" : "#ededed";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex min-h-[56px] w-full items-center gap-3 border-t border-white/10 py-2.5 text-left transition hover:opacity-80 disabled:cursor-wait disabled:opacity-50"
    >
      <div className="flex w-[18px] shrink-0 justify-center">
        {busy ? (
          <Loader2 size={18} className="animate-spin" style={{ color: fg }} />
        ) : (
          <Icon size={18} style={{ color: fg }} />
        )}
      </div>
      <span className="text-[15px] font-semibold" style={{ color: fg }}>
        {label}
      </span>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[24px] w-[42px] shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-white/20"}`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[20px] w-[20px] rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0"}`}
      />
    </button>
  );
}

export default function OfflineSettings() {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const records = useOfflineStore((state) => state.records);
  const pendingMutations = useOfflineStore((state) => state.pendingMutations);
  const syncStatus = useOfflineStore((state) => state.syncStatus);
  const syncError = useOfflineStore((state) => state.syncError);
  const storageUsage = useOfflineStore((state) => state.storageUsage);
  const storageQuota = useOfflineStore((state) => state.storageQuota);
  const persistentStorage = useOfflineStore((state) => state.persistentStorage);
  const nativeStorage = useOfflineStore((state) => state.nativeStorage);
  const verificationStatus = useOfflineStore((state) => state.verificationStatus);
  const verificationCheckedAt = useOfflineStore((state) => state.verificationCheckedAt);
  const verifiedDownloads = useOfflineStore((state) => state.verifiedDownloads);
  const missingDownloads = useOfflineStore((state) => state.missingDownloads);
  const verificationError = useOfflineStore((state) => state.verificationError);
  const retryFailedDownloads = useOfflineStore((state) => state.retryFailedDownloads);
  const clearPlaybackCache = useOfflineStore((state) => state.clearPlaybackCache);
  const clearDownloads = useOfflineStore((state) => state.clearDownloads);
  const verifyDownloads = useOfflineStore((state) => state.verifyDownloads);
  const syncMutations = useOfflineStore((state) => state.syncMutations);
  const refreshStorage = useOfflineStore((state) => state.refreshStorage);
  const autoDownloadLiked = useOfflineStore((state) => state.autoDownloadLiked);
  const setAutoDownloadLiked = useOfflineStore((state) => state.setAutoDownloadLiked);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const [diagnostics, setDiagnostics] = useState<OfflineDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState<number | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const refreshDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await readOfflineDiagnostics());
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  useEffect(() => {
    void refreshDiagnostics();
  }, []);

  useEffect(() => {
    let cancelled = false;
    readDownloadedBytesTotal()
      .then((total) => {
        if (!cancelled) setDownloadedBytes(total);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Recompute whenever records change (download completed/removed) or storage refreshes.
  }, [records, storageUsage]);

  const downloads = Object.values(records);
  const downloaded = downloads.filter((record) => record.status === "downloaded").length;
  const failed = downloads.filter((record) => record.status === "failed").length;
  const active = downloads.filter((record) => record.status === "queued" || record.status === "downloading").length;
  // Overall batch progress for the "Downloading N songs…" row: completed songs
  // plus the in-flight song's byte fraction, over the total in this batch.
  const activeProgress = downloads.find((record) => record.status === "downloading")?.progress ?? 0;
  const totalBatch = downloaded + active;
  const overallProgress = totalBatch > 0 ? Math.round(((downloaded + activeProgress) / totalBatch) * 100) : 0;
  const inMemoryDownloadedBytes = downloads.reduce(
    (total, record) => total + (record.status === "downloaded" ? record.size : 0),
    0,
  );
  // Prefer the IDB-backed total: the in-memory record map is capped, so summing it
  // undercounts once there are more downloads than the cap.
  const displayedDownloadedBytes = downloadedBytes ?? inMemoryDownloadedBytes;
  const quotaKnown = typeof storageQuota === "number" && storageQuota > 0;
  const usageKnown = typeof storageUsage === "number" && storageUsage >= 0;
  const usedPercent = quotaKnown && usageKnown ? Math.min(100, Math.round((storageUsage / storageQuota) * 100)) : null;
  const freeBytes = quotaKnown && usageKnown ? Math.max(0, storageQuota - storageUsage) : null;
  const verificationLabel =
    verificationStatus === "checking"
      ? "Checking downloads"
      : verificationStatus === "ok"
        ? "Downloads verified"
        : verificationStatus === "repair-needed"
          ? "Repair queued"
          : verificationStatus === "failed"
            ? "Verification failed"
            : "Not checked yet";
  const verificationIcon =
    verificationStatus === "ok"
      ? CheckCircle2
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? TriangleAlert
        : ShieldCheck;
  const VerificationIcon = verificationIcon;
  const verificationTint =
    verificationStatus === "ok"
      ? "#10b981"
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? AMBER
        : MUTED;
  const syncHealthy = pendingMutations === 0 && syncStatus !== "auth-required" && syncStatus !== "failed";
  const syncSummary =
    pendingMutations === 0
      ? "Up to date"
      : `${pendingMutations} pending${syncStatus === "auth-required" ? " · sign in" : ""}`;
  const showSyncAction = pendingMutations > 0 || syncStatus === "failed" || syncStatus === "auth-required";
  const handleClearPlaybackCache = () => {
    if (!window.confirm("Clear cached playback media?")) return;
    void clearPlaybackCache();
  };
  const handleClearDownloads = () => {
    if (!window.confirm("Clear all offline downloads from this device?")) return;
    void clearDownloads();
  };
  const handleAutoDownloadLikedChange = async (enabled: boolean) => {
    setAutoDownloadLiked(enabled);
    if (!enabled) return;
    // Backfill existing likes; if this fetch fails (offline), the like hook
    // still pins future likes and the next enable retries the backfill.
    try {
      const response = await fetch("/api/liked", {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as LikedPayload;
      // The user may have toggled the setting back off while the fetch was
      // in flight; don't queue a stale backfill in that case.
      if (!useOfflineStore.getState().autoDownloadLiked) return;
      const likedSongs = Array.isArray(payload.songs) ? payload.songs : [];
      if (likedSongs.length > 0) await queueDownloads(likedSongs, "liked");
    } catch {}
  };
  const shellCaches = diagnostics?.caches.filter((cache) => /-(shell|static)$|app-assets/.test(cache.name)) ?? [];
  const runtimeCaches = diagnostics?.caches.filter((cache) => cache.name.endsWith("-runtime")) ?? [];
  const mediaCaches = diagnostics?.caches.filter((cache) => /media|playback/.test(cache.name)) ?? [];
  const shellEntries = shellCaches.reduce((total, cache) => total + cache.entries, 0);
  const runtimeEntries = runtimeCaches.reduce((total, cache) => total + cache.entries, 0);
  const mediaEntries = mediaCaches.reduce((total, cache) => total + cache.entries, 0);
  const mediaKnownBytes = mediaCaches.reduce((total, cache) => total + (cache.estimatedBytes ?? 0), 0);

  const storageModeLabel = nativeStorage
    ? "Native app files"
    : persistentStorage == null
      ? "Not reported"
      : persistentStorage
        ? "Persistent"
        : "Best effort";
  const summary =
    `${downloaded} downloaded · ${active} active · ${failed} failed`;

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 sm:px-5">
      {/* Header: title + one-line summary + refresh */}
      <div className="flex items-start gap-3 pt-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold">Offline</h2>
          <div className="mt-0.5 truncate text-[13px]" style={{ color: MUTED }}>
            {summary}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void refreshStorage();
            void refreshDiagnostics();
          }}
          aria-label="Refresh storage"
          title="Refresh storage"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full transition hover:bg-white/[0.08]"
        >
          <RefreshCw size={18} style={{ color: MUTED }} />
        </button>
      </div>

      {/* Storage details */}
      <Row
        first
        icon={HardDrive}
        title="Storage used"
        value={`${formatBytes(storageUsage)}${usedPercent == null ? "" : ` · ${usedPercent}%`}`}
      />
      <Row
        icon={Database}
        title="Available"
        value={freeBytes == null ? "Unknown" : `${formatBytes(freeBytes)} free`}
      />
      <Row icon={ArrowDownToLine} title="Downloaded media" value={formatBytes(displayedDownloadedBytes)} />
      <Row icon={Cog} title="Storage mode" value={storageModeLabel} />

      {/* Active downloads — only while something is downloading */}
      {active > 0 ? (
        <Row
          icon={ArrowDownToLine}
          iconColor="#10b981"
          busy
          title={`Downloading ${active} ${active === 1 ? "song" : "songs"}…`}
          value={`${overallProgress}%`}
        />
      ) : null}

      {/* Verification */}
      <Row
        icon={VerificationIcon}
        iconColor={verificationTint}
        busy={verificationStatus === "checking"}
        title={verificationLabel}
        value={
          verificationCheckedAt
            ? `${verifiedDownloads} ok${missingDownloads > 0 ? ` · ${missingDownloads} missing` : ""}`
            : undefined
        }
        right={
          <MiniButton
            label="Verify"
            busy={verificationStatus === "checking"}
            onClick={() => void verifyDownloads()}
          />
        }
      />

      {/* Sync */}
      <Row
        icon={syncHealthy ? Cloud : TriangleAlert}
        iconColor={syncHealthy ? MUTED : AMBER}
        busy={syncStatus === "syncing"}
        title="Sync"
        value={syncSummary}
        right={
          showSyncAction ? (
            <MiniButton label="Sync now" busy={syncStatus === "syncing"} onClick={() => void syncMutations()} />
          ) : undefined
        }
      />

      {/* Failed downloads → retry (only when present) */}
      {failed > 0 ? (
        <Row
          icon={TriangleAlert}
          iconColor={AMBER}
          titleColor={AMBER}
          title={`${failed} failed download${failed === 1 ? "" : "s"}`}
          right={<MiniButton label="Retry" tone="warn" onClick={() => void retryFailedDownloads()} />}
        />
      ) : null}

      {/* Auto-download toggle */}
      <Row
        icon={Heart}
        title="Automatically download liked songs"
        right={
          <Toggle
            checked={autoDownloadLiked}
            onChange={(next) => void handleAutoDownloadLikedChange(next)}
            label="Automatically download liked songs"
          />
        }
      />

      {/* Error lines (rare) */}
      {syncError ? (
        <div className="pt-1 pb-1 text-[13px]" style={{ color: AMBER }}>
          {syncError}
        </div>
      ) : null}
      {verificationError ? (
        <div className="pt-1 pb-1 text-[13px]" style={{ color: AMBER }}>
          {verificationError}
        </div>
      ) : null}

      {/* Destructive / cache actions */}
      <FooterButton icon={Trash2} label="Clear playback cache" onClick={handleClearPlaybackCache} />
      <FooterButton icon={Trash2} label="Clear downloads" tone="danger" onClick={handleClearDownloads} />

      {/* Diagnostics */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-4 pb-1">
        <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
          <Activity size={15} />
          Diagnostics
        </div>
        <button
          type="button"
          onClick={() => void refreshDiagnostics()}
          disabled={diagnosticsLoading}
          className="grid h-9 w-9 place-items-center rounded-full transition hover:bg-white/[0.08] disabled:cursor-wait disabled:opacity-60"
          aria-label="Refresh offline diagnostics"
          title="Refresh offline diagnostics"
        >
          <RefreshCw size={15} className={diagnosticsLoading ? "animate-spin" : undefined} style={{ color: MUTED }} />
        </button>
      </div>

      <Row
        first
        icon={Boxes}
        title="App shell"
        value={diagnostics ? `${shellEntries} ${shellEntries === 1 ? "asset" : "assets"}` : "Checking"}
      />
      <Row
        icon={Cog}
        title="Service worker"
        value={
          diagnostics?.serviceWorker.controlled
            ? "Controlling"
            : diagnostics?.serviceWorker.supported
              ? diagnostics.serviceWorker.registrationState ?? "Registered"
              : "Unavailable"
        }
      />
      <Row
        icon={Camera}
        title="API snapshots"
        value={`${
          diagnostics?.indexedDb.apiSnapshots == null ? "—" : diagnostics.indexedDb.apiSnapshots
        }${runtimeEntries > 0 ? ` · ${runtimeEntries} SW` : ""}`}
      />
      <Row
        icon={HardDrive}
        title="Media cache"
        value={`${mediaEntries} ${mediaEntries === 1 ? "entry" : "entries"}${
          mediaKnownBytes > 0 ? ` · ${formatBytes(mediaKnownBytes)}` : ""
        }`}
      />
      <Row
        icon={Database}
        title="Offline database"
        value={
          diagnostics?.indexedDb.error
            ? "Needs attention"
            : diagnostics?.indexedDb.available
              ? `${diagnostics.indexedDb.downloads ?? 0} downloads · ${diagnostics.indexedDb.mutations ?? 0} mutations`
              : "Unavailable"
        }
      />
      <Row
        icon={Cloud}
        title="Playback sync"
        value={
          diagnostics?.playbackState.pendingSync
            ? "Pending"
            : diagnostics?.playbackState.saved
              ? "Saved"
              : "Empty"
        }
      />
      {diagnostics?.indexedDb.error ? (
        <div className="pt-1 pb-4 text-[13px]" style={{ color: AMBER }}>
          {diagnostics.indexedDb.error}
        </div>
      ) : (
        <div className="pb-4" />
      )}
    </section>
  );
}
