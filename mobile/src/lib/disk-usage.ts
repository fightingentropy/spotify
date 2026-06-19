import * as FileSystem from "expo-file-system/legacy";
import { getOfflineAccountScope } from "@/store/offline";
import { readAllDownloadedRecords, resolveMediaPath } from "@/lib/offline-db";

// Storage accounting for OfflineSettings. The web app leaned on the browser's
// navigator.storage.estimate() for usage/quota; RN has no such API, so this sums
// the actual on-disk size of every downloaded asset and reads the device's free/
// total disk from expo-file-system's legacy API (getFreeDiskStorageAsync /
// getTotalDiskCapacityAsync — both present in the installed build; we feature-test
// them anyway so this degrades to just the downloads total if they ever vanish).

export type DiskUsage = {
  usedByDownloads: number;
  free?: number;
  total?: number;
};

// Matches src/client/offline.ts formatBytes verbatim so the two apps render
// sizes identically (e.g. "1.5 GB", "512 KB").
export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

async function fileSize(path: string | null | undefined): Promise<number> {
  const resolved = resolveMediaPath(path);
  if (!resolved) return 0;
  try {
    const info = await FileSystem.getInfoAsync(resolved);
    return info.exists && !info.isDirectory ? info.size : 0;
  } catch {
    return 0;
  }
}

// Sum audio + cover + lyrics bytes across every ready download for the current
// account. Stats run in parallel; any unreadable file contributes 0.
async function sumDownloadedBytes(accountScope: string): Promise<number> {
  const rows = await readAllDownloadedRecords(accountScope).catch(() => []);
  const sizes = await Promise.all(
    rows.flatMap((row) => [fileSize(row.audioPath), fileSize(row.coverPath), fileSize(row.lyricsPath)]),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function maybeNumber(fn: (() => Promise<number>) | undefined): Promise<number | undefined> {
  if (typeof fn !== "function") return undefined;
  try {
    const value = await fn();
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function getDiskUsage(): Promise<DiskUsage> {
  const accountScope = getOfflineAccountScope();
  const fs = FileSystem as typeof FileSystem & {
    getFreeDiskStorageAsync?: () => Promise<number>;
    getTotalDiskCapacityAsync?: () => Promise<number>;
  };
  const [usedByDownloads, free, total] = await Promise.all([
    sumDownloadedBytes(accountScope),
    maybeNumber(fs.getFreeDiskStorageAsync),
    maybeNumber(fs.getTotalDiskCapacityAsync),
  ]);
  return { usedByDownloads, free, total };
}
