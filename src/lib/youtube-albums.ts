import { isYouTubeAlbumId, type CatalogAlbum } from "@spotify/shared/catalog-albums";
import { toObject, toStringValue } from "./provider-http";

type ObjectValue = Record<string, unknown>;
export type YouTubeAlbumTrack = { videoId: string; title: string; artist: string; duration?: number };
export type YouTubeAlbumDetail = { album: CatalogAlbum; tracks: YouTubeAlbumTrack[] };

function at(value: unknown, ...keys: Array<string | number>): unknown {
  for (const key of keys) value = typeof key === "number" ? (Array.isArray(value) ? value[key] : undefined) : toObject(value)?.[key];
  return value;
}
function rows(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function runs(value: unknown): ObjectValue[] { return rows(at(value, "runs")).map(toObject).filter((v): v is ObjectValue => v !== null); }
function label(value: unknown): string { return toStringValue(at(value, "simpleText")) || runs(value).map((v) => toStringValue(v.text)).join(""); }
function renderers(value: unknown, key: string, depth = 0): ObjectValue[] {
  if (!value || typeof value !== "object" || depth > 18) return [];
  const object = toObject(value);
  const direct = toObject(object?.[key]);
  if (direct) return [direct];
  return Object.values(value).flatMap((child) => renderers(child, key, depth + 1));
}
function imageUrl(value: unknown): string | null {
  const images = rows(at(value, "thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"));
  return images.map((v) => toStringValue(at(v, "url"))).filter((v) => v.startsWith("https://")).at(-1) ?? null;
}
function column(row: ObjectValue, index: number): unknown {
  return at(row, "flexColumns", index, "musicResponsiveListItemFlexColumnRenderer", "text");
}
function artistName(value: unknown): string {
  return runs(value).filter((run) => toStringValue(at(run, "navigationEndpoint", "browseEndpoint", "browseId")).startsWith("UC"))
    .map((run) => toStringValue(run.text)).join(", ");
}
function albumListId(value: unknown): string {
  return renderers(value, "watchPlaylistEndpoint").map((v) => toStringValue(v.playlistId)).find((id) => id.startsWith("OLAK5uy_") && isYouTubeAlbumId(id)) ?? "";
}
function shelfRows(payload: unknown): ObjectValue[] {
  return ["musicShelfRenderer", "musicPlaylistShelfRenderer"].flatMap((key) => renderers(at(payload, "contents"), key))
    .flatMap((shelf) => rows(shelf.contents))
    .map((v) => toObject(at(v, "musicResponsiveListItemRenderer")))
    .filter((v): v is ObjectValue => v !== null);
}

export function parseYouTubeAlbumSearch(payload: unknown): CatalogAlbum[] {
  const albums: CatalogAlbum[] = [];
  const seen = new Set<string>();
  for (const row of shelfRows(payload)) {
    const browseId = toStringValue(at(row, "navigationEndpoint", "browseEndpoint", "browseId"));
    if (!browseId.startsWith("MPREb_") || !isYouTubeAlbumId(browseId)) continue;
    const id = albumListId(row.overlay) || browseId;
    const name = label(column(row, 0));
    if (!name || seen.has(id)) continue;
    seen.add(id);
    const releaseDate = runs(column(row, 1)).map((v) => toStringValue(v.text)).find((v) => /^\d{4}$/.test(v));
    albums.push({ kind: "album", provider: "youtube", id, name, artist: artistName(column(row, 1)), imageUrl: imageUrl(row),
      ...(releaseDate ? { releaseDate } : {}),
      externalUrl: id.startsWith("OLAK") ? `https://music.youtube.com/playlist?list=${id}` : `https://music.youtube.com/browse/${id}` });
    if (albums.length === 12) break;
  }
  return albums;
}

export function parseYouTubeAlbumDetail(payload: unknown, requestedId: string, trackPayload: unknown = payload): YouTubeAlbumDetail {
  const header = renderers(payload, "musicResponsiveHeaderRenderer")[0] ?? renderers(payload, "musicDetailHeaderRenderer")[0];
  const name = label(header?.title);
  if (!header || !name) throw new Error("YouTube Music did not return an album");
  const id = albumListId(header) || requestedId;
  const artist = artistName(header.straplineTextOne) || artistName(header.subtitle);
  const releaseDate = runs(header.subtitle).map((v) => toStringValue(v.text)).find((v) => /^\d{4}$/.test(v));
  const tracks: YouTubeAlbumTrack[] = [];
  const seen = new Set<string>();
  for (const row of shelfRows(trackPayload)) {
    const videoId = toStringValue(at(row, "playlistItemData", "videoId"));
    const title = label(column(row, 0));
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title || seen.has(videoId)) continue;
    seen.add(videoId);
    const durationText = label(at(row, "fixedColumns", 0, "musicResponsiveListItemFixedColumnRenderer", "text"));
    const duration = /^\d+(?::\d{2}){1,2}$/.test(durationText) ? durationText.split(":").reduce((total, n) => total * 60 + Number(n), 0) : undefined;
    tracks.push({ videoId, title, artist: artistName(column(row, 1)) || artist, duration });
  }
  if (!tracks.length) throw new Error("This album has no available tracks");
  return { album: { kind: "album", provider: "youtube", id, name, artist, imageUrl: imageUrl(header), trackCount: tracks.length,
    ...(releaseDate ? { releaseDate } : {}),
    externalUrl: id.startsWith("OLAK") ? `https://music.youtube.com/playlist?list=${id}` : `https://music.youtube.com/browse/${id}` }, tracks };
}

async function musicRequest(endpoint: "search" | "browse", body: ObjectValue): Promise<unknown> {
  // Public metadata only: no user's YouTube cookies or personalised library.
  const version = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const response = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST", signal: AbortSignal.timeout(6_000), redirect: "manual",
    headers: { "content-type": "application/json", origin: "https://music.youtube.com" },
    body: JSON.stringify({ context: { client: { clientName: "WEB_REMIX", clientVersion: `1.${version}.01.00`, hl: "en", gl: "GB" } }, ...body }),
  });
  if (!response.ok) throw new Error(`YouTube Music returned ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("YouTube Music returned an empty response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) throw new Error("YouTube Music response was too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const payload: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!toObject(payload) || at(payload, "error")) throw new Error("YouTube Music returned an invalid response");
  return payload;
}

export async function searchYouTubeAlbums(query: string): Promise<CatalogAlbum[]> {
  return parseYouTubeAlbumSearch(await musicRequest("search", { query, params: "EgWKAQIYAWoMEA4QChADEAQQCRAF" }));
}

export async function fetchYouTubeAlbum(id: string): Promise<YouTubeAlbumDetail> {
  if (!isYouTubeAlbumId(id)) throw new Error("Invalid YouTube album ID");
  let payload = await musicRequest("browse", { browseId: id.startsWith("OLAK") ? `VL${id}` : id });
  const trackPayload = payload;
  if (id.startsWith("OLAK")) {
    // Playlist links contain the canonical album browse ID in the track credits.
    const browseId = shelfRows(payload).flatMap((row) => runs(column(row, 2)))
      .map((run) => toStringValue(at(run, "navigationEndpoint", "browseEndpoint", "browseId")))
      .find((value) => value.startsWith("MPREb_") && isYouTubeAlbumId(value));
    if (browseId) payload = await musicRequest("browse", { browseId });
  }
  return parseYouTubeAlbumDetail(payload, id, trackPayload);
}
