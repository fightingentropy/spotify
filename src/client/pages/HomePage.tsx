import { HomeSearchCommandPalette } from "@/components/HomeSearchCommandPalette";
import { HomeNoServerLibrary } from "@/components/HomeNoServerLibrary";
import { SongGrid } from "@/components/SongGrid";
import { useApiData, type HomePayload } from "@/client/api";
import { useAuth } from "@/client/auth";

export default function HomePage() {
  const { user } = useAuth();
  const { data, loading, error } = useApiData<HomePayload>("/api/home", {
    songs: [],
    likedSongIds: [],
  });

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <HomeSearchCommandPalette songs={data.songs} />
      {loading ? (
        <div className="opacity-70">Loading library...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data.songs.length === 0 ? (
        <HomeNoServerLibrary />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Server Library</h2>
          </div>
          <SongGrid songs={data.songs} likedSongIds={data.likedSongIds} canLike={!!user} />
        </>
      )}
      <div className="h-8 lg:h-24" />
    </div>
  );
}
