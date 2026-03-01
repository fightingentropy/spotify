"use client";

import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import Image from "next/image";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { Heart, Pause, Pencil, Play } from "lucide-react";

type SongCardProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  hideIfUnliked?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
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
  editMode = false,
  onEdit,
  priority = false,
}: SongCardProps) {
  // Optimized selector - only subscribes to necessary state changes
  const setSong = usePlayerStore((state) => state.setSong);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  const isActive = currentSongId === song.id;
  const isActiveAndPlaying = isActive && isPlaying;

  const handlePlay = useCallback(() => {
    if (isActive) {
      if (isPlaying) pause();
      else play();
      return;
    }
    if (typeof songIndex === "number" && onPlayAt) {
      onPlayAt(songIndex);
    } else {
      setSong(song);
      play();
    }
  }, [isActive, isPlaying, onPlayAt, pause, play, setSong, song, songIndex]);

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
      onKeyDown={handleKeyDown}
      aria-pressed={isActiveAndPlaying}
      className={cn(
        "group relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        isActive && "ring-2 ring-emerald-500"
      )}
    >
      <Image
        src={song.imageUrl || "/waveform.svg"}
        alt={song.title}
        fill
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 33vw, 200px"
        className="object-cover"
        priority={priority}
        loading={priority ? "eager" : "lazy"}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />

      <button
        type="button"
        aria-label={liked ? "Remove from liked songs" : "Save to liked songs"}
        title={!canLike ? "Sign in to like songs" : liked ? "Remove from liked songs" : "Save to liked songs"}
        disabled={likePending}
        onClick={handleToggleLike}
        className={cn(
          "absolute top-2 right-2 h-9 w-9 rounded-full grid place-items-center transition text-white/90 bg-black/40 backdrop-blur",
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

      {editMode && onEdit ? (
        <button
          type="button"
          aria-label="Edit song"
          title="Edit song"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(song);
          }}
          className="absolute top-2 left-2 h-9 w-9 rounded-full grid place-items-center transition text-white/90 bg-black/40 backdrop-blur hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <Pencil size={16} />
        </button>
      ) : null}

      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2">
        <div className="text-left min-w-0 flex-1">
          <div className="text-white font-medium drop-shadow truncate">{song.title}</div>
          <div className="text-white/80 text-xs drop-shadow truncate">{song.artist}</div>
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
          <div className="h-10 w-10 rounded-full bg-emerald-500 text-white grid place-items-center">
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
    prevProps.editMode === nextProps.editMode &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike &&
    prevProps.onEdit === nextProps.onEdit
  );
});
