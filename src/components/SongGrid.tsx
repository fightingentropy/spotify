"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutGrid, Rows3 } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { SongCard } from "@/components/SongCard";
import { SongListItem } from "@/components/SongListItem";

type SongGridProps = {
  songs: PlayerSong[];
  likedSongIds?: string[];
  hideIfUnliked?: boolean;
  canLike?: boolean;
  emptyLabel?: string;
  viewToggleClassName?: string;
};

export function SongGrid({
  songs,
  likedSongIds = [],
  hideIfUnliked = false,
  canLike = false,
  emptyLabel,
  viewToggleClassName,
}: SongGridProps) {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const router = useRouter();
  const setQueue = usePlayerStore((state) => state.setQueue);
  const mergeInitial = useLikesStore((state) => state.mergeInitial);
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const hydrated = useLikesStore((state) => state.hydrated);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("wf_song_view_mode");
      if (stored === "list" || stored === "grid") {
        setViewMode(stored);
      }
    } catch {}
  }, []);

  const setNextViewMode = useCallback((nextMode: "grid" | "list") => {
    setViewMode(nextMode);
    try {
      localStorage.setItem("wf_song_view_mode", nextMode);
    } catch {}
  }, []);

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
    <div>
      <div className={cn("mb-3 flex items-center justify-end", viewToggleClassName)}>
        <div className="inline-flex items-center rounded-lg border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-1">
          <button
            type="button"
            onClick={() => setNextViewMode("grid")}
            className={cn(
              "h-8 px-3 rounded-md inline-flex items-center gap-2 text-sm transition",
              viewMode === "grid" && "bg-black/10 dark:bg-white/10 font-medium",
            )}
            aria-pressed={viewMode === "grid"}
            title="Grid view"
          >
            <LayoutGrid size={16} />
            <span className="hidden sm:inline">Grid</span>
          </button>
          <button
            type="button"
            onClick={() => setNextViewMode("list")}
            className={cn(
              "h-8 px-3 rounded-md inline-flex items-center gap-2 text-sm transition",
              viewMode === "list" && "bg-black/10 dark:bg-white/10 font-medium",
            )}
            aria-pressed={viewMode === "list"}
            title="List view"
          >
            <Rows3 size={16} />
            <span className="hidden sm:inline">List</span>
          </button>
        </div>
      </div>

      {viewMode === "grid" ? (
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
      ) : (
        <div className="space-y-2">
          {visibleSongs.map((song, index) => (
            <SongListItem
              key={song.id}
              song={song}
              onPlay={() => onPlayAt(index)}
              liked={!!likedMap[song.id]}
              likePending={!!pendingLookup[song.id]}
              canLike={canLike}
              onToggleLike={handleToggleLike}
              priority={index < 6}
            />
          ))}
        </div>
      )}
    </div>
  );
}
