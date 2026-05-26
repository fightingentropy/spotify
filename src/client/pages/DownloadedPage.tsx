import { useEffect, useMemo } from "react";
import { Download } from "lucide-react";
import { useApiData, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { useOfflineStore } from "@/client/offline";
import { SongGrid } from "@/components/SongGrid";

export default function DownloadedPage() {
  const { user } = useAuth();
  const hydrate = useOfflineStore((state) => state.hydrate);
  const hydrated = useOfflineStore((state) => state.hydrated);
  const records = useOfflineStore((state) => state.records);
  const { data } = useApiData<LikedPayload>(user ? "/api/liked" : "/api/likes", {
    songs: [],
    likedSongIds: [],
  });

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const downloadedSongs = useMemo(() => {
    return Object.values(records)
      .filter((record) => record.status === "downloaded")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((record) => record.song);
  }, [records]);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
            <Download size={23} />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Downloads</h1>
            <div className="mt-1 text-sm text-white/[0.62]">
              {downloadedSongs.length} {downloadedSongs.length === 1 ? "song" : "songs"}
            </div>
          </div>
        </div>

        {!hydrated ? (
          <div className="opacity-70">Loading downloads...</div>
        ) : downloadedSongs.length === 0 ? (
          <div className="opacity-70">Downloaded songs will show up here.</div>
        ) : (
          <SongGrid
            songs={downloadedSongs}
            likedSongIds={data.likedSongIds}
            canLike={!!user}
            emptyLabel="Downloaded songs will show up here."
            viewToggleClassName="mb-8 sm:-mt-14"
          />
        )}
        <div className="h-8 lg:h-24" />
      </div>
    </div>
  );
}
