type CatalogSongIdentity = { id: string; discoverTrackId?: string; youtubeVideoId?: string };

export function catalogLikeId(song: CatalogSongIdentity): string | null {
  const trackId = song.discoverTrackId;
  if (!trackId || !/^(?:[A-Za-z0-9]{22}|yt:[A-Za-z0-9_-]{11})$/.test(trackId)) return null;
  return `catalog:${trackId}`;
}

export function songLikeId(song: CatalogSongIdentity, liked: Record<string, true>): string {
  const catalogId = catalogLikeId(song);
  return catalogId && liked[catalogId] ? catalogId : song.id;
}
