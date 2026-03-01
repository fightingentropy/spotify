"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { CheckCircle2, ChevronLeft, ChevronRight, FileText, Music4 } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";

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

export default function NowPlayingSidebar() {
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  const [collapsed, setCollapsed] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsState, setLyricsState] = useState<LyricsState>({
    status: "idle",
    text: "",
  });
  const loadedLyricsKeyRef = useRef<string | null>(null);

  const credits = useMemo(
    () => parseCredits(currentSong?.artist || ""),
    [currentSong?.artist],
  );

  useEffect(() => {
    if (!showLyrics) return;

    const lyricsUrl = currentSong?.lyricsUrl;
    if (!lyricsUrl) {
      setLyricsState({ status: "idle", text: "" });
      loadedLyricsKeyRef.current = null;
      return;
    }
    const lyricsKey = `${currentSong?.id ?? ""}:${lyricsUrl}`;
    if (loadedLyricsKeyRef.current === lyricsKey) {
      return;
    }
    const safeLyricsUrl = lyricsUrl;

    let cancelled = false;

    async function loadLyrics() {
      setLyricsState({ status: "loading", text: "" });
      try {
        const response = await fetch(safeLyricsUrl, {
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
  }, [currentSong?.id, currentSong?.lyricsUrl, showLyrics]);

  return (
    <aside
      className={cn(
        "hidden lg:flex fixed top-14 bottom-[84px] right-0 z-30 border-l border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-all duration-200",
        collapsed ? "w-16" : "w-80",
      )}
    >
      <div className="h-full w-full overflow-y-auto p-3">
        <div className="mb-3 flex items-center justify-between">
          {!collapsed && (
            <div className="text-xs uppercase tracking-wide opacity-70">
              Now Playing
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="h-8 w-8 rounded-full grid place-items-center hover:bg-black/10 hover:dark:bg-white/10 ml-auto"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {collapsed ? (
          <div className="mt-6 flex flex-col items-center gap-3 opacity-80">
            <Music4 size={18} />
            <span className="[writing-mode:vertical-rl] rotate-180 text-xs tracking-wider">
              Now Playing
            </span>
          </div>
        ) : !currentSong ? (
          <div className="h-full grid place-items-center text-sm opacity-70 text-center px-4">
            Select a song to see now playing details.
          </div>
        ) : (
          <div className="space-y-4 pb-4">
            <Image
              src={currentSong.imageUrl || "/waveform.svg"}
              alt={currentSong.title}
              width={500}
              height={500}
              loading="eager"
              className="w-full aspect-square rounded-xl object-cover"
              unoptimized
            />

            <div>
              <div className="text-xl font-semibold leading-tight">{currentSong.title}</div>
              <div className="text-sm opacity-80 mt-1">{currentSong.artist}</div>
              <div className="text-xs opacity-70 mt-1">
                {isPlaying ? "Playing" : "Paused"}
              </div>
            </div>

            <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-sm">Lyrics</div>
                <button
                  type="button"
                  onClick={() => setShowLyrics((value) => !value)}
                  onMouseUp={(event) => event.currentTarget.blur()}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-full border border-black/15 dark:border-white/20 text-xs hover:bg-black/5 hover:dark:bg-white/5"
                >
                  <FileText size={13} />
                  {showLyrics ? "Hide" : "Show"}
                </button>
              </div>

              {showLyrics && (
                <div className="rounded-lg bg-black/5 dark:bg-white/5 p-2 whitespace-pre-wrap text-xs max-h-48 overflow-auto">
                  {lyricsState.status === "idle" && "No lyrics available for this song."}
                  {lyricsState.status === "loading" && "Loading lyrics..."}
                  {lyricsState.status === "error" && "Unable to load lyrics."}
                  {lyricsState.status === "ready" &&
                    (lyricsState.text || "No lyrics available for this song.")}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-black/10 dark:border-white/10 p-3">
              <div className="font-medium text-sm mb-2">Credits</div>
              <div className="space-y-2">
                {credits.map((credit) => (
                  <div
                    key={`${credit.name}-${credit.role}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{credit.name}</div>
                      <div className="text-xs opacity-70">{credit.role}</div>
                    </div>
                    <CheckCircle2 size={14} className="opacity-50 mt-1" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
