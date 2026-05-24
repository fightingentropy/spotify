import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useApiData, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { SongGrid } from "@/components/SongGrid";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";
import { useLikesStore } from "@/store/likes";

export default function LikedPage() {
  const { user, status } = useAuth();
  const localSongs = useBrowserLocalLibraryStore((state) => state.songs);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const { data, loading, error } = useApiData<LikedPayload>(user ? "/api/liked" : "/api/likes", {
    songs: [],
    likedSongIds: [],
  });
  const localLikedSongs = useMemo(
    () => localSongs.filter((song) => !!likedLookup[song.id]),
    [likedLookup, localSongs],
  );
  const likedSongIds = useMemo(
    () => Array.from(new Set([...data.likedSongIds, ...localLikedSongs.map((song) => song.id)])),
    [data.likedSongIds, localLikedSongs],
  );
  const songs = useMemo(
    () => [...data.songs, ...localLikedSongs.filter((song) => !data.songs.some((item) => item.id === song.id))],
    [data.songs, localLikedSongs],
  );

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
      <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
      {loading ? (
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
          viewToggleClassName="-mt-14 mb-8"
        />
      )}
      <div className="h-8 lg:h-24" />
    </div>
  );
}
