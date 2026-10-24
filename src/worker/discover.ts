import type { Hono } from "hono";
import { fetchSpotifyPlaylistCatalogPage } from "@/lib/spotify-pathfinder";
import { DISCOVER_CHARTS } from "@/lib/discover-playlists";
import type { PlayerSong } from "@/types/player";
import { LOCAL_MAC_MINI_AUTH_USER, type AppEnv } from "./env";
import { jsonCached, jsonError, requireUser } from "./http";
import { fetchMacMini, getMacMiniOrigin, isMacMiniMusicConfigured } from "./mac-mini-proxy";
import { createDiscoverCardCache, type DiscoverPlaylistCard } from "./discover-card-cache";
import { readJson } from "./request";
import { envString, toNumberValue, toStringValue } from "./values";
import { withProviderDeadline } from "./fetch";
import type { SongPayload } from "./payloads";
import { parseSpotifyTrackId, resolveStreamUrl } from "./provider-download";
import { downloadStagingId, stageDiscoverWithFallback } from "./discover-stage";
import { downloadPreferences } from "./download-preferences";

// Spotify's editorial "Top 50 - Global" playlist, fetched anonymously via the
// pathfinder. Each track carries its Spotify id; tapping one plays it from the
// Mac-mini's hidden ".discover" staging cache (pre-downloaded by the cron fill)
// without adding it to the library. See the staging endpoints below and the
// matching handlers in local-music-server.ts.
const TOP_50_GLOBAL_PLAYLIST_ID = DISCOVER_CHARTS[0].spotifyId;
// How many not-yet-staged Top-50 tracks to resolve + enqueue per cron tick.
// Resolution walks many providers and is slow, so this is bounded; the rest
// fill in over subsequent ticks.
const DISCOVER_STAGE_BATCH = 6;

export type DiscoverTrendingTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  imageUrl: string;
  durationMs: number | null;
  spotifyUrl: string;
};
type DiscoverStagingStatusEntry = { trackId: string; id: string; audioUrl: string; duration?: number };

