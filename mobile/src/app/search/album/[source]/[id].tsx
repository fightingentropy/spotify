import { Redirect, useLocalSearchParams } from "expo-router";
import { albumDetailPath, isYouTubeAlbumId } from "@spotify/shared/catalog-albums";
import { PlaylistDetailScreen } from "@/app/playlist/[id]";

export default function AlbumScreen() {
  const { source, id } = useLocalSearchParams<{ source: string; id: string }>();
  if ((source !== "spotify" && source !== "youtube") || !id ||
    (source === "youtube" ? !isYouTubeAlbumId(id) : !/^[A-Za-z0-9]{22}$/.test(id))) return <Redirect href="/search" />;
  return <PlaylistDetailScreen playlistId={`album:${source}:${id}`} apiPath={albumDetailPath({ provider: source, id })}
    queueContextKey={`playlist:album:${source}:${id}`} collectionType="album" emptyTitle="No tracks available" />;
}
