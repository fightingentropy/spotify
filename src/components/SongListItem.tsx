"use client";

import { memo, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { GripVertical, Heart, Pause, Pencil, Play } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { OfflineSongDownloadButton } from "@/components/OfflineDownloadButton";

type SongListItemProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showLike?: boolean;
  editMode?: boolean;
  canReorder?: boolean;
  onEdit?: (song: PlayerSong) => void;
  priority?: boolean;
};

const SongListItemComponent = function SongListItem({
  song,
  songIndex,
  onPlayAt,
  liked = false,
  likePending = false,
  canLike = false,
  onToggleLike,
  showLike = true,
  editMode = false,
  canReorder = false,
  onEdit,
  priority = false,
}: SongListItemProps) {
  const setSong = usePlayerStore((state) => state.setSong);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const isActive = usePlayerStore(useCallback((state) => state.currentSong?.id === song.id, [song.id]));
  const isActiveAndPlaying = usePlayerStore(
    useCallback((state) => state.currentSong?.id === song.id && state.isPlaying, [song.id]),
  );

  const handlePlay = useCallback(() => {
    if (isActive) {
      if (isActiveAndPlaying) pause();
      else play();
      return;
    }
    if (typeof songIndex === "number" && onPlayAt) {
      onPlayAt(songIndex);
      return;
    }
    setSong(song);
    play();
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, setSong, song, songIndex]);

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
      onPointerEnter={() => warmPlaybackSong(song, true)}
      onFocus={() => warmPlaybackSong(song, true)}
      onKeyDown={handleKeyDown}
      aria-pressed={isActiveAndPlaying}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
        isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg",
      )}
    >
      <div className="relative h-12 w-12 rounded overflow-hidden shrink-0">
        {canReorder ? (
          <div
            aria-hidden
            className="absolute -left-6 top-1/2 -translate-y-1/2 text-foreground/45"
            title="Drag to reorder"
          >
            <GripVertical size={15} />
          </div>
        ) : null}
        <CoverImage
          src={song.imageUrl}
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
        {editMode ? (
          <div className="text-[11px] opacity-60 truncate">
            {song.audioBitDepth && song.audioSampleRate
              ? `${song.audioBitDepth}-bit/${Math.round(song.audioSampleRate / 100) / 10}kHz`
              : "Quality: Unknown"}
          </div>
        ) : null}
      </div>

      <OfflineSongDownloadButton song={song} className="text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10" />

      {editMode && onEdit ? (
        <button
          type="button"
          aria-label="Edit song"
          title="Edit song"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(song);
          }}
          className="h-9 w-9 rounded-full grid place-items-center transition hover:bg-black/10 hover:dark:bg-white/10"
        >
          <Pencil size={17} />
        </button>
      ) : null}

      {showLike ? (
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
      ) : null}

      <div className="h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0">
        {isActiveAndPlaying ? <Pause size={17} /> : <Play size={17} className="translate-x-[1px]" />}
      </div>
    </div>
  );
};

export const SongListItem = memo(SongListItemComponent, (prevProps, nextProps) => {
  return (
    prevProps.song === nextProps.song &&
    prevProps.songIndex === nextProps.songIndex &&
    prevProps.liked === nextProps.liked &&
    prevProps.likePending === nextProps.likePending &&
    prevProps.canLike === nextProps.canLike &&
    prevProps.showLike === nextProps.showLike &&
    prevProps.editMode === nextProps.editMode &&
    prevProps.canReorder === nextProps.canReorder &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike &&
    prevProps.onEdit === nextProps.onEdit
  );
});

export default SongListItem;
