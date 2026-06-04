import { useParams } from "react-router-dom";
import { useApiData, withAccountScope, type PlaylistPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";
import { OfflineBulkDownloadButton } from "@/components/OfflineDownloadButton";

function PlaylistLoadingSkeleton() {
  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="mb-8 space-y-3">
        <div className="wf-skeleton h-7 w-56 max-w-full rounded-full" />
        <div className="wf-skeleton h-4 w-24 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="space-y-3">
            <div className="wf-skeleton aspect-square rounded-lg" />
            <div className="wf-skeleton h-4 rounded-full" />
            <div className="wf-skeleton h-3 w-2/3 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PlaylistPage() {
  const { id = "" } = useParams();
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<PlaylistPayload>(
    withAccountScope(`/api/playlist/${encodeURIComponent(id)}`, user?.id ?? status),
    {
      playlist: null,
      songs: [],
      likedSongIds: [],
    },
  );

  if (loading) return <PlaylistLoadingSkeleton />;
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
    </div>
  );
}
