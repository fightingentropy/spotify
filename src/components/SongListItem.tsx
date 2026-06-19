"use client";

import { memo, useCallback } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { Pause, Play } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { TrackActionsButton } from "@/components/TrackActionsMenu";

type SongListItemProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showLike?: boolean;
  showQueue?: boolean;
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
  showQueue = true,
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
      else {
        requestImmediatePlayback(song);
        play();
      }
      return;
    }
    if (typeof songIndex === "number" && onPlayAt) {
      requestImmediatePlayback(song);
      onPlayAt(songIndex);
      return;
    }
    requestImmediatePlayback(song);
    setSong(song);
    play();
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, setSong, song, songIndex]);

  return (
    <div
      onPointerEnter={() => warmPlaybackSong(song, true)}
      className={cn(
        "wf-list-row group flex items-center gap-3 px-3 py-2",
        isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg",
      )}
    >
      <button
        type="button"
        aria-label={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        aria-pressed={isActiveAndPlaying}
        onClick={handlePlay}
        onFocus={() => warmPlaybackSong(song, true)}
        className="wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none"
      >
        <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
          <CoverImage
            src={song.imageUrl}
            networkSrc={song.networkImageUrl}
            alt={song.title}
            fill
            sizes="48px"
            className="wf-song-cover object-cover"
            priority={priority}
            loading={priority ? "eager" : "lazy"}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", isActive && "text-emerald-500")}>
            {song.title}
          </span>
          <span className="block truncate text-xs opacity-70">{song.artist}</span>
        </span>
      </button>

      {/* Now-playing affordance — only on the active row so quiet rows stay clean. */}
      {isActive ? (
        <div aria-hidden className="pointer-events-none wf-control-button h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0">
          {isActiveAndPlaying ? <Pause size={17} /> : <Play size={17} className="translate-x-[1px]" />}
        </div>
      ) : null}

      <TrackActionsButton
        song={song}
        liked={liked}
        likePending={likePending}
        canLike={canLike}
        onToggleLike={onToggleLike}
        showLike={showLike}
        showQueue={showQueue}
        className="h-9 w-9 text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10"
      />
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
    prevProps.showQueue === nextProps.showQueue &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});
