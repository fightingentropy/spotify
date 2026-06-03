import { Link } from "react-router-dom";
import { useEffect } from "react";
import { useApiData, withAccountScope, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";

export default function LikedPage() {
  const { user, status, refresh } = useAuth();
  const authSettled = status !== "loading";
  const { data, loading, error } = useApiData<LikedPayload>(
    withAccountScope(user ? "/api/liked" : "/api/likes", user?.id ?? status),
    {
      songs: [],
      likedSongIds: [],
    },
    {
      enabled: authSettled,
      keepPreviousData: true,
    },
  );
  const isAuthError = error === "Unauthorized" || error === "Request failed with 401";
  const songs = Array.isArray(data.songs) ? data.songs : [];
  const legacyLikes = (data as unknown as { likes?: unknown }).likes;
  const likedSongIds = Array.isArray(data.likedSongIds)
    ? data.likedSongIds
    : Array.isArray(legacyLikes)
      ? legacyLikes.filter((id): id is string => typeof id === "string")
      : [];

  useEffect(() => {
    if (isAuthError) void refresh();
  }, [isAuthError, refresh]);

  if (!authSettled) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
        <div className="mx-auto max-w-7xl">
          <h1 className="mb-6 text-2xl font-semibold">Liked Songs</h1>
          <div className="opacity-70">Loading liked songs...</div>
        </div>
      </div>
    );
  }

  if (!user || isAuthError) {
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
        {loading && songs.length > 0 ? (
          <div className="opacity-70">Loading liked songs...</div>
        ) : error ? (
          <div className="text-red-500">{error}</div>
        ) : songs.length === 0 ? (
          <div className="opacity-70">You haven&apos;t liked any songs yet.</div>
        ) : (
          <SongGrid
            songs={songs}
            likedSongIds={likedSongIds}
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
