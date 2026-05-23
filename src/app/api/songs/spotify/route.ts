import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export const dynamic = "force-dynamic";

type ActionPayload = {
  action?: unknown;
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
};

type Availability = {
  tidal: boolean;
  qobuz: boolean;
  amazon: boolean;
  tidalUrl: string;
  qobuzUrl: string;
  amazonUrl: string;
};

const REQUEST_TIMEOUT_MS = 20_000;
const QOBUZ_APP_ID = "798273057";

class SpotifyActionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseSpotifyTrackId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host !== "spotify.com" &&
    host !== "open.spotify.com" &&
    !host.endsWith(".spotify.com")
  ) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const trackIndex = parts.findIndex((part) => part === "track");
  if (trackIndex < 0 || !parts[trackIndex + 1]) {
    return null;
  }

  const trackId = parts[trackIndex + 1];
  if (!/^[A-Za-z0-9]{22}$/.test(trackId)) {
    return null;
  }

  return trackId;
}

function parseTrackIdFromUrl(url: string): string | null {
  const match = url.match(/\/track\/([A-Za-z0-9]+)/i);
  return match?.[1] ?? null;
}

function parseDeezerTrackId(songLinkPayload: Record<string, unknown>): string {
  const linksByPlatform = toObject(songLinkPayload.linksByPlatform);
  const deezerPlatform = linksByPlatform
    ? toObject(linksByPlatform.deezer)
    : null;
  if (!deezerPlatform) return "";

  const entityUniqueId = toStringValue(deezerPlatform.entityUniqueId);
  if (entityUniqueId.startsWith("DEEZER_SONG::")) {
    const id = entityUniqueId.slice("DEEZER_SONG::".length);
    if (/^\d+$/.test(id)) {
      return id;
    }
  }

  const deezerUrl = toStringValue(deezerPlatform.url);
  const deezerId = parseTrackIdFromUrl(deezerUrl);
  return deezerId && /^\d+$/.test(deezerId) ? deezerId : "";
}

function parseSongLinkMetadata(
  songLinkPayload: Record<string, unknown>,
  spotifyTrackId: string,
): {
  title: string;
  artist: string;
  imageUrl: string;
} {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (!entities) {
    return { title: "", artist: "", imageUrl: "" };
  }

  const keys = [
    toStringValue(songLinkPayload.entityUniqueId),
    `SPOTIFY_SONG::${spotifyTrackId}`,
  ];

  for (const key of keys) {
    if (!key) continue;
    const entity = toObject(entities[key]);
    if (!entity) continue;
    return {
      title: toStringValue(entity.title),
      artist: toStringValue(entity.artistName),
      imageUrl: toStringValue(entity.thumbnailUrl),
    };
  }

  return { title: "", artist: "", imageUrl: "" };
}

function extractLrcFromSpotifyLyricsApi(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }
  const obj = toObject(payload);
  if (!obj) return "";

  const direct = toStringValue(obj.lyrics || obj.lrc || obj.syncedLyrics);
  if (direct) return direct;

  const linesValue = obj.lines;
  if (!Array.isArray(linesValue)) {
    return "";
  }

  const lines: string[] = [];
  for (const item of linesValue) {
    const line = toObject(item);
    if (!line) continue;
    const words = toStringValue(line.words || line.text);
    if (!words) continue;
    const timeTag = toStringValue(line.timeTag || line.startTimeMs || line.time);
    if (timeTag) {
      lines.push(`[${timeTag}]${words}`);
    } else {
      lines.push(words);
    }
  }
  return lines.join("\n").trim();
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "waveform/1.0 (+https://local.waveform.app)",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SpotifyActionError("Request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonObject(url: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url).catch(() => {
    throw new SpotifyActionError("Upstream request failed", 502);
  });

  if (!response.ok) {
    throw new SpotifyActionError(
      `Upstream request returned ${response.status}`,
      502,
    );
  }

  const json = await response.json().catch(() => null);
  const payload = toObject(json);
  if (!payload) {
    throw new SpotifyActionError("Invalid upstream JSON", 502);
  }
  return payload;
}

