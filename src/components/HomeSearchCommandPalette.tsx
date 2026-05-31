"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { warmPlaybackSong } from "@/client/playback-warm";
import { useApiData, type SearchIndexPayload } from "@/client/api";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { normalizeCoverImageUrl } from "@/lib/song-utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn } from "@/lib/utils";

type HomeSearchCommandPaletteProps = {
  className?: string;
};

function normalizeSongPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function HomeSearchCommandPalette({ className }: HomeSearchCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setQueue = usePlayerStore((state) => state.setQueue);
  const { data, loading, error } = useApiData<SearchIndexPayload>(
    "/api/search-index",
    { songs: [] },
    { enabled: open },
  );
  const songs = data.songs;

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
      const a = Number.isFinite(currentTime) ? currentTime : 0;
      const b = Number.isFinite(nextTime) ? nextTime : 0;
      if (b >= a) {
        unique.set(key, song);
      }
    }
    return [...unique.values()];
  }, [songs]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return dedupedSongs
      .filter((song) => {
        const title = song.title.toLowerCase();
        const artist = song.artist.toLowerCase();
        return title.includes(q) || artist.includes(q);
      })
      .slice(0, 20);
  }, [dedupedSongs, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = results[activeIndex];
        if (!selected) return;
        const queueIndex = songs.findIndex((song) => song.id === selected.id);
        if (queueIndex >= 0) {
          requestImmediatePlayback(selected);
          setQueue(songs, queueIndex);
          setOpen(false);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, open, results, setQueue, songs]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <div className={className}>
      <button
        type="button"
        aria-label="Search songs, Command K"
        aria-keyshortcuts="Meta+K Control+K"
        title="Search (Command K)"
        onClick={() => setOpen(true)}
        className="group flex h-12 w-full min-w-0 items-center gap-3 rounded-full bg-[#1f1f1f] pl-4 pr-3 text-left text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition hover:bg-[#2a2a2a] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      >
        <Search size={25} strokeWidth={2.15} className="shrink-0 text-white/70 transition group-hover:text-white" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-white/[0.64]">
          What do you want to play?
        </span>
        <kbd className="hidden h-6 shrink-0 items-center rounded-md border border-white/[0.16] px-2 text-[11px] font-semibold leading-none text-white/[0.56] xl:inline-flex">
          ⌘ K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] bg-black/70 p-4 backdrop-blur-sm sm:p-8" onClick={() => setOpen(false)}>
          <div
            className="mx-auto mt-10 max-w-2xl overflow-hidden rounded-3xl border border-white/15 bg-zinc-950/95 shadow-2xl sm:mt-16"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-14 items-center gap-3 border-b border-white/10 px-4">
              <Search size={18} className="text-foreground/60" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="What do you want to play?"
                className="w-full bg-transparent text-base outline-none placeholder:text-foreground/50"
              />
              <kbd className="rounded-md border border-white/20 px-2 py-1 text-[10px] text-foreground/60">
                ESC
              </kbd>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2">
              {loading ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  Loading songs...
                </div>
              ) : error ? (
                <div className="px-3 py-10 text-center text-sm text-red-300">
                  {error}
                </div>
              ) : query.trim().length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  Start typing to search songs
                </div>
              ) : results.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-foreground/65">
                  No songs found
                </div>
              ) : (
                results.map((song, index) => (
                  <button
                    key={song.id}
                    type="button"
                    onPointerEnter={() => warmPlaybackSong(song, true)}
                    onFocus={() => warmPlaybackSong(song, true)}
                    onClick={() => {
                      const queueIndex = songs.findIndex((item) => item.id === song.id);
                      if (queueIndex >= 0) {
                        requestImmediatePlayback(song);
                        setQueue(songs, queueIndex);
                        setOpen(false);
                      }
                    }}
                    className={cn(
                      "flex h-14 w-full items-center gap-3 rounded-xl px-3 text-left transition",
                      index === activeIndex ? "bg-white/10" : "hover:bg-white/5",
                    )}
                  >
                    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md">
                      <img
                        src={normalizeCoverImageUrl(song.imageUrl)}
                        alt={song.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{song.title}</div>
                      <div className="truncate text-xs text-foreground/65">{song.artist}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default HomeSearchCommandPalette;
