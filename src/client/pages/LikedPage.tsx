import { Link } from "react-router-dom";
import { useApiData, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";
import { OfflineBulkDownloadButton } from "@/components/OfflineDownloadButton";

export default function LikedPage() {
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<LikedPayload>(user ? "/api/liked" : "/api/likes", {
    songs: [],
    likedSongIds: [],
  });

  if (status !== "loading" && !user) {
    return (
      <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
        <div className="opacity-70">
          <Link className="underline" to="/signin">Sign in</Link> to view and manage your liked songs.
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Liked Songs</h1>
        {data.songs.length > 0 ? (
          <OfflineBulkDownloadButton songs={data.songs} scope="liked" label="Download liked" />
        ) : null}
      </div>
      {loading ? (
        <div className="opacity-70">Loading liked songs...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data.songs.length === 0 ? (
        <div className="opacity-70">You haven&apos;t liked any songs yet.</div>
      ) : (
        <SongGrid
          songs={data.songs}
          likedSongIds={data.likedSongIds}
          hideIfUnliked
          canLike
          emptyLabel="You haven't liked any songs yet."
          viewToggleClassName="-mt-14 mb-8"
        />
      )}
      <div className="h-8 lg:h-24" />
    </div>
  );
}