async function fetchSongLinkPayload(
  trackId: string,
  region: string,
): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
  const params = new URLSearchParams({ url: spotifyUrl });
  if (region) {
    params.set("userCountry", region);
  }
  return fetchJsonObject(`https://api.song.link/v1-alpha.1/links?${params.toString()}`);
}

async function fetchDeezerTrackInfo(
  deezerTrackId: string,
): Promise<{
  album: string;
  releaseDate: string;
  durationSec: number;
  plays: number;
  isrc: string;
} | null> {
  if (!deezerTrackId) return null;

  const deezerPayload = await fetchJsonObject(
    `https://api.deezer.com/track/${deezerTrackId}`,
  ).catch(() => null);
  if (!deezerPayload) return null;

  const albumObj = toObject(deezerPayload.album);
  const durationRaw = deezerPayload.duration;
  const playsRaw = deezerPayload.rank;
  const durationSec =
    typeof durationRaw === "number"
      ? durationRaw
      : typeof durationRaw === "string"
        ? Number(durationRaw)
        : 0;
  const plays =
    typeof playsRaw === "number"
      ? playsRaw
      : typeof playsRaw === "string"
        ? Number(playsRaw)
        : 0;

  return {
    album: toStringValue(albumObj?.title),
    releaseDate: toStringValue(deezerPayload.release_date),
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    plays: Number.isFinite(plays) ? plays : 0,
    isrc: toStringValue(deezerPayload.isrc),
  };
}

async function resolveQobuzFromIsrc(isrc: string): Promise<{
  available: boolean;
  qobuzUrl: string;
}> {
  if (!isrc) {
    return { available: false, qobuzUrl: "" };
  }

  const searchUrl = `https://www.qobuz.com/api.json/0.2/track/search?query=${encodeURIComponent(
    isrc,
  )}&limit=1&app_id=${QOBUZ_APP_ID}`;
  const qobuzPayload = await fetchJsonObject(searchUrl).catch(() => null);
  const tracks = qobuzPayload ? toObject(qobuzPayload.tracks) : null;
  const totalRaw = tracks?.total;
  const total =
    typeof totalRaw === "number"
      ? totalRaw
      : typeof totalRaw === "string"
        ? Number(totalRaw)
        : 0;

  if (!Number.isFinite(total) || total <= 0) {
    return { available: false, qobuzUrl: "" };
  }

  const items = tracks?.items;
  const first = Array.isArray(items) ? toObject(items[0]) : null;
  const qobuzTrackIdRaw = first?.id;
  const qobuzTrackId =
    typeof qobuzTrackIdRaw === "number"
      ? `${qobuzTrackIdRaw}`
      : typeof qobuzTrackIdRaw === "string"
        ? qobuzTrackIdRaw
        : "";

  return {
    available: true,
    qobuzUrl: qobuzTrackId ? `https://open.qobuz.com/track/${qobuzTrackId}` : "",
  };
}

async function getPreviewUrl(trackId: string): Promise<string> {
  const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;
  const response = await fetchWithTimeout(embedUrl).catch(() => null);
  if (!response || !response.ok) {
    return "";
  }
  const html = await response.text().catch(() => "");
  const match =
    html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9?&=._-]+/)?.[0] ??
    "";
  return match;
}

async function resolveAvailability(
  songLinkPayload: Record<string, unknown>,
  deezerIsrc: string,
): Promise<Availability> {
  const linksByPlatform = toObject(songLinkPayload.linksByPlatform);
  const tidalObj = linksByPlatform ? toObject(linksByPlatform.tidal) : null;
  const amazonObj = linksByPlatform
    ? toObject(linksByPlatform.amazonMusic)
    : null;

  const tidalUrl = toStringValue(tidalObj?.url);
  const amazonUrl = toStringValue(amazonObj?.url);
  const qobuz = await resolveQobuzFromIsrc(deezerIsrc);

  return {
    tidal: Boolean(tidalUrl),
    qobuz: qobuz.available,
    amazon: Boolean(amazonUrl),
    tidalUrl,
    qobuzUrl: qobuz.qobuzUrl,
    amazonUrl,
  };
}

