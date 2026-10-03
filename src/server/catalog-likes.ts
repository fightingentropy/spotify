import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { catalogLikeId } from "../../packages/shared/src/catalog-like";
import type { PlayerSong } from "../types/player";
import type { LibrarySource } from "./local-library-scan";

// A like is durable metadata even when a lossless source is unavailable.
// Keep these separate from file likes: a library rescan must not discard them.
type CatalogLikesFile = { version: 1; root: string; songs: PlayerSong[] };
const writes = new Map<string, Promise<unknown>>();
const cachePath = (source: LibrarySource) => resolve(dirname(source.cachePath), "catalog-likes.json");

export function normalizeCatalogLike(value: unknown, likedAt = new Date().toISOString()): PlayerSong | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PlayerSong>;
  if (typeof raw.discoverTrackId !== "string" || typeof raw.title !== "string" || !raw.title.trim()) return null;
  const id = catalogLikeId({ id: "", discoverTrackId: raw.discoverTrackId });
  if (!id) return null;
  const youtubeVideoId = raw.discoverTrackId.startsWith("yt:") ? raw.discoverTrackId.slice(3) : undefined;
  if (!youtubeVideoId && (typeof raw.artist !== "string" || !raw.artist.trim())) return null;
  let imageUrl = "/apple-icon.png";
  // Never persist temporary, signed media URLs or file paths supplied by a client.
  try {
    const image = new URL(raw.networkImageUrl || raw.imageUrl || "");
    if (["http:", "https:"].includes(image.protocol) && !image.username && !image.password && !image.searchParams.has("spotify_sig")) {
      imageUrl = image.toString();
    }
  } catch {}
  return {
    id,
    discoverTrackId: raw.discoverTrackId,
    youtubeVideoId,
    title: raw.title.trim().slice(0, 500),
    artist: typeof raw.artist === "string" ? raw.artist.trim().slice(0, 500) : "",
    album: typeof raw.album === "string" ? raw.album.trim().slice(0, 500) : undefined,
    imageUrl,
    audioUrl: "",
    duration: typeof raw.duration === "number" && Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : undefined,
    source: "server",
    preview: true,
    likedAt,
    createdAt: likedAt,
  };
}

export async function readCatalogLikes(source: LibrarySource): Promise<PlayerSong[]> {
  let contents: string;
  try {
    contents = await readFile(cachePath(source), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const file = JSON.parse(contents) as CatalogLikesFile;
  if (file.version !== 1 || file.root !== source.root || !Array.isArray(file.songs)) {
    throw new Error("Invalid catalog likes file");
  }
  return file.songs.map((song) => normalizeCatalogLike(song, song.likedAt)).filter((song): song is PlayerSong => song !== null);
}

export async function setCatalogLike(source: LibrarySource, song: PlayerSong, liked: boolean): Promise<void> {
  const path = cachePath(source);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const songs = await readCatalogLikes(source);
    const remaining = songs.filter((item) => item.id !== song.id);
    const existing = songs.find((item) => item.id === song.id);
    if (liked) remaining.unshift(existing ?? song);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, root: source.root, songs: remaining } satisfies CatalogLikesFile), { mode: 0o600 });
    await rename(temporary, path);
  });
  writes.set(path, next);
  try {
    await next;
  } finally {
    if (writes.get(path) === next) writes.delete(path);
  }
}
