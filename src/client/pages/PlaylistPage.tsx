import { useParams } from "react-router-dom";
import { useApiData, type PlaylistPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";
import { OfflineBulkDownloadButton } from "@/components/OfflineDownloadButton";

export default function PlaylistPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const { data, loading, error } = useApiData<PlaylistPayload>(`/api/playlist/${encodeURIComponent(id)}`, {
    playlist: null,
    songs: [],
    likedSongIds: [],
  });

  if (loading) return <div className="px-6 py-8 max-w-7xl mx-auto opacity-70">Loading playlist...</div>;
  if (error) return <div className="px-6 py-8 max-w-7xl mx-auto text-red-500">{error}</div>;
  if (!data.playlist) return <div className="px-6 py-8 max-w-7xl mx-auto opacity-70">Playlist not found.</div>;

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="mb-4 flex flex-col items-start gap-3 sm:mb-6 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{data.playlist.name}</h1>
          <div className="mt-1 text-sm opacity-70">{data.songs.length} tracks</div>
        </div>
        {data.songs.length > 0 ? (
          <OfflineBulkDownloadButton
            songs={data.songs}
            scope={`playlist:${data.playlist.id}`}
            label="Download playlist"
            className="w-full justify-center sm:w-auto"
          />
        ) : null}
      </div>
      {data.songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid
          songs={data.songs}
          likedSongIds={data.likedSongIds}
          canLike={!!user}
          viewToggleClassName="mb-8 sm:-mt-14"
        />
      )}
      <div className="h-24" />
    </div>
  );
}