// Call a Mac-mini /api/discover/* endpoint as the library owner (staging is a
// single shared cache owned by the library owner, regardless of who is viewing).
export async function macMiniDiscoverFetch(
  env: CloudflareEnv,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  timeoutMs = 15_000,
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetchMacMini({
    env,
    target: path,
    method,
    user: LOCAL_MAC_MINI_AUTH_USER,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Background: resolve up to DISCOVER_STAGE_BATCH missing tracks and hand the
// Mac-mini the current Top-50 (to refresh + prune) plus the resolved descriptors
// to materialize into staging. The Mac-mini does the heavy download async, so
// this returns as soon as the resolves + one sync POST complete.
async function fillDiscoverStaging(
  env: CloudflareEnv,
  presentIds: string[],
  missing: DiscoverTrendingTrack[],
): Promise<void> {
  const stage: unknown[] = [];
  for (const track of missing) {
    try {
      const resolved = await resolveStreamUrl(env, {
        mode: "spotify",
        spotifyUrl: track.spotifyUrl,
        region: "US",
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs ?? undefined,
        qualityProfile: "max",
      });
      stage.push({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        imageUrl: track.imageUrl,
        durationMs: track.durationMs ?? undefined,
        resolved,
      });
    } catch {
      // Skip this track; a later cron tick retries it.
    }
  }
  await macMiniDiscoverFetch(env, "/api/discover/sync", "POST", { present: presentIds, stage }, 10_000).catch(() => {});
}

// Fetch + normalize a Spotify playlist's tracks into the Discover shape. Shared
// by the cron fill and the chart playlist views.
export async function fetchDiscoverPlaylist(
  env: CloudflareEnv,
  playlistId: string,
  limit: number,
): Promise<{ imageUrl: string; tracks: DiscoverTrendingTrack[] }> {
  try {
    // Catalog-page metadata + contents are fetched in parallel and the outer
    // deadline bounds token acquisition too. The legacy playlist helper fetched
    // those two surfaces serially, which could exceed the mobile 15s budget on a
    // cold Top 50 open.
    const { playlist, tracks } = await withProviderDeadline(
      fetchSpotifyPlaylistCatalogPage(playlistId, envString(env, "SPOTIFY_SP_DC") || undefined, 0, limit),
      12_000,
    );
    const normalized = tracks
      .filter((track) => track.id && track.name && track.artists.length > 0)
      .map((track) => ({
        id: track.id,
        title: track.name,
        artist: track.artists.join(", "),
        album: track.album || "",
        imageUrl: track.imageUrl || "/apple-icon.png",
        durationMs: typeof track.durationMs === "number" && track.durationMs > 0 ? track.durationMs : null,
        spotifyUrl: `https://open.spotify.com/track/${track.id}`,
      }));
    return { imageUrl: playlist.imageUrl || "", tracks: normalized };
  } catch {
    return { imageUrl: "", tracks: [] };
  }
}

// The current "Top 50 - Global" chart, for the cron fill.
export async function fetchTop50DiscoverTracks(env: CloudflareEnv): Promise<DiscoverTrendingTrack[]> {
  return (await fetchDiscoverPlaylist(env, TOP_50_GLOBAL_PLAYLIST_ID, 50)).tracks;
}

export type DiscoverStagedTrack = DiscoverTrendingTrack & { staged: boolean; audioId?: string; audioUrl?: string };

export async function readDiscoverStagingStatus(
  env: CloudflareEnv,
  timeoutMs = 4_000,
): Promise<Map<string, DiscoverStagingStatusEntry>> {
  const staged = new Map<string, DiscoverStagingStatusEntry>();
  if (isMacMiniMusicConfigured(env)) {
    try {
      const res = await macMiniDiscoverFetch(env, "/api/discover/staging", "GET", undefined, timeoutMs);
      if (res.ok) {
        const body = (await res.json()) as { entries?: DiscoverStagingStatusEntry[] };
        for (const entry of body.entries ?? []) staged.set(entry.trackId, entry);
      }
    } catch {
      // Staging status is best-effort; fall back to "not staged".
    }
  }
  return staged;
}

export function applyDiscoverStaging(
  tracks: DiscoverTrendingTrack[],
  staged: Map<string, DiscoverStagingStatusEntry>,
): DiscoverStagedTrack[] {
  return tracks.map((track) => {
    const ready = staged.get(track.id);
    return ready
      ? {
        ...track,
        durationMs: typeof ready.duration === "number" && Number.isFinite(ready.duration) && ready.duration > 0
          ? Math.round(ready.duration * 1000)
          : track.durationMs,
        staged: true, audioId: ready.id, audioUrl: ready.audioUrl,
      }
      : { ...track, staged: false };
  });
}

// Ask the Mac-mini which of these tracks are already staged (instantly playable
// from .discover) and fold that status into each track. Best-effort: on any
// failure (or when staging isn't configured) every track is reported unstaged,
// which just means a tap materializes it on demand. Used by the chart playlist
// views and song recommendations.
export async function markDiscoverStaged(
  env: CloudflareEnv,
  tracks: DiscoverTrendingTrack[],
  timeoutMs = 4_000,
): Promise<DiscoverStagedTrack[]> {
  return applyDiscoverStaging(tracks, await readDiscoverStagingStatus(env, timeoutMs));
}

const readDiscoverCards = createDiscoverCardCache();

// Convert a Discover chart track (with staged status) into a player song — a real,
// instantly-playable song when staged, else a placeholder the discover-stager
// materializes on play. Mirrors the mobile discoverTrackToPlayerSong.
export function discoverStagedToPlayerSong(track: DiscoverStagedTrack): PlayerSong {
  const duration = track.durationMs ? track.durationMs / 1000 : undefined;
  if (track.staged && track.audioUrl && track.audioId) {
    return {
      id: track.audioId,
      title: track.title,
      artist: track.artist,
      album: track.album || undefined,
      imageUrl: track.imageUrl,
      audioUrl: track.audioUrl,
      duration,
      source: "server",
      staged: true,
      discoverTrackId: track.id,
    };
  }
  return {
    id: `discover:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    imageUrl: track.imageUrl,
    audioUrl: "",
    duration,
    source: "server",
    discoverTrackId: track.id,
  };
}

// What the mini needs to stage a search's top song before anyone taps it, or
// null when that song is already staged and plays at once.
export function catalogPreparePayload(results: PlayerSong[]): Record<string, unknown> | null {
  const top = results[0];
  if (!top?.discoverTrackId || top.audioUrl) return null;
  return {
    trackId: top.discoverTrackId,
    title: top.title,
    artist: top.artist,
    album: top.album,
    imageUrl: top.imageUrl,
    durationMs: top.duration ? Math.round(top.duration * 1000) : undefined,
  };
}

// Search's likeliest tap is its top song. The mini waits for the results to
// settle while someone is still typing, then stages that song in the background,
// so a tap on it joins or reuses the download (handleDiscoverPrepare).
export function prepareTopCatalogSong(
  env: CloudflareEnv,
  results: PlayerSong[],
  waitUntil: (work: Promise<unknown>) => void,
): void {
  const payload = catalogPreparePayload(results);
  if (!payload || !isMacMiniMusicConfigured(env)) return;
  waitUntil(
    macMiniDiscoverFetch(env, "/api/discover/prepare", "POST", payload, 5_000)
      .then((response) => response.body?.cancel())
      .catch(() => {}),
  );
}

// Cron-driven background fill: stage a batch of not-yet-cached Top-50 tracks and
// hand the Mac-mini the current chart so it refreshes lastSeen + prunes stale
// entries. Runs on a Cron Trigger because per-track resolution can take tens of
// seconds — too slow for a request's post-response waitUntil budget.
export async function runDiscoverFill(env: CloudflareEnv): Promise<void> {
  if (!isMacMiniMusicConfigured(env)) return;
  const discover = await fetchTop50DiscoverTracks(env);
  if (!discover.length) return;
  const staged = new Set<string>();
  try {
    const res = await macMiniDiscoverFetch(env, "/api/discover/staging", "GET", undefined, 8_000);
    if (res.ok) {
      const body = (await res.json()) as { entries?: DiscoverStagingStatusEntry[] };
      for (const entry of body.entries ?? []) staged.add(entry.trackId);
    }
  } catch {
    // best-effort
  }
  const missing = discover.filter((track) => !staged.has(track.id)).slice(0, DISCOVER_STAGE_BATCH);
  const presentIds = discover.map((track) => track.id);
  await fillDiscoverStaging(env, presentIds, missing);
}

export function registerDiscoverRoutes(app: Hono<AppEnv>): void {
// Cards resolve artwork in the background; a cold provider never holds up Home.
app.get("/api/discover/playlists", async (c) => {
  const user = c.get("user");
  const sources: Array<{ fallback: DiscoverPlaylistCard; load: () => Promise<DiscoverPlaylistCard | null> }> = DISCOVER_CHARTS.map((chart) => ({
    fallback: { id: chart.id, name: chart.name, imageUrl: "", songsCount: 0 },
    load: async () => {
      const { playlist } = await withProviderDeadline(
        fetchSpotifyPlaylistCatalogPage(chart.spotifyId, envString(c.env, "SPOTIFY_SP_DC") || undefined, 0, 1),
        12_000,
      );
      return { id: chart.id, name: chart.name, imageUrl: playlist.imageUrl || "", songsCount: playlist.trackCount ?? 0 };
    },
  }));
  const { playlists, fresh } = await readDiscoverCards({
    requestUrl: c.req.url,
    userId: user?.id ?? null,
    privateOrigin: getMacMiniOrigin(c.env),
    sources,
    openCache: () => caches.open("discover-cards-v1"),
    waitUntil: (work) => c.executionCtx.waitUntil(work),
  });
  return jsonCached(c, { playlists }, {
    cacheControl: fresh ? "private, max-age=600, stale-while-revalidate=3600" : "private, max-age=30, stale-while-revalidate=120",
  });
});

// The owner's YouTube Music Home as playlist shelves (its "Your daily discover"
// shelf carries the Discover Mix). Unlike the Discover cards it is called as the
// real viewer: the mini answers only for library owners, so any
// other account gets an empty section instead of the owner's listening history.
app.get("/api/discover/youtube-home", async (c) => {
  const user = c.get("user");
  const empty = (maxAge: number) => jsonCached(c, { shelves: [] }, { cacheControl: `private, max-age=${maxAge}` });
  if (!user || !isMacMiniMusicConfigured(c.env)) return empty(300);
  const res = await fetchMacMini({
    env: c.env,
    target: "/api/youtube/home",
    method: "GET",
    user,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) {
    await res?.body?.cancel().catch(() => {});
    return empty(res?.status === 403 ? 300 : 30);
  }
  return new Response(await res.text(), {
    headers: { "content-type": "application/json", "cache-control": "private, max-age=300, stale-while-revalidate=3600" },
  });
});

// Tap a not-yet-staged Discover track: resolve + materialize ONE track into the
// staging cache (blocking, like a normal import) and return a playable song. The
// song is NOT in the library until a "keep" action promotes it.
app.post("/api/discover/stage", async (c) => {
  requireUser(c.get("user"));
  if (!isMacMiniMusicConfigured(c.env)) return jsonError("Discover streaming is not available", 503);
  const payload = await readJson<SongPayload & { trackId?: unknown; youtubeVideoId?: unknown }>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);
  // A YouTube Music mix track carries its exact videoId (no Spotify id). The mini
  // stages THAT video's Opus directly — always a preview, never resolver-backed.
  const youtubeVideoId = toStringValue(payload.youtubeVideoId);
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl)) || toStringValue(payload.trackId);
  if (!trackId) return jsonError("Invalid Spotify track URL or ID", 400);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  // A direct-videoId mix track needs only a title (artist is best-effort); a
  // Spotify-keyed track needs both to search/label.
  if (!title || (!artist && !youtubeVideoId)) return jsonError("Title and artist are required", 400);
  // Playback previews go straight to YouTube. Library saves try the configured
  // providers first, then download YouTube's best available audio on failure.
  const preferences = downloadPreferences(payload);
  const strictAtmos = toStringValue(payload.qualityProfile).toLowerCase() === "atmos" && preferences?.atmosFallback === false;
  const preview = payload.preview === true || Boolean(youtubeVideoId);
  const res = await stageDiscoverWithFallback({
    preview,
    youtubeVideoId,
    allowYouTubeFallback: payload.allowYouTubeFallback !== false && !strictAtmos,
    libraryFallback: payload.libraryFallback === true,
    resolve: () => resolveStreamUrl(c.env, payload),
    stage: (source) => macMiniDiscoverFetch(c.env, "/api/discover/stage", "POST", {
      trackId: payload.downloadRequest === true
        ? downloadStagingId(trackId, toStringValue(payload.service), toStringValue(payload.qualityProfile), preferences)
        : trackId,
      title,
      artist,
      album: toStringValue(payload.album),
      imageUrl: toStringValue(payload.imageUrl),
      durationMs: toNumberValue(payload.durationMs) ?? undefined,
      ...source,
      ...(youtubeVideoId ? { youtubeVideoId } : {}),
    }, 120_000),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

// Promote a staged Discover track into the real library (move it out of
// .discover so it scans + can be liked). Returns the now-real song; the client
// then performs the actual keep action (like / add-to-playlist / download).
app.post("/api/discover/promote", async (c) => {
  requireUser(c.get("user"));
  if (!isMacMiniMusicConfigured(c.env)) return jsonError("Discover streaming is not available", 503);
  const payload = await readJson<{ trackId?: unknown; finalId?: unknown }>(c.req.raw);
  const trackId = toStringValue(payload?.trackId);
  if (!trackId) return jsonError("trackId is required", 400);
  const finalId = toStringValue(payload?.finalId);
  const res = await macMiniDiscoverFetch(
    c.env,
    "/api/discover/promote",
    "POST",
    { trackId, finalId },
    30_000,
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});
}
