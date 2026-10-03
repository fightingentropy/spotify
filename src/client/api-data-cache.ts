import { getApiPath } from "@spotify/shared/account-scope";
import { apiReadTimeoutMs } from "@spotify/shared/api-timeout-policy";

type CacheEntry<T = unknown> = {
  data?: T;
  etag?: string | null;
  fetchedAt: number;
  revision: number;
  promise?: Promise<T>;
  promiseStartedAt?: number;
};

type CacheResult = { data: unknown; etag?: string | null };
type CacheLoader = (url: string, cached?: { data?: unknown; etag?: string | null }) => Promise<CacheResult>;

function freshnessMs(url: string): number {
  const path = getApiPath(url);
  // Playback history changes more often than the library. Search and catalog
  // results can survive a quick backspace or reopening the search dialog.
  if (path.startsWith("/api/stats/")) return 5_000;
  if (path.startsWith("/api/search/") || path.startsWith("/api/catalog/") || path === "/api/discover/playlists") {
    return 60_000;
  }
  return 30_000;
}

/** Shared reads survive remounts; invalidation prevents an old request restoring cleared data. */
export function createApiDataCache(
  load: CacheLoader,
  onUpdate: (url: string, data: unknown) => void,
  options: { now?: () => number; maxEntries?: number } = {},
) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 100;
  const entries = new Map<string, CacheEntry>();

  function trim() {
    for (const [url, entry] of entries) {
      if (entries.size <= maxEntries) break;
      // A pending request must remain visible to other readers for deduplication.
      if (!entry.promise) entries.delete(url);
    }
  }

  function get<T>(url: string): CacheEntry<T> | undefined {
    const entry = entries.get(url) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (entry.promise && now() - (entry.promiseStartedAt ?? 0) > apiReadTimeoutMs(url) + 2_000) {
      // Detach the expired request: its eventual result cannot overwrite a retry.
      const replacement = { data: entry.data, etag: entry.etag, fetchedAt: entry.fetchedAt, revision: entry.revision };
      entries.set(url, replacement);
      return replacement;
    }
    entries.delete(url);
    entries.set(url, entry);
    return entry;
  }

  function read<T>(url: string, force = false): Promise<T> {
    const cached = get<T>(url);
    if (cached?.promise) return cached.promise;
    if (!force && cached?.data !== undefined && now() - cached.fetchedAt < freshnessMs(url)) {
      return Promise.resolve(cached.data);
    }

    const entry: CacheEntry<T> = cached ?? { fetchedAt: 0, revision: 0 };
    const revision = entry.revision;
    entry.promiseStartedAt = now();
    const promise = Promise.resolve().then(async () => {
      const result = await load(url, { data: entry.data, etag: entry.etag });
      // Auth changes, explicit retries and library mutations can invalidate a
      // request while it is loading. Its result belongs only to that old caller.
      if (entries.get(url) !== entry) return result.data as T;
      if (entry.revision !== revision && entry.data !== undefined) {
        // Keep a like patched while this read was in flight. Revalidate on the
        // next visit rather than let an older response undo the user's action.
        entry.fetchedAt = -Infinity;
        return entry.data;
      }
      entry.data = result.data as T;
      entry.etag = result.etag ?? null;
      entry.fetchedAt = now();
      onUpdate(url, entry.data);
      return entry.data;
    }).finally(() => {
      if (entries.get(url) === entry) {
        delete entry.promise;
        delete entry.promiseStartedAt;
        if (entry.data === undefined) entries.delete(url);
      }
      trim();
    });
    entry.promise = promise;
    entries.set(url, entry);
    trim();
    return promise;
  }

  return {
    get,
    read,
    entries: () => Array.from(entries.entries()),
    patch(url: string, data: unknown) {
      const entry = entries.get(url);
      if (!entry) return;
      entry.data = data;
      entry.etag = null;
      entry.revision += 1;
      // A partial mutation neither refreshes the whole payload nor interrupts a
      // pending read. Preserve both its age and its shared promise.
      onUpdate(url, data);
    },
    invalidate(match?: (url: string) => boolean) {
      if (!match) entries.clear();
      else for (const url of entries.keys()) if (match(url)) entries.delete(url);
    },
  };
}
