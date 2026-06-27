const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_REQUEST_TIMEOUT_MS = 8_000;
// Last.fm calls fan out per seed, so cap how many seeds we hit to keep the
// overall recommend request fast (and to stay polite to the public API).
const MAX_SEEDS = 8;

type SeedTrack = { title: string; artist: string };

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Bare fetch() has no timeout, so a hung Last.fm endpoint would stall the
// recommend flow. Wrap each request with an AbortController-backed timeout; on
// timeout/network error resolve to null so callers keep their `.catch(() => [])`
// fallback. (Mirrors spotify-pathfinder.ts fetchWithTimeout.)
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = LASTFM_REQUEST_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function lastFmUrl(method: string, params: Record<string, string>, apiKey: string): string {
  const search = new URLSearchParams({
    method,
    api_key: apiKey,
    format: "json",
    autocorrect: "1",
    ...params,
  });
  return `${LASTFM_API_URL}?${search.toString()}`;
}

// Pull {title, artist} pairs out of a Last.fm track-list response. Both
// track.getSimilar and artist.getTopTracks nest their rows under a single
// container key (`similartracks`/`toptracks`) → `track[]`, each row carrying a
// `name` plus an `artist` that is either a string or an object with `.name`.
function tracksFromTrackList(payload: unknown, containerKey: string): SeedTrack[] {
  const container = toObject(toObject(payload)?.[containerKey]);
  const rows = Array.isArray(container?.track) ? container.track : [];
  const tracks: SeedTrack[] = [];
  for (const row of rows) {
    const record = toObject(row);
    if (!record) continue;
    const title = toStringValue(record.name);
    const artistValue = record.artist;
    const artist =
      typeof artistValue === "string" ? toStringValue(artistValue) : toStringValue(toObject(artistValue)?.name);
    if (title && artist) tracks.push({ title, artist });
  }
  return tracks;
}

// Pull artist names out of an artist.getSimilar response.
function artistsFromSimilar(payload: unknown): string[] {
  const container = toObject(toObject(payload)?.similarartists);
  const rows = Array.isArray(container?.artist) ? container.artist : [];
  const artists: string[] = [];
  for (const row of rows) {
    const name = toStringValue(toObject(row)?.name);
    if (name) artists.push(name);
  }
  return artists;
}

async function getSimilarTracks(seed: SeedTrack, apiKey: string, limit: number): Promise<SeedTrack[]> {
  const url = lastFmUrl(
    "track.getsimilar",
    { artist: seed.artist, track: seed.title, limit: String(limit) },
    apiKey,
  );
  const response = await fetchWithTimeout(url);
  if (!response?.ok) return [];
  const payload = await response.json().catch(() => null);
  return tracksFromTrackList(payload, "similartracks");
}

async function getSimilarArtists(artist: string, apiKey: string, limit: number): Promise<string[]> {
  const url = lastFmUrl("artist.getsimilar", { artist, limit: String(limit) }, apiKey);
  const response = await fetchWithTimeout(url);
  if (!response?.ok) return [];
  const payload = await response.json().catch(() => null);
  return artistsFromSimilar(payload);
}

async function getArtistTopTracks(artist: string, apiKey: string, limit: number): Promise<SeedTrack[]> {
  const url = lastFmUrl("artist.gettoptracks", { artist, limit: String(limit) }, apiKey);
  const response = await fetchWithTimeout(url);
  if (!response?.ok) return [];
  const payload = await response.json().catch(() => null);
  return tracksFromTrackList(payload, "toptracks");
}

// Per seed, ask Last.fm for similar tracks; if that comes up short, fall back to
// the seed artist's similar artists' top tracks, then the seed artist's own top
// tracks. Each network call is timeout-wrapped + `.catch(() => [])` so one slow
// or failing seed can't sink the batch. Returns a flat, case-insensitively
// deduped {title, artist} list, over-fetched (~3x limit) so the downstream
// dedupe/name→id resolve still lands near `limit`.
export async function fetchLastFmSimilarTracks(
  seeds: SeedTrack[],
  apiKey: string,
  limit: number,
): Promise<SeedTrack[]> {
  const cleanSeeds = seeds
    .map((seed) => ({ title: toStringValue(seed.title), artist: toStringValue(seed.artist) }))
    .filter((seed) => seed.title && seed.artist)
    .slice(0, MAX_SEEDS);
  if (cleanSeeds.length === 0) return [];

  const target = Math.max(1, limit) * 3;
  // Per-seed over-fetch so the flattened pool still clears `target` after dedupe.
  const perSeed = Math.max(5, Math.ceil(target / cleanSeeds.length) + 5);

  const collected = await Promise.all(
    cleanSeeds.map(async (seed) => {
      const direct = await getSimilarTracks(seed, apiKey, perSeed).catch(() => []);
      if (direct.length >= Math.min(perSeed, 5)) return direct;

      // Sparse seed: widen out through the artist graph.
      const fallback: SeedTrack[] = [...direct];
      const similarArtists = await getSimilarArtists(seed.artist, apiKey, 5).catch(() => []);
      const artists = [seed.artist, ...similarArtists].slice(0, 4);
      const topTrackLists = await Promise.all(
        artists.map((artist) => getArtistTopTracks(artist, apiKey, perSeed).catch(() => [])),
      );
      for (const list of topTrackLists) fallback.push(...list);
      return fallback;
    }),
  );

  const deduped: SeedTrack[] = [];
  const seen = new Set<string>();
  for (const list of collected) {
    for (const track of list) {
      const key = `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(track);
    }
  }
  return deduped;
}
