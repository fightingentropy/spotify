import { HomeSearchCommandPalette } from "@/components/HomeSearchCommandPalette";
import { HomeNoServerLibrary } from "@/components/HomeNoServerLibrary";
import { SongGrid } from "@/components/SongGrid";
import { useApiData, type HomePayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export default function HomePage() {
  const { user } = useAuth();
  const localSongs = useBrowserLocalLibraryStore((state) => state.songs);
  const localStatus = useBrowserLocalLibraryStore((state) => state.status);
  const localDirectoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const { data, loading, error } = useApiData<HomePayload>("/api/home", {
    songs: [],
    likedSongIds: [],
  });
  const allSongs = [...data.songs, ...localSongs];

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <HomeSearchCommandPalette songs={allSongs} />
      {loading ? (
        <div className="opacity-70">Loading library...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data.songs.length === 0 && localSongs.length === 0 ? (
        <HomeNoServerLibrary />
      ) : (
        <div className="space-y-8">
          {data.songs.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Server Library</h2>
              </div>
              <SongGrid songs={data.songs} likedSongIds={data.likedSongIds} canLike={!!user} />
            </section>
          )}
          {localStatus === "scanning" ? (
            <div className="opacity-70">
              {localDirectoryName ? `Loading ${localDirectoryName}…` : "Loading your library…"}
            </div>
          ) : localSongs.length > 0 ? (
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold">Local Folder</h2>
              </div>
              <SongGrid songs={localSongs} canLike={false} showLikeControls={false} />
            </section>
          ) : null}
        </div>
      )}
      <div className="h-8 lg:h-24" />
    </div>
  );
}
