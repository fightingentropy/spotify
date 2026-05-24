"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, FileText, Music4 } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import { normalizeCoverImageUrl } from "@/lib/song-utils";

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
        // Lyrics files are served from /api/files with an immutable cache
        // header, so the browser HTTP cache is the right layer to rely on.
        const response = await fetch(safeLyricsUrl);
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
        "hidden lg:flex fixed top-14 bottom-[84px] right-0 z-30 border-l border-white/[0.12] bg-background text-white transition-all duration-200",
        collapsed ? "w-16" : "w-80",
      )}
    >
      <div className={cn("h-full w-full overflow-y-auto", collapsed ? "p-2" : "p-4")}>
        <div className="mb-4 flex items-center justify-between">
          {!collapsed && (
            <div className="text-[13px] uppercase tracking-wide text-white/[0.55]">
              Now Playing
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="h-8 w-8 rounded-full grid place-items-center text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white ml-auto"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {collapsed ? (
          <div className="mt-6 flex flex-col items-center gap-3 text-white/[0.68]">
            <Music4 size={18} />
            <span className="[writing-mode:vertical-rl] rotate-180 text-xs tracking-wider">
              Now Playing
            </span>
          </div>
        ) : !currentSong ? (
          <div className="h-full grid place-items-center text-[15px] leading-6 text-white/[0.62] text-center px-4">
            Select a song to see now playing details.
          </div>
        ) : (
          <div className="space-y-5 pb-4">
            <img
              src={normalizeCoverImageUrl(currentSong.imageUrl)}
              alt={currentSong.title}
              loading="eager"
              className="w-full aspect-square rounded-md object-cover bg-white/[0.08]"
            />

            <div>
              <div className="text-[22px] font-semibold leading-tight text-white">{currentSong.title}</div>
              <div className="text-[16px] leading-6 text-white/[0.68] mt-1">{currentSong.artist}</div>
              <div className="text-[13px] leading-5 text-white/[0.55] mt-1">
                {isPlaying ? "Playing" : "Paused"}
              </div>
            </div>

            <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-[16px] text-white">Lyrics</div>
                <button
                  type="button"
                  onClick={() => setShowLyrics((value) => !value)}
                  onMouseUp={(event) => event.currentTarget.blur()}
                  className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-white/[0.16] text-[13px] text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white"
                >
                  <FileText size={13} />
                  {showLyrics ? "Hide" : "Show"}
                </button>
              </div>

              {showLyrics && (
                <div className="rounded-md bg-white/[0.06] p-3 whitespace-pre-wrap text-[13px] leading-5 text-white/[0.72] max-h-48 overflow-auto">
                  {lyricsState.status === "idle" && "No lyrics available for this song."}
                  {lyricsState.status === "loading" && "Loading lyrics..."}
                  {lyricsState.status === "error" && "Unable to load lyrics."}
                  {lyricsState.status === "ready" &&
                    (lyricsState.text || "No lyrics available for this song.")}
                </div>
              )}
            </div>

            <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5">
              <div className="font-medium text-[16px] text-white mb-3">Credits</div>
              <div className="space-y-2.5">
                {credits.map((credit) => (
                  <div
                    key={`${credit.name}-${credit.role}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <div>
                      <div className="text-[15px] font-medium leading-5 text-white">{credit.name}</div>
                      <div className="text-[13px] leading-5 text-white/[0.58]">{credit.role}</div>
                    </div>
                    <CheckCircle2 size={15} className="text-white/[0.45] mt-1" />
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
