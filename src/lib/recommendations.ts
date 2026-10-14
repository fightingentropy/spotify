import { looksNonCanonicalTrack, normalizeSongPart } from "@/lib/song-dedupe";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_REQUEST_TIMEOUT_MS = 8_000;
// Last.fm calls fan out per seed, so cap how many seeds we hit to keep the
// overall recommend request fast (and to stay polite to the public API).
const MAX_SEEDS = 8;

type SeedTrack = { title: string; artist: string };

export function recommendationKey(track: SeedTrack): string {
  const clean = (value: string) => normalizeSongPart(value).replace(/[^\p{L}\p{N}]/gu, "");
  return `${clean(track.title)}::${clean(track.artist)}`;
}

// Apply exclusions AFTER reading the shared candidate cache. A previous
// listener's exclusions and signed media URLs must never become cached output.
export function selectRecommendations<T extends SeedTrack & { id: string }>(
  candidates: T[], excluded: SeedTrack[], excludedIds: Set<string>, limit: number,
): T[] {
  const seen = new Set(excluded.map(recommendationKey));
  const ids = new Set(excludedIds);
  const pool = candidates.filter(track => {
    const key = recommendationKey(track);
    if (ids.has(track.id) || seen.has(key) || looksNonCanonicalTrack(track.title, track.artist)) return false;
    ids.add(track.id); seen.add(key); return true;
  });
  const selected: T[] = [];
  const artistCounts = new Map<string, number>();
  while (pool.length && selected.length < limit) {
    const lastArtist = normalizeSongPart(selected.at(-1)?.artist ?? "");
    const eligible = (track: T) => (artistCounts.get(normalizeSongPart(track.artist)) ?? 0) < 3;
    let index = pool.findIndex(track => eligible(track) && normalizeSongPart(track.artist) !== lastArtist);
    if (index < 0) index = pool.findIndex(eligible);
    if (index < 0) break;
    const [track] = pool.splice(index, 1);
    const artist = normalizeSongPart(track.artist);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    selected.push(track);
  }
  return selected;
}

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

async function lastFmPayload(method: string, params: Record<string, string>, apiKey: string): Promise<unknown> {
  const response = await fetchWithTimeout(lastFmUrl(method, params, apiKey));
  if (!response?.ok) {
    console.warn("Recommendation provider unavailable", { method, status: response?.status ?? 0 });
    return null;
  }
  const payload: unknown = await response.json().catch(() => null);
  const error = toObject(payload)?.error;
  if (typeof error === "number") {
    // Log only the provider code, never request URLs, API keys or listening data.
    console.warn("Recommendation provider error", { method, code: error });
    return null;
  }
  return payload;
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
    // Drop cover-farm / karaoke / version edits at the source so recommendations
    // stay on the canonical recording (Last.fm's "similar tracks" sometimes return
    // SEO covers like "BAD IDEA, Right? (R.R.C1)" by Ravens Rock).
    if (title && artist && !looksNonCanonicalTrack(title, artist)) tracks.push({ title, artist });
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
  const payload = await lastFmPayload(
    "track.getsimilar",
    { artist: seed.artist, track: seed.title, limit: String(limit) },
    apiKey,
  );
  return tracksFromTrackList(payload, "similartracks");
}

async function getSimilarArtists(artist: string, apiKey: string, limit: number): Promise<string[]> {
  const payload = await lastFmPayload("artist.getsimilar", { artist, limit: String(limit) }, apiKey);
  return artistsFromSimilar(payload);
}

async function getArtistTopTracks(artist: string, apiKey: string, limit: number): Promise<SeedTrack[]> {
  const payload = await lastFmPayload("artist.gettoptracks", { artist, limit: String(limit) }, apiKey);
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
      // Keep the artist-graph fallback mixed; otherwise the seed artist's
      // entire top list crowds out related artists before resolution is capped.
      for (let i = 0; i < Math.max(0, ...topTrackLists.map(list => list.length)); i++) {
        for (const list of topTrackLists) if (list[i]) fallback.push(list[i]);
      }
      return fallback;
    }),
  );

  const deduped: SeedTrack[] = [];
  const seen = new Set<string>();
  for (const list of collected) {
    for (const track of list) {
      const key = recommendationKey(track);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(track);
    }
  }
  return deduped;
}
