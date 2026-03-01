"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { CheckCircle2, FileText, X } from "lucide-react";
import type { PlayerSong } from "@/types/player";
import { cn, formatTime } from "@/lib/utils";

type NowPlayingSheetProps = {
  open: boolean;
  onClose: () => void;
  song: PlayerSong;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
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
}: NowPlayingSheetProps) {
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsState, setLyricsState] = useState<LyricsState>({
    status: "idle",
    text: "",
  });
  const loadedLyricsKeyRef = useRef<string | null>(null);

  const credits = useMemo(() => parseCredits(song.artist), [song.artist]);

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
        const response = await fetch(song.lyricsUrl as string, {
          cache: "no-store",
        });
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

  return (
    <div
      className={cn(
        "fixed inset-0 z-30 transition",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-label="Close now playing view"
      />

      <section
        className={cn(
          "absolute left-0 right-0 top-14 bottom-[84px] mx-auto max-w-3xl border border-black/10 dark:border-white/10 bg-background/95 backdrop-blur-lg rounded-t-2xl overflow-hidden transition duration-200",
          open ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0",
        )}
      >
        <div className="h-full overflow-y-auto p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm uppercase tracking-wide opacity-70">Now Playing</div>
            <button
              type="button"
              onClick={onClose}
              className="h-9 w-9 rounded-full grid place-items-center hover:bg-black/10 hover:dark:bg-white/10"
              aria-label="Collapse now playing"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-5">
            <div className="mx-auto w-full max-w-md">
              <Image
                src={song.imageUrl || "/waveform.svg"}
                alt={song.title}
                width={1200}
                height={1200}
                loading="eager"
                className="w-full aspect-square rounded-xl object-cover"
                unoptimized
              />
            </div>

            <div>
              <div className="text-3xl font-semibold leading-tight">{song.title}</div>
              <div className="text-lg opacity-80 mt-1">{song.artist}</div>
              <div className="text-sm opacity-70 mt-2">
                {isPlaying ? "Playing" : "Paused"} • {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            </div>

            <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">Lyrics</div>
                <button
                  type="button"
                  onClick={() => setShowLyrics((value) => !value)}
                  onMouseUp={(event) => event.currentTarget.blur()}
                  className="inline-flex items-center gap-2 h-8 px-3 rounded-full border border-black/15 dark:border-white/20 text-sm hover:bg-black/5 hover:dark:bg-white/5"
                >
                  <FileText size={14} />
                  {showLyrics ? "Hide lyrics" : "Show lyrics"}
                </button>
              </div>

              {showLyrics && (
                <div className="rounded-lg bg-black/5 dark:bg-white/5 p-3 whitespace-pre-wrap text-sm max-h-56 overflow-auto">
                  {lyricsState.status === "idle" && "No lyrics available for this song."}
                  {lyricsState.status === "loading" && "Loading lyrics..."}
                  {lyricsState.status === "error" && "Unable to load lyrics."}
                  {lyricsState.status === "ready" &&
                    (lyricsState.text || "No lyrics available for this song.")}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
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
        </div>
      </section>
    </div>
  );
}
