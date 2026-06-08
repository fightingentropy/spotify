"use client";

import { memo, useCallback, useMemo, type MouseEvent } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { Heart, Pause, Play } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { OfflineSongDownloadButton } from "@/components/OfflineDownloadButton";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";

type SongListItemProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showLike?: boolean;
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
  priority = false,
}: SongListItemProps) {
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
      return;
    }
    requestImmediatePlayback(resolvedSong);
    setSong(song);
    play();
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, resolvedSong, setSong, song, songIndex]);

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
      onPointerEnter={() => warmPlaybackSong(resolvedSong, true)}
      className={cn(
        "wf-list-row group flex items-center gap-3 px-3 py-2",
        isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg",
      )}
    >
      <button
        type="button"
        aria-label={isActiveAndPlaying ? `Pause ${resolvedSong.title}` : `Play ${resolvedSong.title}`}
        aria-pressed={isActiveAndPlaying}
        onClick={handlePlay}
        onFocus={() => warmPlaybackSong(resolvedSong, true)}
        className="wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none"
      >
        <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
          <CoverImage
            src={resolvedSong.imageUrl}
            alt={resolvedSong.title}
            fill
            sizes="48px"
            className="wf-song-cover object-cover"
            priority={priority}
            loading={priority ? "eager" : "lazy"}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{resolvedSong.title}</span>
          <span className="block truncate text-xs opacity-70">{resolvedSong.artist}</span>
        </span>
      </button>

      <OfflineSongDownloadButton song={song} className="wf-control-button text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10" />

      {showLike ? (
        <button
          type="button"
          aria-label={liked ? "In liked songs" : "Save to liked songs"}
          title={!canLike ? "Sign in to like songs" : liked ? "In liked songs" : "Save to liked songs"}
          disabled={likePending}
          onClick={handleToggleLike}
          className={cn(
            "h-9 w-9 rounded-full grid place-items-center transition",
            "wf-control-button",
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

      <div aria-hidden className="pointer-events-none wf-control-button h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0">
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
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});

export default SongListItem;
