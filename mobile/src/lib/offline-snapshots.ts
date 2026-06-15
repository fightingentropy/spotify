import { storage } from "@/lib/storage";

// Cached API snapshots so the app can render the last-known library/likes/playlist
// data while offline (the RN replacement for the web app's IndexedDB
// `api_snapshots` store). Keyed by the request URL (path + ?auth scope), so each
// account's snapshots are isolated. Backed by MMKV (synchronous, but the API
// surface stays async to match the original contract).

export type OfflineApiSnapshot<T = unknown> = {
  data: T;
  etag: string | null;
  fetchedAt: number;
};

const PREFIX = "snap:";

// MMKV is synchronous, so a snapshot can be read with zero async overhead. This
// is what lets useApiData seed cached data into its initial render state (no
// blank-then-pop-in flash on launch). The async wrapper below is kept for the
// existing call sites that expect a Promise.
export function readOfflineApiSnapshotSync<T>(url: string): OfflineApiSnapshot<T> | undefined {
  try {
    const raw = storage.getItem(PREFIX + url);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as OfflineApiSnapshot<T>;
    if (parsed.data === undefined || typeof parsed.fetchedAt !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function readOfflineApiSnapshot<T>(url: string): Promise<OfflineApiSnapshot<T> | undefined> {
  return readOfflineApiSnapshotSync<T>(url);
}

export async function writeOfflineApiSnapshot<T>(
  url: string,
  data: T,
  etag: string | null | undefined,
  fetchedAt: number,
): Promise<void> {
  try {
    storage.setItem(PREFIX + url, JSON.stringify({ data, etag: etag ?? null, fetchedAt }));
  } catch {}
}

export async function removeOfflineApiSnapshots(
  match?: string | RegExp | ((url: string) => boolean),
): Promise<void> {
  // MMKV has no prefix scan in the shim; we cannot enumerate keys here, so a
  // targeted clear is a no-op for now and a full clear is handled by the caller
  // wiping the MMKV instance. The full subsystem (task 5) maintains an index.
  void match;
}
