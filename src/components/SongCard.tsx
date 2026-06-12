"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { Check, Heart, ListPlus, Pause, Play } from "lucide-react";
import { OfflineSongDownloadButton } from "@/components/OfflineDownloadButton";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";

type SongCardProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  hideIfUnliked?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showLike?: boolean;
  priority?: boolean;
};

const SongCardComponent = function SongCard({
  song,
  songIndex,
  onPlayAt,
  liked = false,
  likePending = false,
  canLike = false,
  hideIfUnliked = false,
  onToggleLike,
  showLike = true,
  priority = false,
}: SongCardProps) {
  // Optimized selector - only subscribes to necessary state changes
  const setSong = usePlayerStore((state) => state.setSong);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const [queued, setQueued] = useState(false);
  const queuedTimeoutRef = useRef<number | null>(null);
  const offlineRecord = useOfflineStore(useCallback((state) => state.records[song.id], [song.id]));
  const isActive = usePlayerStore(useCallback((state) => state.currentSong?.id === song.id, [song.id]));
  const isActiveAndPlaying = usePlayerStore(
    useCallback((state) => state.currentSong?.id === song.id && state.isPlaying, [song.id]),
  );
  const resolvedSong = useMemo(() => resolveOfflinePlaybackSong(song), [offlineRecord, song]);

  const handlePlay = useCallback(() => {
    if (isActive) {
      if (isActiveAndPlaying) pause();
      else {
        requestImmediatePlayback(resolvedSong);
        play();
      }
      return;
    }
    if (typeof songIndex === "number" && onPlayAt) {
      requestImmediatePlayback(resolvedSong);
      onPlayAt(songIndex);
    } else {
      requestImmediatePlayback(resolvedSong);
      setSong(song);
      play();
    }
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, resolvedSong, setSong, song, songIndex]);

  const handleToggleLike = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (likePending || !onToggleLike) return;
      await onToggleLike(song.id, !liked);
    },
    [likePending, liked, onToggleLike, song.id]
  );

  useEffect(() => {
    return () => {
      if (queuedTimeoutRef.current != null) window.clearTimeout(queuedTimeoutRef.current);
    };
  }, []);

  const handleAddToQueue = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      addToQueue(song);
      setQueued(true);
      if (queuedTimeoutRef.current != null) window.clearTimeout(queuedTimeoutRef.current);
      queuedTimeoutRef.current = window.setTimeout(() => {
        queuedTimeoutRef.current = null;
        setQueued(false);
      }, 1500);
    },
    [addToQueue, song],
  );

  if (hideIfUnliked && !liked) return null;

  return (
    <div
      onPointerEnter={() => warmPlaybackSong(resolvedSong, true)}
      className={cn(
        "wf-song-card wf-pressable group relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5",
        isActive && "ring-2 ring-emerald-500"
      )}
    >
      <button
        type="button"
        aria-label={isActiveAndPlaying ? `Pause ${resolvedSong.title}` : `Play ${resolvedSong.title}`}
        aria-pressed={isActiveAndPlaying}
        onClick={handlePlay}
        onFocus={() => warmPlaybackSong(resolvedSong, true)}
        className="absolute inset-0 z-10 rounded-lg cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      />
      <CoverImage
        src={resolvedSong.imageUrl}
        alt={resolvedSong.title}
        fill
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 33vw, 200px"
        className="wf-song-cover object-cover"
        priority={priority}
        loading={priority ? "eager" : "lazy"}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />

      <OfflineSongDownloadButton
        song={song}
        className="wf-control-button absolute left-2 top-2 z-30 bg-black/40 text-white/90 backdrop-blur hover:bg-black/60"
      />

      <button
        type="button"
        aria-label="Add to queue"
        title="Add to queue"
        onClick={handleAddToQueue}
        className={cn(
          "absolute top-12 right-2 z-30 h-9 w-9 rounded-full grid place-items-center transition bg-black/40 backdrop-blur",
          "wf-control-button",
          "hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
          queued ? "text-emerald-500" : "text-white/90",
        )}
      >
        {queued ? <Check size={18} /> : <ListPlus size={18} />}
      </button>

      {showLike ? (
        <button
          type="button"
          aria-label={liked ? "In liked songs" : "Save to liked songs"}
          title={!canLike ? "Sign in to like songs" : liked ? "In liked songs" : "Save to liked songs"}
          disabled={likePending}
          onClick={handleToggleLike}
          className={cn(
            "absolute top-2 right-2 z-30 h-9 w-9 rounded-full grid place-items-center transition text-white/90 bg-black/40 backdrop-blur",
            "wf-control-button",
            canLike ? "hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" : "opacity-80",
            likePending && "opacity-60 cursor-wait"
          )}
        >
          <Heart
            size={18}
            className={cn(
              "transition-colors",
              liked ? "fill-emerald-500 text-emerald-500" : "text-white",
              likePending && "animate-pulse"
            )}
          />
        </button>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex items-end justify-between gap-2">
        <div className="text-left min-w-0 flex-1">
          <div className="text-white font-medium drop-shadow truncate">{resolvedSong.title}</div>
          <div className="text-white/80 text-xs drop-shadow truncate">{resolvedSong.artist}</div>
        </div>
        <div
          className={cn(
            "transition-opacity shrink-0",
            isActive
              ? "opacity-100"
              : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          )}
        >
          <div className="wf-control-button h-10 w-10 rounded-full bg-emerald-500 text-white grid place-items-center">
            {isActiveAndPlaying ? <Pause size={18} /> : <Play size={18} />}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoize to prevent re-renders when parent re-renders
export const SongCard = memo(SongCardComponent, (prevProps, nextProps) => {
  // Custom comparison for optimal re-render prevention
  return (
    prevProps.song === nextProps.song &&
    prevProps.songIndex === nextProps.songIndex &&
    prevProps.liked === nextProps.liked &&
    prevProps.likePending === nextProps.likePending &&
    prevProps.canLike === nextProps.canLike &&
    prevProps.hideIfUnliked === nextProps.hideIfUnliked &&
    prevProps.showLike === nextProps.showLike &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});
