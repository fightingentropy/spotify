import { useCallback, useEffect, useMemo } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Music2, Pause, Play } from "lucide-react";
import { AuthButtons } from "@/components/AuthButtons";
import { CoverImage } from "@/components/CoverImage";
import { HomeRow } from "@/components/HomeRow";
import { PageHeader, PageLayout } from "@/components/PageLayout";
import { PageError } from "@/components/PageError";
import {
  useApiData,
  withAccountScope,
  type DiscoverPlaylistsPayload,
  type HomePayload,
  type StatsHomePayload,
} from "@/client/api";
import { useAuth } from "@/client/auth";
import { warmPlaybackSong } from "@/client/playback-warm";
import { prepareHistorySongForPlayback } from "@/client/discover-queue";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";
import "./home.css";

type HomeSong = PlayerSong & {
  album?: string | null;
  duration?: number | null;
  durationMs?: number | null;
};

function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function HomeLoadingRow({ compact = false }: { compact?: boolean }) {
  return (
    <div className="home-row" aria-hidden="true">
      <div className="home-row-heading">
        <div>
          <div className="wf-skeleton h-[26px] w-40 rounded-md" />
        </div>
      </div>
      <div className="home-rail">
        {Array.from({ length: compact ? 4 : 7 }, (_, index) => (
          compact ? (
            <div key={index} className="home-recent-card pointer-events-none">
              <div className="wf-skeleton h-[68px] w-[68px] shrink-0 rounded" />
              <div className="flex-1 space-y-2">
                <div className="wf-skeleton h-3.5 w-3/4 rounded" />
                <div className="wf-skeleton h-3 w-1/2 rounded" />
              </div>
            </div>
          ) : (
            <div key={index} className="home-art-card pointer-events-none">
              <div className="wf-skeleton aspect-square rounded" />
              <div className="h-13 pt-3">
                <div className="wf-skeleton h-3.5 w-4/5 rounded" />
                <div className="wf-skeleton mt-1.5 h-3.5 w-3/5 rounded" />
              </div>
              <div className="wf-skeleton mt-1.5 h-3 w-3/5 rounded" />
              <div className="wf-skeleton mt-2.5 mb-1 h-2.5 w-2/5 rounded" />
            </div>
          )
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const { user, status } = useAuth();
  const { data: homeData, loading, error, retry } = useApiData<HomePayload>(
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
  // Hydrate the likes store from Home. Home no longer renders a SongGrid (which
  // used to do this), so without this the like buttons stay disabled until the
  // user opens a page that lists songs — including the heart for Discover tracks.
  const mergeInitialLikes = useLikesStore((state) => state.mergeInitial);
  useEffect(() => {
    if (!loading && !error) mergeInitialLikes(homeData.likedSongIds);
  }, [mergeInitialLikes, homeData.likedSongIds, loading, error]);
  const {
    data: statsData,
    loading: statsLoading,
    error: statsError,
    retry: retryStats,
  } = useApiData<StatsHomePayload>(
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
  // The Discover row: auto-updating PLAYLIST cards (Top 50 + the YouTube Music
  // Discover Mix), not individual tracks — same as the iOS app. Each card opens
  // its playlist detail page. Scoped by account: the mix card is only returned
  // for signed-in callers.
  const {
    data: discoverData,
    loading: discoverLoading,
    error: discoverError,
    retry: retryDiscover,
  } = useApiData<DiscoverPlaylistsPayload>(
    withAccountScope("/api/discover/playlists", user?.id ?? status),
    { playlists: [] },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  const discoverPlaylists = discoverData.playlists;

  const setQueue = usePlayerStore((state) => state.setQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  const warmSongSoon = useCallback((song: HomeSong) => {
    warmPlaybackSong(song, true);
  }, []);

  const recentlyPlayedSongs = useMemo(
    () => statsData.recentlyPlayed.map(prepareHistorySongForPlayback) as HomeSong[],
    [statsData.recentlyPlayed],
  );
  const mostPlayedSongs = useMemo(
    () => statsData.mostPlayed.map((entry) => prepareHistorySongForPlayback(entry.song) as HomeSong),
    [statsData.mostPlayed],
  );

  const handlePlayScrollerSong = (songs: HomeSong[], index: number) => {
    const song = songs[index];
    if (!song) return;
    if (song.id === currentSongId) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(usePlayerStore.getState().currentSong ?? song);
        play();
      }
      return;
    }
    requestImmediatePlayback(song);
    setQueue(songs, index);
  };

  const renderScrollerTile = (songs: HomeSong[], index: number, compact = false, subtitle?: string) => {
    const song = songs[index];
    if (!song) return null;
    const active = currentSongId === song.id;

    const playing = active && isPlaying;
    return (
      <button
        key={song.id}
        type="button"
        aria-label={`${playing ? "Pause" : "Play"} ${song.title}${song.artist ? ` by ${song.artist}` : ""}`}
        aria-pressed={playing}
        onPointerEnter={() => warmSongSoon(song)}
        onFocus={() => warmSongSoon(song)}
        onClick={() => handlePlayScrollerSong(songs, index)}
        className={cn(
          "group touch-manipulation text-left",
          compact ? "home-recent-card" : "home-art-card",
          active && "home-card-active",
        )}
      >
        <div
          className={cn(
            "home-card-art",
            compact ? "home-recent-art" : "aspect-square",
          )}
        >
          <CoverImage
            src={song.imageUrl}
            networkSrc={song.networkImageUrl}
            alt=""
            fill
            sizes={compact ? "68px" : "(min-width: 1440px) 172px, (min-width: 640px) 160px, 148px"}
            className="object-cover"
            loading={compact && index < 2 ? "eager" : "lazy"}
          />
          <span
            aria-hidden
            className={cn(
              "home-play-control",
              compact && "home-play-control-compact",
              active && "home-play-control-active",
            )}
          >
            {playing ? (
              <Pause size={compact ? 17 : 19} fill="currentColor" />
            ) : (
              <Play size={compact ? 17 : 19} fill="currentColor" className="translate-x-px" />
            )}
          </span>
        </div>
        <div className={cn("home-track-details", !compact && "pt-3")}>
          <div className="home-card-title">
            {song.title}
          </div>
          <div className="home-card-artist">
            {song.artist || "Unknown Artist"}
          </div>
          {subtitle ? (
            <div className="home-card-note">{subtitle}</div>
          ) : null}
        </div>
      </button>
    );
  };

  const renderDiscoverPlaylistTile = (playlist: DiscoverPlaylistsPayload["playlists"][number]) => (
    <Link
      key={playlist.id}
      to={`/playlist/${playlist.id}`}
      className="home-art-card group touch-manipulation"
    >
      <div className="home-card-art aspect-square">
        <CoverImage
          src={playlist.imageUrl || undefined}
          alt=""
          fill
          sizes="(min-width: 1440px) 172px, (min-width: 640px) 160px, 148px"
          className="object-cover"
          loading="lazy"
        />
        <span className="home-play-control" aria-hidden="true"><ArrowUpRight size={21} /></span>
      </div>
      <div className="home-track-details pt-3">
        <div className="home-card-title">
          {playlist.name}
        </div>
        <div className="home-card-artist">
          {playlist.songsCount > 0 ? `Playlist • ${playlist.songsCount} songs` : "Playlist"}
        </div>
      </div>
    </Link>
  );

  const historyPending = status === "loading" || statsLoading;
  const discoverPending = status === "loading" || discoverLoading;
  const hasHistory = recentlyPlayedSongs.length > 0 || mostPlayedSongs.length > 0;

  return (
    <PageLayout className="home-page">
        <PageHeader
          title="Listen now"
          description={user?.name?.trim()
            ? `${greetingForNow()}, ${user.name.trim().split(/\s+/)[0]}`
            : greetingForNow()}
          actions={<div className="lg:hidden"><AuthButtons compact /></div>}
        />

        {historyPending && !hasHistory ? <p role="status" className="sr-only">Loading your listening history…</p> : null}

        {recentlyPlayedSongs.length > 0 ? (
          <HomeRow title="Continue listening">
            {recentlyPlayedSongs.map((_, index) => renderScrollerTile(recentlyPlayedSongs, index, true))}
          </HomeRow>
        ) : historyPending ? <HomeLoadingRow compact /> : null}

        {statsData.mostPlayed.length > 0 ? (
          <HomeRow title="Most played">
            {statsData.mostPlayed.map((entry, index) =>
              renderScrollerTile(
                mostPlayedSongs,
                index,
                false,
                entry.playCount > 0
                  ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}`
                  : undefined,
              ),
            )}
          </HomeRow>
        ) : historyPending ? <HomeLoadingRow /> : null}

        {statsError ? <div className="mb-6"><PageError compact message={statsError} onRetry={retryStats} retryLabel="Retry listening history" /></div> : null}

        {discoverPlaylists.length > 0 ? (
          <HomeRow title="Discover">
            {discoverPlaylists.map((playlist) => renderDiscoverPlaylistTile(playlist))}
          </HomeRow>
        ) : discoverPending && !historyPending ? <HomeLoadingRow /> : null}

        {discoverError ? <div className="mb-6"><PageError compact message={discoverError} onRetry={retryDiscover} retryLabel="Retry Discover" /></div> : null}

        {error ? <div className="mb-6"><PageError compact message={error} onRetry={retry} retryLabel="Retry library sync" /></div> : null}

        {!historyPending && !discoverPending && !statsError && !discoverError && !hasHistory && discoverPlaylists.length === 0 ? (
          <div className="wf-empty-state">
            <div className="mb-4 flex justify-center"><Music2 size={24} /></div>
            <h2 className="wf-section-title">No listening history yet</h2>
            <p className="mx-auto mt-2 max-w-sm">Songs you play will appear here.</p>
            <Link to="/songs" className="wf-button mt-5">Open library <ArrowUpRight size={16} /></Link>
          </div>
        ) : null}
    </PageLayout>
  );
}
