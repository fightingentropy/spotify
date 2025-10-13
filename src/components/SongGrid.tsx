"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { SongCard } from "@/components/SongCard";

type SongGridProps = {
  songs: PlayerSong[];
  likedSongIds?: string[];
  hideIfUnliked?: boolean;
  canLike?: boolean;
  emptyLabel?: string;
};

export function SongGrid({
  songs,
  likedSongIds = [],
  hideIfUnliked = false,
  canLike = false,
  emptyLabel,
}: SongGridProps) {
  const router = useRouter();
  const setQueue = usePlayerStore((state) => state.setQueue);
  const mergeInitial = useLikesStore((state) => state.mergeInitial);
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const hydrated = useLikesStore((state) => state.hydrated);

  // Only hydrate likes once on mount, not on every prop change
  const likedSongIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const idsString = JSON.stringify(likedSongIds.slice().sort());
    const refString = JSON.stringify(likedSongIdsRef.current.slice().sort());
    if (idsString !== refString) {
      likedSongIdsRef.current = likedSongIds;
      mergeInitial(likedSongIds);
    }
  }, [mergeInitial, likedSongIds]);

  const initialLookup = useMemo(() => {
    const map: Record<string, true> = {};
    for (const id of likedSongIds) {
      if (typeof id === "string" && id.length > 0) {
        map[id] = true;
      }
    }
    return map;
  }, [likedSongIds]);

  const likedMap = hydrated ? likedLookup : initialLookup;
  const visibleSongs = useMemo(
    () => (hideIfUnliked ? songs.filter((song) => !!likedMap[song.id]) : songs),
    [hideIfUnliked, likedMap, songs]
  );

  const onPlayAt = useCallback((index: number) => {
    setQueue(visibleSongs, index);
  }, [setQueue, visibleSongs]);

  const handleToggleLike = useCallback(async (songId: string, nextLiked: boolean) => {
    if (!canLike) {
      router.push("/signin");
      return;
    }
    const result = await toggleLike(songId, nextLiked);
    if (!result.ok && result.status === 401) {
      router.push("/signin");
    }
  }, [canLike, router, toggleLike]);

  if (visibleSongs.length === 0) {
    if (hideIfUnliked && emptyLabel) {
      return <div className="opacity-70">{emptyLabel}</div>;
    }
    return null;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {visibleSongs.map((song, index) => (
        <SongCard
          key={song.id}
          song={song}
          onPlay={() => onPlayAt(index)}
          liked={!!likedMap[song.id]}
          likePending={!!pendingLookup[song.id]}
          canLike={canLike}
          onToggleLike={handleToggleLike}
          hideIfUnliked={hideIfUnliked}
          priority={index < 6}
        />
      ))}
    </div>
  );
}

