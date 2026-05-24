"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { normalizeCoverImageUrl } from "@/lib/song-utils";

type MobileSearchProps = {
  songs: PlayerSong[];
};

function normalizeSongPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function MobileSearch({ songs }: MobileSearchProps) {
  const [query, setQuery] = useState("");
  const setQueue = usePlayerStore((state) => state.setQueue);

  const dedupedSongs = useMemo(() => {
    const unique = new Map<string, PlayerSong>();
    for (const song of songs) {
      const key = `${normalizeSongPart(song.title)}::${normalizeSongPart(song.artist)}`;
      const current = unique.get(key);
      if (!current) {
        unique.set(key, song);
        continue;
      }
      const currentTime = Date.parse(current.createdAt || "");
      const nextTime = Date.parse(song.createdAt || "");
      if (nextTime >= currentTime) unique.set(key, song);
    }
    return [...unique.values()];
  }, [songs]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dedupedSongs.slice(0, 30);
    return dedupedSongs
      .filter((song) => {
        const title = song.title.toLowerCase();
        const artist = song.artist.toLowerCase();
        return title.includes(q) || artist.includes(q);
      })
      .slice(0, 50);
  }, [dedupedSongs, query]);

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-5">Search</h1>

      <div className="relative mb-6">
        <Search
          size={18}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-foreground/50 pointer-events-none"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What do you want to play?"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full h-12 pl-11 pr-4 rounded-full border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-base outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
      </div>

      <div className="space-y-1">
        {results.length === 0 ? (
          <div className="py-12 text-center text-sm opacity-70">No songs found</div>
        ) : (
          results.map((song) => (
            <button
              key={song.id}
              type="button"
              onClick={() => {
                const queueIndex = songs.findIndex((item) => item.id === song.id);
                if (queueIndex >= 0) setQueue(songs, queueIndex);
              }}
              className="w-full min-h-[56px] px-2 rounded-xl flex items-center gap-3 text-left active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
            >
              <div className="relative h-12 w-12 rounded-md overflow-hidden shrink-0">
                <img
                  src={normalizeCoverImageUrl(song.imageUrl)}
                  alt={song.title}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{song.title}</div>
                <div className="text-xs opacity-70 truncate">{song.artist}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
