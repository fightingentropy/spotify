import { useCallback, useMemo } from "react";
import { Pause, Play } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { useApiData, withAccountScope, type HomePayload, type StatsHomePayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { warmPlaybackSong } from "@/client/playback-warm";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";
import { usePlayerStore } from "@/store/player";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";

type HomeSong = PlayerSong & {
  album?: string | null;
  duration?: number | null;
  durationMs?: number | null;
};

export default function HomePage() {
  const { user, status } = useAuth();
  const { loading, error } = useApiData<HomePayload>(
    withAccountScope("/api/home", user?.id ?? status),
    {
      songs: [],
      likedSongIds: [],
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  const { data: statsData } = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", user?.id ?? status),
    {
      recentlyPlayed: [],
      mostPlayed: [],
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );

  const setQueue = usePlayerStore((state) => state.setQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  // Subscribe to a stable signature of only the downloaded record ids rather
  // than the whole records map. resolveOfflinePlaybackSong only swaps in
  // records whose status is "downloaded", so per-tick progress updates on an
  // active download no longer churn this value. The signature changes only
  // when a download completes/is removed.
  const offlineRecordsSignature = useOfflineStore((state) => {
    const ids: string[] = [];
    for (const id of Object.keys(state.records)) {
      if (state.records[id]?.status === "downloaded") ids.push(id);
    }
    return ids.sort().join("|");
  });

  const resolveHomeSong = useCallback(
    (song: HomeSong): HomeSong => resolveOfflinePlaybackSong(song) as HomeSong,
    [offlineRecordsSignature],
  );

  const warmSongSoon = useCallback((song: HomeSong) => {
    warmPlaybackSong(song, true);
  }, []);

  const recentlyPlayedSongs = statsData.recentlyPlayed as HomeSong[];
  const mostPlayedSongs = useMemo(
    () => statsData.mostPlayed.map((entry) => entry.song as HomeSong),
    [statsData.mostPlayed],
  );

  const handlePlayScrollerSong = (songs: HomeSong[], index: number) => {
    const song = songs[index];
    if (!song) return;
    if (song.id === currentSongId) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(song);
        play();
      }
      return;
    }
    requestImmediatePlayback(song);
    setQueue(songs, index);
  };

  const renderScrollerTile = (songs: HomeSong[], index: number, subtitle?: string) => {
    const song = songs[index];
    if (!song) return null;
    const displaySong = resolveHomeSong(song);
    const active = currentSongId === song.id;

    return (
      <div
        key={song.id}
        onPointerEnter={() => warmSongSoon(displaySong)}
        onFocus={() => warmSongSoon(displaySong)}
        // The whole card plays on tap: the floating play button only appears
        // on hover, which touch devices never see. It stopPropagation()s, so
        // pointer users don't double-toggle.
        onClick={() => handlePlayScrollerSong(songs, index)}
        className={cn(
          "wf-song-card group w-36 shrink-0 cursor-pointer rounded-md p-3 transition touch-manipulation sm:w-40",
          active ? "bg-white/[0.12]" : "hover:bg-white/[0.09]",
        )}
      >
        <div className="relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]">
          <CoverImage
            src={displaySong.imageUrl}
            networkSrc={displaySong.networkImageUrl}
            alt={displaySong.title}
            fill
            sizes="160px"
            className="wf-song-cover object-cover"
            loading={index < 6 ? "eager" : "lazy"}
          />
          <button
            type="button"
            aria-label={active && isPlaying ? `Pause ${displaySong.title}` : `Play ${displaySong.title}`}
            onClick={(event) => {
              event.stopPropagation();
              handlePlayScrollerSong(songs, index);
            }}
            className={cn(
              "absolute bottom-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-[#1ed760] text-black shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212]",
              "wf-control-button",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            {active && isPlaying ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>
        </div>
        <div className="mt-3 min-w-0">
          <div className={cn("truncate text-[16px] font-medium leading-6 text-white", active && "text-[#1ed760]")}>
            {displaySong.title}
          </div>
          <div className="truncate text-[14px] leading-5 text-white/[0.62]">{displaySong.artist || "Unknown Artist"}</div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[13px] text-white/[0.46]">{subtitle}</div>
          ) : null}
        </div>
      </div>
    );
  };

  if (loading || status === "loading") {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-12">
        <div className="opacity-70">Loading library...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-12">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] overflow-x-hidden bg-background text-white">
      <div className="relative px-4 pb-10 pt-12 sm:px-6 md:pt-16 lg:px-6 xl:px-8 2xl:px-10">
        {recentlyPlayedSongs.length > 0 ? (
          <section aria-label="Recently played" className="mb-9 md:mb-10">
            <h2 className="mb-4 text-2xl font-bold">Recently played</h2>
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
              {recentlyPlayedSongs.map((_, index) => renderScrollerTile(recentlyPlayedSongs, index))}
            </div>
          </section>
        ) : null}

        {statsData.mostPlayed.length > 0 ? (
          <section aria-label="Most played" className="mb-9 md:mb-10">
            <h2 className="mb-4 text-2xl font-bold">Most played</h2>
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
              {statsData.mostPlayed.map((entry, index) =>
                renderScrollerTile(
                  mostPlayedSongs,
                  index,
                  entry.playCount > 0
                    ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}`
                    : undefined,
                ),
              )}
            </div>
          </section>
        ) : null}

        <div className="h-8 lg:h-20" />
      </div>
    </div>
  );
}
