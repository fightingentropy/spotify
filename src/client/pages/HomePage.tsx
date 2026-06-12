import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Clock3,
  LayoutGrid,
  List,
  ListPlus,
  Pause,
  Play,
  Shuffle,
} from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { useApiData, withAccountScope, type HomePayload, type StatsHomePayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { warmPlaybackSong } from "@/client/playback-warm";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { resolveNativeApiUrl } from "@/lib/song-utils";
import { cn, formatTime } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";

const OfflineBulkDownloadButton = lazy(() =>
  import("@/components/OfflineDownloadButton").then((module) => ({
    default: module.OfflineBulkDownloadButton,
  })),
);
const OfflineSongDownloadButton = lazy(() =>
  import("@/components/OfflineDownloadButton").then((module) => ({
    default: module.OfflineSongDownloadButton,
  })),
);

type HomeSong = PlayerSong & {
  album?: string | null;
  duration?: number | null;
  durationMs?: number | null;
};

type HomeViewMode = "list" | "grid";
type HomeDateSortMode = "date_desc" | "date_asc";

const HOME_VIEW_MODE_KEY = "spotify_home_view_mode";
const HOME_DATE_SORT_KEY = "spotify_home_date_sort";
const HOME_LIST_GRID =
  "md:grid-cols-[3rem_minmax(0,2.1fr)_minmax(0,1.05fr)_minmax(7.75rem,0.78fr)_2.75rem_2.25rem_5rem_2.25rem] xl:grid-cols-[4.25rem_minmax(0,2.4fr)_minmax(0,1.15fr)_minmax(8rem,0.9fr)_3rem_2.5rem_5.25rem_2.5rem]";
const HOME_VIRTUALIZATION_MIN_ITEMS = 100;
const HOME_LIST_ROW_HEIGHT = 88;
const HOME_VIRTUAL_OVERSCAN_ROWS = 8;
const HOME_DURATION_PROBE_LIMIT = 6;

function formatDateAdded(dateStr: string | undefined): string {
  if (!dateStr) return "Unknown";

  const date = new Date(dateStr);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";

  const now = Date.now();
  const diffMs = Math.max(0, now - timestamp);
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "Just now";
  if (diffHours < 1) {
    return `${diffMinutes} ${diffMinutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
  }
  if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function getSongAlbum(song: HomeSong): string {
  const album = typeof song.album === "string" ? song.album.trim() : "";
  return album || song.title;
}

function getSongDurationSeconds(song: HomeSong): number | null {
  const explicitMs =
    typeof song.durationMs === "number" && Number.isFinite(song.durationMs)
      ? song.durationMs
      : null;
  const duration =
    typeof song.duration === "number" && Number.isFinite(song.duration)
      ? song.duration
      : null;
  const seconds =
    explicitMs != null
      ? explicitMs / 1000
      : duration == null
        ? null
        : duration > 1000
          ? duration / 1000
          : duration;

  return seconds == null || seconds <= 0 ? null : seconds;
}

function getSongDuration(song: HomeSong, loadedDuration?: number | null): string {
  const seconds = getSongDurationSeconds(song) ?? loadedDuration ?? null;
  return seconds == null || seconds <= 0 ? "--:--" : formatTime(seconds);
}

function shouldSkipSpeculativeMetadataProbe(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !!(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
}

function SaveToLikedButton({
  liked,
  pending,
  canLike,
  iconSize = 25,
  className,
  onToggle,
}: {
  liked: boolean;
  pending: boolean;
  canLike: boolean;
  iconSize?: number;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={liked ? "In liked songs" : "Save to liked songs"}
      title={!canLike ? "Sign in to like songs" : liked ? "In liked songs" : "Save to liked songs"}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
        pending ? "cursor-wait opacity-60" : "cursor-pointer",
        liked ? "text-[#1ed760]" : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
        className,
        liked && "opacity-100",
      )}
    >
      {liked ? (
        <span
          className="grid place-items-center rounded-full bg-[#1ed760] text-black"
          style={{ width: iconSize, height: iconSize }}
        >
          <Check size={Math.max(12, Math.round(iconSize * 0.62))} strokeWidth={3.2} />
        </span>
      ) : (
        <CheckCircle2 size={iconSize} strokeWidth={2.35} />
      )}
    </button>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { user, status } = useAuth();
  const [viewMode, setViewMode] = useState<HomeViewMode>(() => {
    try {
      const stored = localStorage.getItem(HOME_VIEW_MODE_KEY);
      if (stored === "list" || stored === "grid") return stored;
    } catch {}
    return "list";
  });
  const [dateSortMode, setDateSortMode] = useState<HomeDateSortMode>(() => {
    try {
      const stored = localStorage.getItem(HOME_DATE_SORT_KEY);
      if (stored === "date_desc" || stored === "date_asc") return stored;
    } catch {}
    return "date_desc";
  });
  const [durationLookup, setDurationLookup] = useState<Record<string, number | null>>({});
  const [listVirtualRange, setListVirtualRange] = useState({ start: 0, end: 0 });
  const [queuedFeedbackId, setQueuedFeedbackId] = useState<string | null>(null);
  const queuedFeedbackTimeoutRef = useRef<number | null>(null);
  const durationProbeIdsRef = useRef<Set<string>>(new Set());
  const durationLookupRef = useRef<Record<string, number | null>>({});
  const mergedLikesRef = useRef(false);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const warmVisibleSongsRef = useRef<Map<Element, HomeSong>>(new Map());
  const warmObserverRef = useRef<IntersectionObserver | null>(null);
  const { data, loading, error } = useApiData<HomePayload>(
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
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);

  const mergeInitialLikes = useLikesStore((state) => state.mergeInitial);
  const likedSongLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLikes = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);
  const toggleLike = useLikesStore((state) => state.toggleLike);
  // Subscribe to a stable signature of only the downloaded record ids rather
  // than the whole records map. resolveOfflinePlaybackSong only swaps in
  // records whose status is "downloaded", so per-tick progress updates on an
  // active download no longer churn this value (and the duration-probe effect
  // below). The signature changes only when a download completes/is removed.
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

  useEffect(() => {
    // A transient empty array can arrive mid-refetch (initialValue or a
    // keepPreviousData reset). Merging it would wipe remote likes, so only
    // merge once we have a real payload. An empty list is still merged when
    // the fetch has genuinely settled (loading === false) so an account with
    // zero likes hydrates correctly.
    if (loading) return;
    if (data.likedSongIds.length === 0 && !mergedLikesRef.current) return;
    mergedLikesRef.current = true;
    mergeInitialLikes(data.likedSongIds);
  }, [data.likedSongIds, loading, mergeInitialLikes]);

  useEffect(() => {
    durationLookupRef.current = durationLookup;
  }, [durationLookup]);

  const registerWarmNode = useCallback((node: HTMLDivElement | null, song: HomeSong) => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (!warmObserverRef.current) {
      warmObserverRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const visibleSong = warmVisibleSongsRef.current.get(entry.target);
            if (visibleSong) warmPlaybackSong(visibleSong);
            warmVisibleSongsRef.current.delete(entry.target);
            warmObserverRef.current?.unobserve(entry.target);
          }
        },
        { rootMargin: "160px 0px" },
      );
    }
    warmVisibleSongsRef.current.set(node, song);
    warmObserverRef.current.observe(node);
  }, []);

  useEffect(() => {
    return () => warmObserverRef.current?.disconnect();
  }, []);

  const warmSongSoon = useCallback((song: HomeSong) => {
    warmPlaybackSong(song, true);
  }, []);

  const initialLikedLookup = useMemo(() => {
    const lookup: Record<string, true> = {};
    for (const id of data.likedSongIds) {
      if (id) lookup[id] = true;
    }
    return lookup;
  }, [data.likedSongIds]);

  const likedLookup = likesHydrated ? likedSongLookup : initialLikedLookup;

  const sortedSongs = useMemo(() => {
    return ([...(data.songs as HomeSong[])] as HomeSong[]).sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || "");
      const rightTime = Date.parse(right.createdAt || "");
      const a = Number.isFinite(leftTime) ? leftTime : 0;
      const b = Number.isFinite(rightTime) ? rightTime : 0;
      return dateSortMode === "date_desc" ? b - a : a - b;
    });
  }, [data.songs, dateSortMode]);

  const enableVirtualList =
    viewMode === "list" && sortedSongs.length >= HOME_VIRTUALIZATION_MIN_ITEMS;

  useEffect(() => {
    if (!enableVirtualList) {
      setListVirtualRange({ start: 0, end: sortedSongs.length });
      return;
    }

    let frameId = 0;
    const updateRange = () => {
      frameId = 0;
      const el = listContainerRef.current;
      if (!el) {
        setListVirtualRange({ start: 0, end: Math.min(sortedSongs.length, 40) });
        return;
      }

      const rect = el.getBoundingClientRect();
      const scrollContainer = el.closest(".wf-main") as HTMLElement | null;
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const viewportTop = scrollRect?.top ?? 0;
      const viewportBottom = scrollRect?.bottom ?? window.innerHeight;
      const localViewportTop = Math.max(0, viewportTop - rect.top);
      const localViewportBottom = Math.max(0, viewportBottom - rect.top);
      const nextStart = Math.max(
        0,
        Math.floor(localViewportTop / HOME_LIST_ROW_HEIGHT) - HOME_VIRTUAL_OVERSCAN_ROWS,
      );
      const nextEnd = Math.min(
        sortedSongs.length,
        Math.ceil(localViewportBottom / HOME_LIST_ROW_HEIGHT) + HOME_VIRTUAL_OVERSCAN_ROWS,
      );

      setListVirtualRange((current) =>
        current.start === nextStart && current.end === nextEnd
          ? current
          : { start: nextStart, end: Math.max(nextStart, nextEnd) },
      );
    };

    const scheduleRangeUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateRange);
    };

    const scrollContainer = listContainerRef.current?.closest(".wf-main") as HTMLElement | null;
    updateRange();
    scrollContainer?.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("resize", scheduleRangeUpdate);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      scrollContainer?.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("resize", scheduleRangeUpdate);
    };
  }, [enableVirtualList, sortedSongs.length]);

  useEffect(() => {
    if (isPlaying) return;
    if (shouldSkipSpeculativeMetadataProbe()) return;
    const songsToProbe: HomeSong[] = [];
    const probeCandidates = enableVirtualList
      ? sortedSongs.slice(
          Math.max(0, listVirtualRange.start - HOME_VIRTUAL_OVERSCAN_ROWS),
          Math.max(HOME_DURATION_PROBE_LIMIT, listVirtualRange.end),
        )
      : sortedSongs.slice(0, HOME_DURATION_PROBE_LIMIT);
    for (const song of probeCandidates) {
      const probeSong = resolveHomeSong(song);
      if (!probeSong.audioUrl) continue;
      if (getSongDurationSeconds(probeSong) != null) continue;
      if (durationLookupRef.current[song.id] !== undefined) continue;
      if (durationProbeIdsRef.current.has(song.id)) continue;
      durationProbeIdsRef.current.add(song.id);
      songsToProbe.push(probeSong);
      if (songsToProbe.length >= HOME_DURATION_PROBE_LIMIT) break;
    }
    if (songsToProbe.length === 0) return;

    let cancelled = false;
    const audioElements: HTMLAudioElement[] = [];

    const rememberDuration = (songId: string, value: number | null) => {
      durationLookupRef.current = {
        ...durationLookupRef.current,
        [songId]: value,
      };
      durationProbeIdsRef.current.delete(songId);
      setDurationLookup((current) =>
        current[songId] === undefined ? { ...current, [songId]: value } : current,
      );
    };

    for (const song of songsToProbe) {
      const audio = new Audio();
      audioElements.push(audio);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        if (cancelled) return;
        const duration =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : null;
        rememberDuration(song.id, duration);
      };
      audio.onerror = () => {
        if (cancelled) return;
        rememberDuration(song.id, null);
      };
      audio.src = resolveNativeApiUrl(song.audioUrl);
      audio.load();
    }

    return () => {
      cancelled = true;
      for (const audio of audioElements) {
        audio.removeAttribute("src");
        audio.load();
      }
      // Keep probe markers in the ref across effect re-runs. They're cleared
      // explicitly in rememberDuration on success/failure; dropping them here
      // would re-issue the same Audio() probes every time records change.
    };
  }, [enableVirtualList, isPlaying, listVirtualRange.end, listVirtualRange.start, resolveHomeSong, sortedSongs]);

  const currentSongIsInList = useMemo(() => {
    return currentSongId ? sortedSongs.some((song) => song.id === currentSongId) : false;
  }, [currentSongId, sortedSongs]);
  const listIsPlaying = currentSongIsInList && isPlaying;

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

  const handlePlaySong = (index: number) => {
    const song = sortedSongs[index];
    if (!song) return;
    if (song?.id === currentSongId) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(song);
        play();
      }
      return;
    }
    requestImmediatePlayback(song);
    setQueue(sortedSongs, index);
  };

  const handlePlayAll = () => {
    if (currentSongIsInList) {
      if (isPlaying) pause();
      else {
        requestImmediatePlayback(currentSong);
        play();
      }
      return;
    }
    if (sortedSongs.length > 0) {
      const startedSong = setQueue(sortedSongs, 0, { respectShuffle: true });
      requestImmediatePlayback(startedSong);
    }
  };

  const setNextViewMode = (nextMode: HomeViewMode) => {
    setViewMode(nextMode);
    try {
      localStorage.setItem(HOME_VIEW_MODE_KEY, nextMode);
    } catch {}
  };

  const toggleDateSortMode = () => {
    const nextMode: HomeDateSortMode = dateSortMode === "date_desc" ? "date_asc" : "date_desc";
    setDateSortMode(nextMode);
    try {
      localStorage.setItem(HOME_DATE_SORT_KEY, nextMode);
    } catch {}
  };

  useEffect(() => {
    return () => {
      if (queuedFeedbackTimeoutRef.current != null) window.clearTimeout(queuedFeedbackTimeoutRef.current);
    };
  }, []);

  const handleAddToQueue = (song: HomeSong) => {
    addToQueue(song);
    setQueuedFeedbackId(song.id);
    if (queuedFeedbackTimeoutRef.current != null) window.clearTimeout(queuedFeedbackTimeoutRef.current);
    queuedFeedbackTimeoutRef.current = window.setTimeout(() => {
      queuedFeedbackTimeoutRef.current = null;
      setQueuedFeedbackId(null);
    }, 1500);
  };

  const handleToggleLike = async (songId: string) => {
    if (!user) {
      navigate("/signin");
      return;
    }

    const isLiked = !!likedLookup[songId];
    const result = await toggleLike(songId, !isLiked, sortedSongs.find((song) => song.id === songId));
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
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
        className={cn(
          "wf-song-card group w-36 shrink-0 rounded-md p-3 transition sm:w-40",
          active ? "bg-white/[0.12]" : "hover:bg-white/[0.09]",
        )}
      >
        <div className="relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]">
          <CoverImage
            src={displaySong.imageUrl}
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

  const renderHomeListSong = (song: HomeSong, index: number) => {
    const displaySong = resolveHomeSong(song);
    const active = currentSongId === song.id;
    const liked = !!likedLookup[song.id];
    const likePending = !!pendingLikes[song.id];
    const artists = displaySong.artist || "Unknown Artist";

    return (
      <div
        key={song.id}
        ref={(node) => registerWarmNode(node, displaySong)}
        onPointerEnter={() => warmSongSoon(displaySong)}
        className={cn(
          "wf-list-row group grid min-h-[4.75rem] grid-cols-[2.25rem_minmax(0,1fr)_3.75rem] items-center gap-3 rounded-md px-3 py-2 transition md:-mx-1 md:min-h-[5.5rem] md:px-1 xl:gap-4",
          HOME_LIST_GRID,
          active ? "bg-white/[0.11]" : "hover:bg-white/[0.07]",
        )}
      >
        <button
          type="button"
          aria-label={active && isPlaying ? `Pause ${displaySong.title}` : `Play ${displaySong.title}`}
          aria-pressed={active && isPlaying}
          onClick={() => handlePlaySong(index)}
          onFocus={() => warmSongSoon(displaySong)}
          className="wf-pressable col-span-2 grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 rounded-md bg-transparent text-left focus:outline-none md:grid-cols-[3rem_minmax(0,1fr)] xl:grid-cols-[4.25rem_minmax(0,1fr)] xl:gap-4"
        >
          <span
            className={cn(
              "flex h-11 items-center justify-center text-[18px] tabular-nums text-white/[0.68]",
              active && "text-[#1ed760]",
            )}
          >
            {active && isPlaying ? (
              <Pause size={19} fill="currentColor" />
            ) : (
              <>
                <span className="group-hover:hidden">{index + 1}</span>
                <Play size={18} fill="currentColor" className="hidden translate-x-0.5 text-white group-hover:block" />
              </>
            )}
          </span>

          <span className="flex min-w-0 items-center gap-5">
            <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[5px] bg-white/10">
              <CoverImage
                src={displaySong.imageUrl}
                alt={displaySong.title}
                fill
                sizes="48px"
                className="wf-song-cover object-cover"
                loading={index < 8 ? "eager" : "lazy"}
              />
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block truncate text-[20px] font-medium leading-7 text-white",
                  active && "text-[#1ed760]",
                )}
              >
                {displaySong.title}
              </span>
              <span className="block truncate text-[18px] leading-7 text-white/[0.66]">{artists}</span>
            </span>
          </span>
        </button>

        <div className="hidden min-w-0 items-center text-[18px] text-white/[0.66] md:flex">
          <span className="truncate">{getSongAlbum(displaySong)}</span>
        </div>

        <div className="hidden items-center text-[18px] text-white/[0.66] md:flex">
          {formatDateAdded(song.createdAt)}
        </div>

        <div className="hidden justify-center md:flex">
          <SaveToLikedButton
            liked={liked}
            pending={likePending}
            canLike={!!user}
            className="h-9 w-9 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onToggle={() => void handleToggleLike(song.id)}
          />
        </div>

        <div className="hidden justify-center md:flex">
          <button
            type="button"
            aria-label="Add to queue"
            title="Add to queue"
            onClick={() => handleAddToQueue(song)}
            className={cn(
              "wf-control-button grid h-9 w-9 shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
              queuedFeedbackId === song.id
                ? "text-[#1ed760] opacity-100"
                : "text-white/[0.68] opacity-0 hover:bg-white/[0.09] hover:text-white group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            {queuedFeedbackId === song.id ? <Check size={18} /> : <ListPlus size={18} />}
          </button>
        </div>

        <div className="flex justify-end text-[18px] tabular-nums text-white/[0.66] md:justify-center md:text-center">
          {getSongDuration(displaySong, durationLookup[song.id])}
        </div>

        <div className="hidden justify-end md:flex">
          <Suspense fallback={null}>
            <OfflineSongDownloadButton song={song} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </Suspense>
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
        <section className="mb-9 flex items-center gap-5 md:mb-10 md:gap-8">
          <button
            type="button"
            aria-label={listIsPlaying ? "Pause library" : "Play library"}
            onClick={handlePlayAll}
            disabled={sortedSongs.length === 0}
            className="wf-control-button grid h-16 w-16 shrink-0 cursor-pointer place-items-center rounded-full bg-[#1ed760] text-black shadow-[0_12px_28px_rgba(0,0,0,0.35)] transition hover:bg-[#1fdf64] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#1ed760]"
          >
            {listIsPlaying ? (
              <Pause size={31} fill="currentColor" />
            ) : (
              <Play size={31} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>

          <button
            type="button"
            aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
            title={shuffle ? "Disable shuffle" : "Enable shuffle"}
            onClick={toggleShuffle}
            className={cn(
              "relative grid h-11 w-11 cursor-pointer place-items-center rounded-full text-white/70 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:h-12 sm:w-12",
              "wf-control-button",
              shuffle && "text-[#1ed760]",
            )}
          >
            <Shuffle size={30} className="sm:h-[34px] sm:w-[34px]" />
            <span
              className={cn(
                "absolute bottom-0.5 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity",
                shuffle ? "opacity-100" : "opacity-0",
              )}
            />
          </button>

          <Suspense fallback={null}>
          <OfflineBulkDownloadButton songs={sortedSongs} scope="home" iconOnly className="wf-control-button text-white/70 hover:text-white sm:h-12 sm:w-12" />
          </Suspense>

          <div className="ml-auto flex items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.04] p-1 text-white/[0.68]">
            <button
              type="button"
              aria-label="Grid view"
              title="Grid view"
              onClick={() => setNextViewMode("grid")}
              className={cn(
                "grid h-9 w-9 place-items-center rounded-full transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                "wf-control-button",
                viewMode === "grid" ? "bg-white/[0.14] text-white" : "hover:bg-white/[0.09]",
              )}
            >
              <LayoutGrid size={22} />
            </button>
            <button
              type="button"
              aria-label="List view"
              title="List view"
              onClick={() => setNextViewMode("list")}
              className={cn(
                "grid h-9 w-9 place-items-center rounded-full transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                "wf-control-button",
                viewMode === "list" ? "bg-white/[0.14] text-white" : "hover:bg-white/[0.09]",
              )}
            >
              <List size={23} />
            </button>
          </div>
        </section>

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

        <section aria-label="Library tracks" className="w-full">
          {viewMode === "list" ? (
            <div className={cn("hidden items-center gap-3 border-b border-white/[0.12] px-1 pb-4 text-[16px] font-medium text-white/[0.66] md:grid xl:gap-4", HOME_LIST_GRID)}>
              <div className="text-center">#</div>
              <div>Title</div>
              <div>Album</div>
              <button
                type="button"
                aria-label={
                  dateSortMode === "date_desc"
                    ? "Sort by date added oldest first"
                    : "Sort by date added newest first"
                }
                title={
                  dateSortMode === "date_desc"
                    ? "Sort by date added oldest first"
                    : "Sort by date added newest first"
                }
                onClick={toggleDateSortMode}
                className="wf-control-button inline-flex w-fit items-center gap-1.5 rounded-md bg-transparent text-left transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
              >
                <span>Date added</span>
                {dateSortMode === "date_desc" ? (
                  <ArrowDown size={15} strokeWidth={2.5} />
                ) : (
                  <ArrowUp size={15} strokeWidth={2.5} />
                )}
              </button>
              <div />
              <div />
              <div className="flex justify-center">
                <Clock3 size={23} />
              </div>
              <div />
            </div>
          ) : null}

          <div className="pt-3">
            {sortedSongs.length === 0 ? (
              <div
                className={cn(
                  "grid min-h-[5rem] grid-cols-1 items-center rounded-md py-5 text-[17px] text-white/[0.68]",
                  viewMode === "list" &&
                    cn("md:gap-3 xl:gap-4", HOME_LIST_GRID),
                )}
              >
                <div className="hidden md:block" />
                <div className={cn("min-w-0 max-w-[18rem] whitespace-normal leading-7 text-wrap md:max-w-none", viewMode === "list" && "md:col-span-7")}>
                  <span>No songs in your library yet.</span>{" "}
                  <Link to="/upload" className="underline underline-offset-2 hover:text-white">
                    Add music
                  </Link>
                  .
                </div>
              </div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
                {sortedSongs.map((song, index) => {
                  const displaySong = resolveHomeSong(song);
                  const active = currentSongId === song.id;
                  const liked = !!likedLookup[song.id];
                  const likePending = !!pendingLikes[song.id];

                  return (
                    <div
                      key={song.id}
                      ref={(node) => registerWarmNode(node, displaySong)}
                      style={{
                        contentVisibility: "auto",
                        containIntrinsicSize: "18rem",
                      }}
                      onPointerEnter={() => warmSongSoon(displaySong)}
                      onFocus={() => warmSongSoon(displaySong)}
                      className={cn(
                        "wf-song-card group rounded-md p-3 transition",
                        active ? "bg-white/[0.12]" : "hover:bg-white/[0.09]",
                      )}
                    >
                      <div className="relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]">
                        <CoverImage
                          src={displaySong.imageUrl}
                          alt={displaySong.title}
                          fill
                          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 180px"
                          className="wf-song-cover object-cover"
                          loading={index < 8 ? "eager" : "lazy"}
                        />
                        <Suspense fallback={null}>
                          <OfflineSongDownloadButton
                            song={song}
                            className="wf-control-button absolute left-3 top-3 bg-black/40 text-white/90 opacity-100 backdrop-blur hover:bg-black/60 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                          />
                        </Suspense>
                        <button
                          type="button"
                          aria-label={active && isPlaying ? `Pause ${displaySong.title}` : `Play ${displaySong.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handlePlaySong(index);
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
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="min-w-0 truncate text-[13px] text-white/[0.46]">{formatDateAdded(song.createdAt)}</div>
                        <SaveToLikedButton
                          liked={liked}
                          pending={likePending}
                          canLike={!!user}
                          iconSize={20}
                          className="h-8 w-8 text-white/[0.46]"
                          onToggle={() => void handleToggleLike(song.id)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : enableVirtualList ? (
              <div
                ref={listContainerRef}
                className="relative"
                style={{ height: `${sortedSongs.length * HOME_LIST_ROW_HEIGHT}px` }}
              >
                {sortedSongs.slice(listVirtualRange.start, listVirtualRange.end).map((song, offset) => {
                  const index = listVirtualRange.start + offset;
                  return (
                    <div
                      key={song.id}
                      className="absolute left-0 right-0"
                      style={{ top: `${index * HOME_LIST_ROW_HEIGHT}px` }}
                    >
                      {renderHomeListSong(song, index)}
                    </div>
                  );
                })}
              </div>
            ) : (
              sortedSongs.map(renderHomeListSong)
            )}
          </div>
        </section>

        <div className="h-8 lg:h-20" />
      </div>
    </div>
  );
}
