export type CatalogAlbum = {
  kind: "album";
  provider: "spotify" | "youtube";
  id: string;
  name: string;
  artist: string;
  imageUrl: string | null;
  releaseDate?: string;
  trackCount?: number;
  externalUrl: string;
};

export type AlbumSearchPayload = {
  query: string;
  albums: CatalogAlbum[];
  providers?: Partial<Record<CatalogAlbum["provider"], "ok" | "unavailable" | "not_requested">>;
};

export type AlbumReference = Pick<CatalogAlbum, "provider" | "id">;

export function isYouTubeAlbumId(id: string): boolean {
  return /^(?:OLAK5uy_|MPREb_)[A-Za-z0-9_-]{6,56}$/.test(id);
}

// Only public album URLs are accepted. Never fetch a caller-supplied host.
export function parseAlbumLink(value: string): AlbumReference | null {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    if (url.hostname === "open.spotify.com") {
      const match = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?album\/([A-Za-z0-9]{22})\/?$/);
      return match ? { provider: "spotify", id: match[1] } : null;
    }
    if (!["music.youtube.com", "www.youtube.com", "youtube.com"].includes(url.hostname)) return null;
    const id = url.pathname === "/playlist"
      ? url.searchParams.get("list") ?? ""
      : url.pathname.match(/^\/browse\/(MPREb_[A-Za-z0-9_-]+)\/?$/)?.[1] ?? "";
    return isYouTubeAlbumId(id) ? { provider: "youtube", id } : null;
  } catch {
    return null;
  }
}

export function albumSearchPath(query: string): string {
  return `/api/search/albums?q=${encodeURIComponent(query.trim())}`;
}

export function albumPagePath(album: AlbumReference): string {
  return `/search/album/${album.provider}/${encodeURIComponent(album.id)}`;
}

export function albumDetailPath(album: AlbumReference): string {
  return `/api/catalog/${album.provider}/albums/${encodeURIComponent(album.id)}`;
}
