import { Link } from "react-router-dom";
import { useApiData, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";

export default function LikedPage() {
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<LikedPayload>(user ? "/api/liked" : "/api/likes", {
    songs: [],
    likedSongIds: [],
  });

  if (status !== "loading" && !user) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
        <div className="mx-auto max-w-7xl">
          <h1 className="mb-6 text-2xl font-semibold">Liked Songs</h1>
          <div className="opacity-70">
            <Link className="underline" to="/signin">Sign in</Link> to view and manage your liked songs.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex flex-col items-start gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold leading-tight">Liked Songs</h1>
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
            viewToggleClassName="mb-8 sm:-mt-14"
          />
        )}
        <div className="h-8 lg:h-24" />
      </div>
    </div>
  );
}
