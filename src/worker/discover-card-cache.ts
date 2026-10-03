export type DiscoverPlaylistCard = {
  id: string;
  name: string;
  imageUrl: string;
  songsCount: number;
};

type CardSource = { fallback: DiscoverPlaylistCard; authenticatedOnly?: boolean; load: () => Promise<DiscoverPlaylistCard | null> };
type CardSnapshot = { refreshAfter: number; complete: boolean; playlists: DiscoverPlaylistCard[] };
type CardCache = Pick<Cache, "match" | "put">;
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const RETAIN_SECONDS = 24 * 60 * 60;
const REFRESH_LOCK_MS = 25_000;
const MAX_REFRESHES = 16;

function parseSnapshot(value: unknown, allowedIds: string[]): CardSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<CardSnapshot>;
  if (!Number.isFinite(snapshot.refreshAfter) || typeof snapshot.complete !== "boolean" || !Array.isArray(snapshot.playlists)) return null;
  if (snapshot.playlists.length !== allowedIds.length) return null;
  const valid = snapshot.playlists.every((card, index) => (
    card && card.id === allowedIds[index] && typeof card.name === "string" &&
    typeof card.imageUrl === "string" && Number.isSafeInteger(card.songsCount) && card.songsCount >= 0
  ));
  return valid ? snapshot as CardSnapshot : null;
}

/** Card metadata only: neither slow providers nor a cold mini block Home. */
export function createDiscoverCardCache(now: () => number = Date.now) {
  // Locks contain only hashed scope identifiers. Never share request-owned I/O
  // promises across Worker requests; the request which starts a refresh owns it.
  const refreshing = new Map<string, number>();

  return async function readCards(options: {
    requestUrl: string;
    userId: string | null;
    privateOrigin: string;
    sources: CardSource[];
    openCache: () => Promise<CardCache>;
    waitUntil: (work: Promise<unknown>) => void;
  }): Promise<{ playlists: DiscoverPlaylistCard[]; fresh: boolean }> {
    const sources = options.sources.filter((source) => !source.authenticatedOnly || options.userId !== null);
    const ids = sources.map(({ fallback }) => fallback.id);
    // Exact identities and configured private origins are isolated. In
    // particular, a real user named "anonymous" is not the anonymous scope.
    const scope = JSON.stringify([
      options.userId === null ? ["anonymous"] : ["user", options.userId],
      options.privateOrigin,
      ids,
    ]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
    const key = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const cacheUrl = new URL(`/_internal/discover-cards/${key}`, options.requestUrl);
    const cacheRequest = new Request(cacheUrl.toString());
    const cache = await options.openCache().catch(() => null);
    const cachedResponse = await cache?.match(cacheRequest).catch(() => undefined);
    const cached = parseSnapshot(await cachedResponse?.json().catch(() => null), ids);
    const timestamp = now();
    const playlists = cached?.playlists ?? sources.map(({ fallback }) => fallback);
    const fresh = cached !== null && cached.complete && timestamp < cached.refreshAfter;

    if (!cached || timestamp >= cached.refreshAfter) {
      for (const [scopeKey, expiresAt] of refreshing) if (expiresAt <= timestamp) refreshing.delete(scopeKey);
      // Include the request origin too: preview and production must not share a
      // lock even if they happen to use the same user/private origin settings.
      const lockKey = cacheRequest.url;
      if (!refreshing.has(lockKey) && refreshing.size < MAX_REFRESHES) {
        const expiresAt = timestamp + REFRESH_LOCK_MS;
        refreshing.set(lockKey, expiresAt);
        const work = Promise.resolve().then(async () => {
          const results = await Promise.allSettled(sources.map(({ load }) => Promise.resolve().then(load)));
          const updated = playlists.map((previous, index) => {
            const result = results[index];
            // Empty or failed provider reads retain the last successful card.
            return result?.status === "fulfilled" && result.value?.id === previous.id ? result.value : previous;
          });
          const complete = results.every((result, index) => result.status === "fulfilled" && result.value?.id === ids[index]);
          const snapshot: CardSnapshot = { playlists: updated, complete, refreshAfter: now() + (complete ? FRESH_MS : RETRY_MS) };
          if (cache) {
            // This is a scoped internal Cache API object, never an HTTP response
            // to the browser. The route applies private browser cache headers.
            await cache.put(cacheRequest, Response.json(snapshot, {
              headers: { "cache-control": `public, max-age=${RETAIN_SECONDS}` },
            }));
          }
        }).catch(() => {
          // Cache storage is optional; preserve the previous response on failure.
        }).finally(() => {
          if (refreshing.get(lockKey) === expiresAt) refreshing.delete(lockKey);
        });
        options.waitUntil(work);
      }
    }
    return { playlists, fresh };
  };
}
