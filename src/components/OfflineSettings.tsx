"use client";

import { useEffect } from "react";
import { CheckCircle2, Database, HardDrive, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { formatBytes, useOfflineStore } from "@/client/offline";

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

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const downloads = Object.values(records);
  const downloaded = downloads.filter((record) => record.status === "downloaded").length;
  const failed = downloads.filter((record) => record.status === "failed").length;
  const active = downloads.filter((record) => record.status === "queued" || record.status === "downloading").length;
  const downloadedBytes = downloads.reduce(
    (total, record) => total + (record.status === "downloaded" ? record.size : 0),
    0,
  );
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

  return (
    <section className="rounded-lg border border-white/[0.12] bg-white/[0.04] p-4">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
          <Database size={19} />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Offline</h2>
          <div className="text-sm text-white/[0.62]">
            {downloaded} downloaded · {active} active · {failed} failed
          </div>
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md bg-black/20 p-3">
          <dt className="text-white/[0.55]">Storage used</dt>
          <dd className="mt-1 font-medium">
            {formatBytes(storageUsage)}
            {usedPercent == null ? "" : ` · ${usedPercent}%`}
          </dd>
        </div>
        <div className="rounded-md bg-black/20 p-3">
          <dt className="text-white/[0.55]">Available</dt>
          <dd className="mt-1 font-medium">
            {freeBytes == null ? "Unknown" : `${formatBytes(freeBytes)} free`}
          </dd>
        </div>
        <div className="rounded-md bg-black/20 p-3">
          <dt className="text-white/[0.55]">Downloaded media</dt>
          <dd className="mt-1 font-medium">{formatBytes(downloadedBytes)}</dd>
        </div>
        <div className="rounded-md bg-black/20 p-3">
          <dt className="text-white/[0.55]">Storage mode</dt>
          <dd className="mt-1 font-medium">
            {nativeStorage
              ? "Native app files"
              : persistentStorage == null
                ? "Not reported"
                : persistentStorage
                  ? "Persistent"
                  : "Best effort"}
          </dd>
        </div>
        <div className="rounded-md bg-black/20 p-3">
          <dt className="text-white/[0.55]">Sync</dt>
          <dd className="mt-1 font-medium">
            {pendingMutations === 0 ? "Up to date" : `${pendingMutations} pending`}
            {syncStatus === "auth-required" ? " · sign in required" : ""}
          </dd>
        </div>
        <div className="rounded-md bg-black/20 p-3">
          <dt className="flex items-center gap-2 text-white/[0.55]">
            <HardDrive size={14} />
            Download verification
          </dt>
          <dd className="mt-1 flex items-center gap-2 font-medium">
            <VerificationIcon size={15} />
            {verificationLabel}
          </dd>
          {verificationCheckedAt ? (
            <dd className="mt-1 text-xs text-white/[0.5]">
              {verifiedDownloads} ok · {missingDownloads} repaired/missing
            </dd>
          ) : null}
        </div>
      </dl>

      {syncError ? <div className="mt-3 text-sm text-amber-300">{syncError}</div> : null}
      {verificationError ? <div className="mt-3 text-sm text-amber-300">{verificationError}</div> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void retryFailedDownloads()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] transition hover:bg-white/[0.12] hover:text-white"
        >
          <RefreshCw size={16} />
          Retry failed
        </button>
        <button
          type="button"
          onClick={() => void verifyDownloads()}
          disabled={verificationStatus === "checking"}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] transition hover:bg-white/[0.12] hover:text-white disabled:cursor-wait disabled:opacity-60"
        >
          <ShieldCheck size={16} />
          Verify downloads
        </button>
        <button
          type="button"
          onClick={() => void syncMutations()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] transition hover:bg-white/[0.12] hover:text-white"
        >
          <RefreshCw size={16} />
          Sync now
        </button>
        <button
          type="button"
          onClick={() => void refreshStorage()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] transition hover:bg-white/[0.12] hover:text-white"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void clearPlaybackCache()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] transition hover:bg-white/[0.12] hover:text-white"
        >
          <Trash2 size={16} />
          Clear playback cache
        </button>
        <button
          type="button"
          onClick={() => void clearDownloads()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-red-500/15 px-3 text-sm font-medium text-red-200 transition hover:bg-red-500/20"
        >
          <Trash2 size={16} />
          Clear downloads
        </button>
      </div>
    </section>
  );
}
