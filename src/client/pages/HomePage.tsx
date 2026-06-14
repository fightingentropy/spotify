import { useCallback, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import {
  useApiData,
  withAccountScope,
  type DiscoverPayload,
  type DiscoverTrack,
  type HomePayload,
  type StatsHomePayload,
} from "@/client/api";
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
  // Globally trending tracks (Spotify Top 50). Not account-scoped — it's the same
  // worldwide chart for everyone.
  const { data: discoverData } = useApiData<DiscoverPayload>(
    "/api/discover/trending",
    { tracks: [] },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );

  const setQueue = usePlayerStore((state) => state.setQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id ?? null);
  const currentDiscoverTrackId = usePlayerStore((state) => state.currentSong?.discoverTrackId ?? null);
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

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Tapping a Discover tile plays it WITHOUT adding it to the library. If it's
  // already staged in the .discover cache it plays instantly; otherwise it's
  // materialized on demand (a short wait, like a download). Keeping it forever
  // (like / add-to-playlist / download) promotes it — handled by those actions.
  const handleDiscoverClick = useCallback(
    async (track: DiscoverTrack) => {
      // Instant path: already pre-downloaded — play straight from staging.
      if (track.staged && track.audioUrl && track.audioId) {
        const song = resolveHomeSong({
          id: track.audioId,
          title: track.title,
          artist: track.artist,
          album: track.album || undefined,
          imageUrl: track.imageUrl,
          audioUrl: track.audioUrl,
          duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
          source: "server",
          staged: true,
          discoverTrackId: track.id,
        } as HomeSong);
        requestImmediatePlayback(song);
        setQueue([song], 0);
        return;
      }

      // Not staged yet: materialize this one track on demand, then play it.
      if (importingId) return;
      setImportingId(track.id);
      setImportError(null);
      try {
        const res = await fetch("/api/discover/stage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            spotifyUrl: track.spotifyUrl,
            region: "US",
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationMs: track.durationMs ?? undefined,
            imageUrl: track.imageUrl,
            qualityProfile: "max",
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Couldn't load this track (${res.status})`);
        }
        const song = resolveHomeSong((await res.json()) as HomeSong);
        requestImmediatePlayback(song);
        setQueue([song], 0);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Couldn't load this track");
      } finally {
        setImportingId(null);
      }
    },
    [importingId, resolveHomeSong, setQueue],
  );

  const renderDiscoverTile = (track: DiscoverTrack) => {
    const importing = importingId === track.id;
    const active = currentDiscoverTrackId != null && currentDiscoverTrackId === track.id;
    const activePlaying = active && isPlaying;
    // Tapping the active tile toggles play/pause; tapping another tile plays it.
    const onTap = () => {
      if (active) {
        if (isPlaying) pause();
        else play();
        return;
      }
      void handleDiscoverClick(track);
    };
    return (
      <div
        key={track.id}
        onClick={onTap}
        className={cn(
          "wf-song-card group w-36 shrink-0 cursor-pointer rounded-md p-3 transition touch-manipulation sm:w-40",
          active || importing ? "bg-white/[0.12]" : "hover:bg-white/[0.09]",
        )}
      >
        <div className="relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]">
          <CoverImage
            src={track.imageUrl}
            alt={track.title}
            fill
            sizes="160px"
            className="wf-song-cover object-cover"
            loading="lazy"
          />
          {importing ? (
            <div className="absolute inset-0 grid place-items-center bg-black/55">
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-white/25 border-t-white" />
            </div>
          ) : null}
          <button
            type="button"
            aria-label={activePlaying ? `Pause ${track.title}` : `Play ${track.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onTap();
            }}
            disabled={importing}
            className={cn(
              "absolute bottom-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-[#1ed760] text-black shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212] wf-control-button",
              active || importing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            {importing ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-black/30 border-t-black" />
            ) : activePlaying ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>
        </div>
        <div className="mt-3 min-w-0">
          <div className={cn("truncate text-[16px] font-medium leading-6 text-white", active && "text-[#1ed760]")}>
            {track.title}
          </div>
          <div className="truncate text-[14px] leading-5 text-white/[0.62]">{track.artist || "Unknown Artist"}</div>
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
        {discoverData.tracks.length > 0 ? (
          <section aria-label="Discover" className="mb-9 md:mb-10">
            <h2 className="mb-4 text-2xl font-bold">Discover</h2>
            {importError ? (
              <div role="alert" className="mb-3 text-sm text-red-400">
                {importError}
              </div>
            ) : null}
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
              {discoverData.tracks.map((track) => renderDiscoverTile(track))}
            </div>
          </section>
        ) : null}

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