async function fetchLyricsText(
  trackId: string,
  title: string,
  artist: string,
): Promise<string> {
  const spotifyLyricsUrl = `https://spotify-lyrics-api-pi.vercel.app/?trackid=${encodeURIComponent(
    trackId,
  )}&format=lrc`;
  const spotifyLyricsRes = await fetchWithTimeout(spotifyLyricsUrl).catch(
    () => null,
  );
  if (spotifyLyricsRes?.ok) {
    const spotifyLyricsPayload = await spotifyLyricsRes.json().catch(() => null);
    const spotifyLyricsObj = toObject(spotifyLyricsPayload);
    const hasError = spotifyLyricsObj ? Boolean(spotifyLyricsObj.error) : false;
    if (!hasError) {
      const lrc = extractLrcFromSpotifyLyricsApi(spotifyLyricsPayload);
      if (lrc) {
        return lrc;
      }
    }
  }

  const lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(
    artist,
  )}&track_name=${encodeURIComponent(title)}`;
  const lrclibRes = await fetchWithTimeout(lrclibUrl).catch(() => null);
  if (lrclibRes?.ok) {
    const lrclibPayload = await lrclibRes.json().catch(() => null);
    const lrclibObj = toObject(lrclibPayload);
    const syncedLyrics = toStringValue(lrclibObj?.syncedLyrics);
    if (syncedLyrics) {
      return syncedLyrics;
    }
    const plainLyrics = toStringValue(lrclibObj?.plainLyrics);
    if (plainLyrics) {
      return plainLyrics;
    }
  }

  return "";
}

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;

  const payloadRaw = await req.json().catch(() => null);
  const payload = toObject(payloadRaw) as ActionPayload | null;
  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = toStringValue(payload.action).toLowerCase();
  const spotifyInput = toStringValue(payload.spotifyUrl);
  const region = toStringValue(payload.region).toUpperCase();
  const spotifyTrackId = parseSpotifyTrackId(spotifyInput);
  if (!spotifyTrackId) {
    return NextResponse.json(
      { error: "Invalid Spotify track URL or ID" },
      { status: 400 },
    );
  }

  try {
    const songLinkPayload = await fetchSongLinkPayload(spotifyTrackId, region);
    const metadata = parseSongLinkMetadata(songLinkPayload, spotifyTrackId);
    const deezerTrackId = parseDeezerTrackId(songLinkPayload);
    const deezerInfo = await fetchDeezerTrackInfo(deezerTrackId);

    if (action === "availability") {
      const availability = await resolveAvailability(
        songLinkPayload,
        deezerInfo?.isrc || "",
      );
      return NextResponse.json({ availability }, { status: 200 });
    }

    if (action === "lyrics") {
      const title = toStringValue(payload.title) || metadata.title;
      const artist = toStringValue(payload.artist) || metadata.artist;
      if (!title || !artist) {
        return NextResponse.json(
          { error: "Missing title/artist for lyrics lookup" },
          { status: 400 },
        );
      }

      const lyrics = await fetchLyricsText(spotifyTrackId, title, artist);
      if (!lyrics) {
        return NextResponse.json(
          { error: "Lyrics not found for this track" },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          lyrics,
          fileName: `${title} - ${artist}.lrc`.replace(/[\\/:*?"<>|]/g, "_"),
        },
        { status: 200 },
      );
    }

    if (action !== "fetch") {
      return NextResponse.json(
        { error: 'Invalid action. Use "fetch", "availability", or "lyrics".' },
        { status: 400 },
      );
    }

    const availability = await resolveAvailability(
      songLinkPayload,
      deezerInfo?.isrc || "",
    );
    const previewUrl = await getPreviewUrl(spotifyTrackId);

    return NextResponse.json(
      {
        track: {
          spotifyId: spotifyTrackId,
          title: metadata.title || "Unknown Title",
          artist: metadata.artist || "Unknown Artist",
          album: deezerInfo?.album || "",
          releaseDate: deezerInfo?.releaseDate || "",
          totalPlays: deezerInfo?.plays || 0,
          durationMs: (deezerInfo?.durationSec || 0) * 1000,
          imageUrl: metadata.imageUrl || "",
          previewUrl,
        },
        availability,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof SpotifyActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "Spotify action failed" },
      { status: 500 },
    );
  }
}
