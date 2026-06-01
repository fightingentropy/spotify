"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import {
  CheckCircle2,
  ChevronDown,
  FileText,
  Heart,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { isRadioSong } from "@/lib/player-song";
import { cn, formatTime } from "@/lib/utils";
import { CoverImage } from "@/components/CoverImage";
import { OfflineSongDownloadButton } from "@/components/OfflineDownloadButton";

type NowPlayingSheetProps = {
  open: boolean;
  onClose: () => void;
  song: PlayerSong;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onSeek: (value: number) => void;
};

type LyricsState = {
  status: "idle" | "loading" | "ready" | "error";
  text: string;
};

function parseCredits(artist: string): Array<{ name: string; role: string }> {
  const seen = new Set<string>();
  const names = artist
    .split(/,|&| feat\.? | ft\.? /i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (names.length === 0) {
    return [{ name: artist || "Unknown Artist", role: "Main Artist" }];
  }

  return names.map((name, index) => ({
    name,
    role: index === 0 ? "Main Artist, Vocalist" : "Featured Artist",
  }));
}

export default function NowPlayingSheet({
  open,
  onClose,
  song,
  isPlaying,
  currentTime,
  duration,
  onSeek,
}: NowPlayingSheetProps) {
  const navigate = useNavigate();
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);

  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);

  const liveStream = isRadioSong(song);
  const songIsLiked = !!likedLookup[song.id];
  const likePending = !!pendingLookup[song.id];

  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsState, setLyricsState] = useState<LyricsState>({
    status: "idle",
    text: "",
  });
  const loadedLyricsKeyRef = useRef<string | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  const credits = useMemo(() => parseCredits(song.artist), [song.artist]);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  useEffect(() => {
    if (!open || !showLyrics) return;

    if (!song.lyricsUrl) {
      setLyricsState({ status: "idle", text: "" });
      loadedLyricsKeyRef.current = null;
      return;
    }
    const lyricsKey = `${song.id}:${song.lyricsUrl}`;
    if (loadedLyricsKeyRef.current === lyricsKey) {
      return;
    }

    let cancelled = false;

    async function loadLyrics() {
      setLyricsState({ status: "loading", text: "" });
      try {
        const response = await fetch(song.lyricsUrl as string);
        if (!response.ok) {
          throw new Error("Lyrics unavailable");
        }
        const text = (await response.text()).trim();
        if (cancelled) return;
        setLyricsState({ status: "ready", text });
        loadedLyricsKeyRef.current = lyricsKey;
      } catch {
        if (cancelled) return;
        setLyricsState({ status: "error", text: "" });
        loadedLyricsKeyRef.current = null;
      }
    }

    loadLyrics();

    return () => {
      cancelled = true;
    };
  }, [open, showLyrics, song.id, song.lyricsUrl]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("wf-now-playing-open");
    return () => {
      document.body.classList.remove("wf-now-playing-open");
    };
  }, [open]);

  async function handleToggleLike() {
    if (liveStream || !likesHydrated || likePending) return;
    const result = await toggleLike(song.id, !songIsLiked, song);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY;
    touchStartYRef.current = null;
    if (startY == null || endY == null) return;
    if (endY - startY > 80) {
      onClose();
    }
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 transition",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity lg:block",
          open ? "opacity-100" : "opacity-0",
          "hidden lg:block",
        )}
        onClick={onClose}
        aria-label="Close now playing view"
      />

      <section
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          "absolute overflow-hidden transition duration-300 ease-out bg-background",
          "inset-0 lg:inset-auto lg:left-0 lg:right-0 lg:top-14 lg:bottom-[84px] lg:mx-auto lg:max-w-3xl lg:border lg:border-black/10 lg:dark:border-white/10 lg:bg-background/95 lg:backdrop-blur-lg lg:rounded-t-2xl",
          open
            ? "translate-y-0 opacity-100"
            : "translate-y-full opacity-0 lg:translate-y-8 lg:opacity-0",
        )}
      >
        <div className="h-full overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[calc(var(--wf-mobile-nav-height)+var(--wf-mobile-player-height)+env(safe-area-inset-bottom)+1rem)] lg:pt-0 lg:pb-0">
          <div className="p-4 sm:p-6 min-h-full flex flex-col">
            <div className="flex items-center justify-between mb-4 lg:mb-4">
              <button
                type="button"
                onClick={onClose}
                className="h-11 w-11 -ml-1 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation"
                aria-label="Collapse now playing"
              >
                <ChevronDown size={24} />
              </button>
              <div className="text-xs uppercase tracking-wide opacity-70">Now Playing</div>
              <div className="-mr-1 flex items-center gap-1">
                {!liveStream ? (
                  <>
                    <OfflineSongDownloadButton song={song} className="h-11 w-11 text-foreground/70 active:bg-black/10 dark:active:bg-white/10" />
                    <button
                      type="button"
                      aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
                      onClick={handleToggleLike}
                      disabled={!likesHydrated || likePending}
                      className={cn(
                        "h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                        likePending ? "opacity-60" : "active:bg-black/10 dark:active:bg-white/10",
                        songIsLiked ? "text-emerald-500" : "text-foreground/70",
                      )}
                    >
                      <Heart size={22} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex-1 flex flex-col justify-center gap-6 lg:gap-5 max-w-md mx-auto w-full">
              <div className="mx-auto w-full shadow-2xl shadow-black/30 rounded-2xl overflow-hidden">
                <CoverImage
                  src={song.imageUrl || "/apple-icon.png"}
                  alt={song.title}
                  width={1200}
                  height={1200}
                  loading="eager"
                  className="w-full aspect-square object-cover"
                  sizes="(max-width: 768px) 100vw, 448px"
                />
              </div>

              <div className="text-center lg:text-left">
                <div className="text-2xl sm:text-3xl font-bold leading-tight">{song.title}</div>
                <div className="text-lg opacity-80 mt-1">{song.artist}</div>
              </div>

              {liveStream ? (
                <div className="space-y-2">
                  <div className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div className={cn("h-full w-full bg-emerald-500", isPlaying && "animate-pulse")} />
                  </div>
                  <div className="flex justify-between text-xs font-semibold text-emerald-400">
                    <span>LIVE</span>
                    <span>Radio</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, duration)}
                    step={0.1}
                    value={currentTime}
                    onChange={(event) => onSeek(Number(event.target.value))}
                    className="w-full h-1 appearance-none rounded-full bg-black/10 dark:bg-white/10 accent-emerald-500 touch-manipulation"
                    style={{
                      background: `linear-gradient(to right, rgb(16 185 129) 0%, rgb(16 185 129) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
                    }}
                  />
                  <div className="flex justify-between text-xs tabular-nums opacity-70">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between px-2">
                <button
                  type="button"
                  aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  title={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  onClick={toggleShuffle}
                  className={cn(
                    "relative h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    shuffle ? "text-emerald-500" : "text-foreground/70",
                  )}
                >
                  <Shuffle size={20} />
                  <span
                    className={cn(
                      "absolute bottom-1.5 h-1 w-1 rounded-full bg-emerald-500 transition-opacity",
                      shuffle ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Previous"
                  onClick={previous}
                  className="h-11 w-11 rounded-full grid place-items-center touch-manipulation"
                >
                  <SkipBack size={24} />
                </button>
                <button
                  type="button"
                  aria-label={isPlaying ? "Pause" : "Play"}
                  onClick={toggle}
                  className="h-16 w-16 rounded-full grid place-items-center bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 touch-manipulation"
                >
                  {isPlaying ? <Pause size={28} /> : <Play size={28} className="translate-x-[2px]" />}
                </button>
                <button
                  type="button"
                  aria-label="Next"
                  onClick={next}
                  className="h-11 w-11 rounded-full grid place-items-center touch-manipulation"
                >
                  <SkipForward size={24} />
                </button>
                <button
                  type="button"
                  aria-label="Repeat"
                  onClick={cycleRepeatMode}
                  className={cn(
                    "h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    repeatMode !== "off" ? "text-emerald-500" : "text-foreground/70",
                  )}
                >
                  <Repeat size={20} />
                </button>
              </div>
            </div>

            {!liveStream ? (
            <div className="mt-6 space-y-4 lg:mt-5">
              <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Lyrics</div>
                  <button
                    type="button"
                    onClick={() => setShowLyrics((value) => !value)}
                    className="inline-flex items-center gap-2 h-9 px-3 rounded-full border border-black/15 dark:border-white/20 text-sm active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
                  >
                    <FileText size={14} />
                    {showLyrics ? "Hide lyrics" : "Show lyrics"}
                  </button>
                </div>

                {showLyrics && (
                  <div className="rounded-lg bg-black/5 dark:bg-white/5 p-3 whitespace-pre-wrap text-sm max-h-48 overflow-auto">
                    {lyricsState.status === "idle" && "No lyrics available for this song."}
                    {lyricsState.status === "loading" && "Loading lyrics..."}
                    {lyricsState.status === "error" && "Unable to load lyrics."}
                    {lyricsState.status === "ready" &&
                      (lyricsState.text || "No lyrics available for this song.")}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 hidden lg:block">
                <div className="font-medium mb-3">Credits</div>
                <div className="space-y-3">
                  {credits.map((credit) => (
                    <div key={`${credit.name}-${credit.role}`} className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{credit.name}</div>
                        <div className="text-sm opacity-70">{credit.role}</div>
                      </div>
                      <CheckCircle2 size={16} className="opacity-50 mt-1" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
