import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useApiData, withAccountScope, type LikedPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import {
  mergeOfflineDownloadRecords,
  readDownloadedRecordsPage,
  resolveOfflineDownloadRecordSong,
  useOfflineStore,
  type OfflineDownloadRecord,
} from "@/client/offline";
import { SongGrid } from "@/components/SongGrid";

const DOWNLOADS_PAGE_SIZE = 80;

function DownloadSkeletonRows() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex min-h-[64px] items-center gap-4 rounded-xl px-3">
          <div className="wf-skeleton h-14 w-14 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-48 max-w-full rounded-full" />
            <div className="wf-skeleton h-3 w-28 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DownloadedPage() {
  const { user, status } = useAuth();
  const hydrate = useOfflineStore((state) => state.hydrate);
  const hydrated = useOfflineStore((state) => state.hydrated);
  const [downloadRecords, setDownloadRecords] = useState<OfflineDownloadRecord[]>([]);
  const [totalDownloads, setTotalDownloads] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const recordsRef = useRef<OfflineDownloadRecord[]>([]);
  const { data } = useApiData<LikedPayload>(
    withAccountScope(user ? "/api/liked" : "/api/likes", user?.id ?? status),
    {
      songs: [],
      likedSongIds: [],
    },
  );

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const loadDownloads = useCallback(async (reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(null);
    if (reset) {
      setLoadingInitial(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const offset = reset ? 0 : recordsRef.current.length;
      const page = await readDownloadedRecordsPage({
        offset,
        limit: DOWNLOADS_PAGE_SIZE,
      });
      mergeOfflineDownloadRecords(page.records);
      setTotalDownloads(page.total);
      setDownloadRecords((current) => {
        const nextRecords = reset ? page.records : [...current, ...page.records];
        const seen = new Set<string>();
        const deduped = nextRecords.filter((record) => {
          if (seen.has(record.songId)) return false;
          seen.add(record.songId);
          return true;
        });
        recordsRef.current = deduped;
        return deduped;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load downloaded songs");
    } finally {
      loadingRef.current = false;
      setLoadingInitial(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    recordsRef.current = [];
    setDownloadRecords([]);
    setTotalDownloads(0);
    void loadDownloads(true);
  }, [hydrated, loadDownloads, user?.id, status]);

  useEffect(() => {
    if (!hydrated) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (recordsRef.current.length >= totalDownloads) return;
        void loadDownloads(false);
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hydrated, loadDownloads, totalDownloads]);

  const downloadedSongs = useMemo(() => {
    return downloadRecords.map((record) => resolveOfflineDownloadRecordSong(record));
  }, [downloadRecords]);

  const hasMore = downloadedSongs.length < totalDownloads;

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
              {totalDownloads} {totalDownloads === 1 ? "song" : "songs"}
            </div>
          </div>
        </div>

        {!hydrated || loadingInitial ? (
          <DownloadSkeletonRows />
        ) : downloadedSongs.length === 0 ? (
          <div className="opacity-70">
            {loadError ?? "Downloaded songs will show up here."}
          </div>
        ) : (
          <>
            <SongGrid
              songs={downloadedSongs}
              likedSongIds={data.likedSongIds}
              canLike={!!user}
              emptyLabel="Downloaded songs will show up here."
              viewToggleClassName="mb-8 sm:-mt-14"
            />
            <div ref={sentinelRef} className="flex min-h-16 items-center justify-center py-6 text-sm text-white/[0.62]">
              {loadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Loading more
                </span>
              ) : hasMore ? (
                <button
                  type="button"
                  onClick={() => void loadDownloads(false)}
                  className="rounded-full border border-white/15 px-4 py-2 font-medium text-white/[0.78] transition hover:bg-white/[0.08] hover:text-white"
                >
                  Load more
                </button>
              ) : loadError ? (
                loadError
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
