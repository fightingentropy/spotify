"use client";

import { memo, useCallback } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { Pause, Play } from "lucide-react";
import { TrackActionsButton } from "@/components/TrackActionsMenu";

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
  showQueue?: boolean;
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
  showQueue = true,
  priority = false,
}: SongCardProps) {
  // Optimized selector - only subscribes to necessary state changes
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
    } else {
      requestImmediatePlayback(song);
      setSong(song);
      play();
    }
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, setSong, song, songIndex]);

  if (hideIfUnliked && !liked) return null;

  return (
    <div
      onPointerEnter={() => warmPlaybackSong(song, true)}
      className="wf-song-card group relative min-w-0"
    >
      <button
        type="button"
        aria-label={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        aria-pressed={isActiveAndPlaying}
        onClick={handlePlay}
        onFocus={() => warmPlaybackSong(song, true)}
        className="wf-pressable block w-full cursor-pointer rounded-[10px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <span className={cn(
          "relative block aspect-square overflow-hidden rounded-[10px] bg-[#0c0c0d]",
          isActive && "ring-1 ring-inset ring-white/40",
        )}>
          <CoverImage
            src={song.imageUrl}
            networkSrc={song.networkImageUrl}
            alt=""
            fill
            sizes="(max-width: 640px) 44vw, (max-width: 1024px) 25vw, 220px"
            className="wf-song-cover object-cover"
            priority={priority}
            loading={priority ? "eager" : "lazy"}
          />
          <span aria-hidden className={cn(
            "absolute bottom-2 right-2 grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur transition-opacity",
            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}>
            {isActiveAndPlaying
              ? <Pause size={19} fill="currentColor" />
              : <Play size={19} fill="currentColor" className="translate-x-px" />}
          </span>
        </span>
        <span className="block h-[72px] min-w-0 pt-2.5">
          <span title={song.title} className={cn("line-clamp-2 text-[14px] leading-5 text-[#f2f2f2]", isActive ? "font-semibold" : "font-medium")}>
            {song.title}
          </span>
          <span title={song.artist} className="mt-0.5 block truncate text-[13px] leading-5 text-white/55">
            {song.artist || "Unknown Artist"}
          </span>
        </span>
      </button>
      <TrackActionsButton
        song={song}
        liked={liked}
        likePending={likePending}
        canLike={canLike}
        onToggleLike={onToggleLike}
        showLike={showLike}
        showQueue={showQueue}
        className="absolute right-2 top-2 z-30 h-9 w-9 text-white/90 bg-black/50 backdrop-blur hover:bg-black/70 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
      />
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
    prevProps.showQueue === nextProps.showQueue &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});
