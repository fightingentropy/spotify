import type { Hono } from "hono";
import { fetchSpotifyPlaylistCatalogPage } from "@/lib/spotify-pathfinder";
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
import { stageDiscoverWithFallback } from "./discover-stage";

// Spotify's editorial "Top 50 - Global" playlist — globally trending tracks right
// now. Fetched via the pathfinder (works anonymously for public playlists). Each
// track carries its Spotify id; tapping a track plays it instantly from the
// Mac-mini's hidden ".discover" staging cache (pre-downloaded in the background)
// without adding it to the library. See the staging endpoints below + the
// matching handlers in local-music-server.ts.
const TOP_50_GLOBAL_PLAYLIST_ID = "37i9dQZEVXbMDoHDwVN2tF";
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
// by the trending chart, the cron fill, and curated-playlist detail views.
async function fetchDiscoverTracksForPlaylist(
  env: CloudflareEnv,
  playlistId: string,
  limit: number,
): Promise<DiscoverTrendingTrack[]> {
  try {
    // Catalog-page metadata + contents are fetched in parallel and the outer
    // deadline bounds token acquisition too. The legacy playlist helper fetched
    // those two surfaces serially, which could exceed the mobile 15s budget on a
    // cold Top 50 open.
    const { tracks } = await withProviderDeadline(
      fetchSpotifyPlaylistCatalogPage(playlistId, envString(env, "SPOTIFY_SP_DC") || undefined, 0, limit),
      12_000,
    );
    return tracks
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
  } catch {
    return [];
  }
}

// The current "Top 50 - Global" chart (shared by the trending endpoint and the
// cron fill).
export function fetchTop50DiscoverTracks(env: CloudflareEnv): Promise<DiscoverTrendingTrack[]> {
  return fetchDiscoverTracksForPlaylist(env, TOP_50_GLOBAL_PLAYLIST_ID, 50);
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
      ? { ...track, staged: true, audioId: ready.id, audioUrl: ready.audioUrl }
      : { ...track, staged: false };
  });
}

// Ask the Mac-mini which of these tracks are already staged (instantly playable
// from .discover) and fold that status into each track. Best-effort: on any
// failure (or when staging isn't configured) every track is reported unstaged,
// which just means a tap materializes it on demand. Shared by the Discover row
// and curated-playlist detail views.
export async function markDiscoverStaged(
  env: CloudflareEnv,
  tracks: DiscoverTrendingTrack[],
  timeoutMs = 4_000,
): Promise<DiscoverStagedTrack[]> {
  return applyDiscoverStaging(tracks, await readDiscoverStagingStatus(env, timeoutMs));
}

// The YouTube Music auto-updating "Discover Mix" surfaced as a Home playlist card —
// personalized to the library owner's Premium account (the mini fetches it with the
// owner's cookies). Playlist id is "yt-mix-<listId>"; tracks stream as Opus preview.
const YT_DISCOVER_MIX_LIST_ID = "RDTMAK5uy_n_5IN6hzAOwdCnM8D8rzrs3vDl12UcZpA";
const readDiscoverCards = createDiscoverCardCache();

// Convert a Discover chart track (with staged status) into a player song — a real,
// instantly-playable song when staged, else a placeholder the discover-stager
// materializes on play. Mirrors the mobile discoverTrackToPlayerSong so the Top-50
// playlist detail renders + plays exactly like the old Discover row (lossless).
export function discoverStagedToPlayerSong(track: DiscoverStagedTrack): PlayerSong {
  const duration = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
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

// Refresh Home's cached mix metadata from the mini in the background. Keep the
// provider deadline inside the post-response budget; a miss retains the previous
// card and the detail route can still retry its live playlist fetch.
async function youtubeDiscoverMixCard(
  env: CloudflareEnv,
): Promise<{ id: string; name: string; imageUrl: string; songsCount: number; resolved: boolean }> {
  const fallback = { id: `yt-mix-${YT_DISCOVER_MIX_LIST_ID}`, name: "Discover Mix", imageUrl: "", songsCount: 0, resolved: false };
  try {
    const res = await macMiniDiscoverFetch(
      env,
      `/api/youtube/playlists/${YT_DISCOVER_MIX_LIST_ID}`,
      "GET",
      undefined,
      12_000,
    );
    if (!res.ok) return fallback;
    const body = (await res.json()) as { playlist?: { name?: string; imageUrl?: string | null }; songs?: unknown[] };
    const songsCount = Array.isArray(body.songs) ? body.songs.length : 0;
    return {
      id: fallback.id,
      name: body.playlist?.name || "Discover Mix",
      imageUrl: body.playlist?.imageUrl || "",
      songsCount,
      // Resolved when we actually got the mix back (tracks present): the card then
      // has a real cover + count and is safe to cache for longer.
      resolved: songsCount > 0,
    };
  } catch {
    return fallback;
  }
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
app.get("/api/discover/trending", async (c) => {
  const discover = await fetchTop50DiscoverTracks(c.env);
  if (!discover.length) {
    return jsonCached(c, { tracks: [] }, { cacheControl: "public, max-age=120" });
  }
  if (!isMacMiniMusicConfigured(c.env)) {
    return jsonCached(c, { tracks: discover }, {
      cacheControl: "public, max-age=1800, stale-while-revalidate=7200",
    });
  }

  // Mark which tracks are already staged (instantly playable from .discover).
  // The actual fill happens on the cron (runDiscoverFill); this endpoint only
  // reads status, so it stays fast.
  const tracks = await markDiscoverStaged(c.env, discover);

  // Short cache: a track's staged status changes as the cron fill completes.
  return jsonCached(c, { tracks }, { cacheControl: "private, max-age=30, stale-while-revalidate=300" });
});

// The Home "Discover" first row as clickable, auto-updating PLAYLISTS (instead of a
// horizontal scroll of individual tracks): Top 50 (lossless chart) + the YouTube
// Music Discover Mix (Opus preview, owner's Premium). Each card opens
// /api/playlist/:id ("discover-top50" / "yt-mix-<listId>").
app.get("/api/discover/playlists", async (c) => {
  const user = c.get("user");
  const sources: Array<{ fallback: DiscoverPlaylistCard; authenticatedOnly?: boolean; load: () => Promise<DiscoverPlaylistCard | null> }> = [{
    fallback: { id: "discover-top50", name: "Top 50", imageUrl: "", songsCount: 0 },
    load: async () => {
      const top = await fetchTop50DiscoverTracks(c.env);
      return top.length ? { id: "discover-top50", name: "Top 50", imageUrl: top[0]?.imageUrl || "", songsCount: top.length } : null;
    },
  }];
  // The mini's mix is personalized to its owner. It stays behind the same
  // authentication gate as before and never enters the anonymous card cache.
  if (isMacMiniMusicConfigured(c.env) && user) {
    sources.push({
      authenticatedOnly: true,
      fallback: { id: `yt-mix-${YT_DISCOVER_MIX_LIST_ID}`, name: "Discover Mix", imageUrl: "", songsCount: 0 },
      load: async () => {
        const { resolved, ...card } = await youtubeDiscoverMixCard(c.env);
        return resolved ? card : null;
      },
    });
  }
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
  const preview = payload.preview === true || Boolean(youtubeVideoId);
  const res = await stageDiscoverWithFallback({
    preview,
    youtubeVideoId,
    resolve: () => resolveStreamUrl(c.env, payload),
    stage: (source) => macMiniDiscoverFetch(c.env, "/api/discover/stage", "POST", {
      trackId,
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
