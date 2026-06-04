"use client";

import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { Heart, Pause, Pencil, Play } from "lucide-react";
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
  editMode?: boolean;
  onEdit?: (song: PlayerSong) => void;
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
  editMode = false,
  onEdit,
  priority = false,
}: SongCardProps) {
  // Optimized selector - only subscribes to necessary state changes
  const setSong = usePlayerStore((state) => state.setSong);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
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

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handlePlay();
      }
    },
    [handlePlay]
  );

  const handleToggleLike = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (likePending || !onToggleLike) return;
      await onToggleLike(song.id, !liked);
    },
    [likePending, liked, onToggleLike, song.id]
  );

  if (hideIfUnliked && !liked) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handlePlay}
      onPointerEnter={() => warmPlaybackSong(resolvedSong, true)}
      onFocus={() => warmPlaybackSong(resolvedSong, true)}
      onKeyDown={handleKeyDown}
      aria-pressed={isActiveAndPlaying}
      className={cn(
        "wf-song-card wf-pressable group relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        isActive && "ring-2 ring-emerald-500"
      )}
    >
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
        className="wf-control-button absolute left-2 top-2 bg-black/40 text-white/90 backdrop-blur hover:bg-black/60"
      />

      {showLike ? (
        <button
          type="button"
          aria-label={liked ? "In liked songs" : "Save to liked songs"}
          title={!canLike ? "Sign in to like songs" : liked ? "In liked songs" : "Save to liked songs"}
          disabled={likePending}
          onClick={handleToggleLike}
          className={cn(
            "absolute top-2 right-2 h-9 w-9 rounded-full grid place-items-center transition text-white/90 bg-black/40 backdrop-blur",
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

      {editMode && onEdit ? (
        <button
          type="button"
          aria-label="Edit song"
          title="Edit song"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(song);
          }}
          className="wf-control-button absolute left-2 top-12 h-9 w-9 rounded-full grid place-items-center transition text-white/90 bg-black/40 backdrop-blur hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <Pencil size={16} />
        </button>
      ) : null}

      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2">
        <div className="text-left min-w-0 flex-1">
          <div className="text-white font-medium drop-shadow truncate">{resolvedSong.title}</div>
          <div className="text-white/80 text-xs drop-shadow truncate">{resolvedSong.artist}</div>
          {editMode ? (
            <div className="text-white/80 text-[11px] drop-shadow truncate">
              {song.audioBitDepth && song.audioSampleRate
                ? `${song.audioBitDepth}-bit/${Math.round(song.audioSampleRate / 100) / 10}kHz`
                : "Quality: Unknown"}
            </div>
          ) : null}
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
    prevProps.editMode === nextProps.editMode &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike &&
    prevProps.onEdit === nextProps.onEdit
  );
});
