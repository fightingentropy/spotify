import { useParams } from "react-router-dom";
import { useApiData, type PlaylistPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";

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
      <h1 className="text-2xl font-semibold mb-1">{data.playlist.name}</h1>
      <div className="text-sm opacity-70 mb-6">{data.songs.length} tracks</div>
      {data.songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid
          songs={data.songs}
          likedSongIds={data.likedSongIds}
          canLike={!!user}
          viewToggleClassName="-mt-14 mb-8"
        />
      )}
      <div className="h-24" />
    </div>
  );
}
