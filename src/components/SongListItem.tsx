"use client";

import { memo, useCallback, useMemo } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { Pause, Play } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { OfflineSongDownloadButton } from "@/components/OfflineDownloadButton";
import { TrackActionsButton } from "@/components/TrackActionsMenu";
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
  showQueue?: boolean;
  showDownload?: boolean;
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
  showDownload = true,
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
            networkSrc={resolvedSong.networkImageUrl}
            alt={resolvedSong.title}
            fill
            sizes="48px"
            className="wf-song-cover object-cover"
            priority={priority}
            loading={priority ? "eager" : "lazy"}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", isActive && "text-emerald-500")}>
            {resolvedSong.title}
          </span>
          <span className="block truncate text-xs opacity-70">{resolvedSong.artist}</span>
        </span>
      </button>

      {showDownload ? (
        <OfflineSongDownloadButton song={song} className="wf-control-button text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10" />
      ) : null}

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
    prevProps.showDownload === nextProps.showDownload &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});
