"use client";

import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import Image from "next/image";
import { Heart, Pause, Play } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";

type SongListItemProps = {
  song: PlayerSong;
  onPlay?: () => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  priority?: boolean;
};

const SongListItemComponent = function SongListItem({
  song,
  onPlay,
  liked = false,
  likePending = false,
  canLike = false,
  onToggleLike,
  priority = false,
}: SongListItemProps) {
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
    if (onPlay) {
      onPlay();
      return;
    }
    setSong(song);
    play();
  }, [isActive, isPlaying, onPlay, pause, play, setSong, song]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handlePlay();
      }
    },
    [handlePlay],
  );

  const handleToggleLike = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (likePending || !onToggleLike) return;
      await onToggleLike(song.id, !liked);
    },
    [likePending, liked, onToggleLike, song.id],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handlePlay}
      onKeyDown={handleKeyDown}
      aria-pressed={isActiveAndPlaying}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg",
      )}
    >
      <div className="relative h-12 w-12 rounded overflow-hidden shrink-0">
        <Image
          src={song.imageUrl || "/waveform.svg"}
          alt={song.title}
          fill
          sizes="48px"
          className="object-cover"
          priority={priority}
          loading={priority ? "eager" : "lazy"}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{song.title}</div>
        <div className="text-xs opacity-70 truncate">{song.artist}</div>
      </div>

      <button
        type="button"
        aria-label={liked ? "Remove from liked songs" : "Save to liked songs"}
        title={!canLike ? "Sign in to like songs" : liked ? "Remove from liked songs" : "Save to liked songs"}
        disabled={likePending}
        onClick={handleToggleLike}
        className={cn(
          "h-9 w-9 rounded-full grid place-items-center transition",
          canLike ? "hover:bg-black/10 hover:dark:bg-white/10" : "opacity-80",
          likePending && "opacity-60 cursor-wait",
        )}
      >
        <Heart
          size={18}
          className={cn(
            liked ? "fill-emerald-500 text-emerald-500" : "text-foreground/80",
            likePending && "animate-pulse",
          )}
        />
      </button>

      <div className="h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0">
        {isActiveAndPlaying ? <Pause size={17} /> : <Play size={17} className="translate-x-[1px]" />}
      </div>
    </div>
  );
};

export const SongListItem = memo(SongListItemComponent, (prevProps, nextProps) => {
  return (
    prevProps.song.id === nextProps.song.id &&
    prevProps.liked === nextProps.liked &&
    prevProps.likePending === nextProps.likePending &&
    prevProps.canLike === nextProps.canLike &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlay === nextProps.onPlay &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});

export default SongListItem;
