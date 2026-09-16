export const YOUTUBE_PLAYLIST_SEARCH_INCLUDE = "youtube-playlists";

export type CatalogSearchFilter = "top" | "songs" | "albums" | "artists" | "playlists";
export type CatalogSearchSection = "songs" | "albums" | "artists" | "playlists";

const SECTION_ORDER: Record<CatalogSearchFilter, readonly CatalogSearchSection[]> = {
  top: ["songs", "albums", "artists", "playlists"],
  songs: ["songs"],
  albums: ["albums"],
  artists: ["artists"],
  playlists: ["playlists"],
};

export function catalogSearchSectionOrder(
  filter: CatalogSearchFilter,
): readonly CatalogSearchSection[] {
  return SECTION_ORDER[filter];
}

export function catalogSearchPath(query: string, filter: CatalogSearchFilter): string {
  const includeYouTube =
    filter === "playlists" ? `&include=${YOUTUBE_PLAYLIST_SEARCH_INCLUDE}` : "";
  return `/api/search/catalog?q=${encodeURIComponent(query)}${includeYouTube}`;
}
