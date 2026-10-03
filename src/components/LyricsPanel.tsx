"use client";

import { useEffect, useRef, useState } from "react";
import { AlignCenter, MicVocal } from "lucide-react";
import type { LyricsState } from "@/lib/credits";
import { useLyricPosition } from "@/lib/use-lyric-position";
import { cn, formatTime } from "@/lib/utils";

type LyricsPanelProps = {
  lyricsState: LyricsState;
  onSeek: (seconds: number) => void;
  className?: string;
};

export function LyricsPanel({ lyricsState, onSeek, className }: LyricsPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasCenteredRef = useRef(false);
  const recenterRef = useRef<() => void>(() => {});
  const [following, setFollowing] = useState(true);
  const synced = lyricsState.status === "ready" ? lyricsState.parsed?.synced ?? null : null;
  const plain = lyricsState.status === "ready" ? lyricsState.parsed?.plain ?? lyricsState.text : "";
  const activeIndex = useLyricPosition(synced);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const centerLine = (smooth: boolean) => {
      container.style.setProperty("--lyrics-height", `${container.clientHeight}px`);
      if (!following || activeIndex < 0) return;
      const line = lineRefs.current[activeIndex];
      if (!line) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.scrollTo({
        top: Math.max(0, line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2),
        behavior: smooth && !reducedMotion && !document.hidden ? "smooth" : "instant",
      });
      hasCenteredRef.current = true;
    };
    recenterRef.current = () => centerLine(false);
    centerLine(hasCenteredRef.current);
  }, [activeIndex, following, synced]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => recenterRef.current());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const pauseFollowing = () => { if (synced) setFollowing(false); };

  let body;
  if (lyricsState.status === "loading") {
    body = (
      <div role="status" aria-label="Loading lyrics" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-1 py-12">
        {[0.65, 0.9, 0.75, 0.55].map((width, index) => (
          <div key={index} className="wf-skeleton h-8 rounded" style={{ width: `${width * 100}%` }} />
        ))}
      </div>
    );
  } else if (lyricsState.status !== "ready" || (!synced && !plain.trim())) {
    body = (
      <div role="status" className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center">
        <MicVocal size={28} strokeWidth={1.5} className="text-white/35" />
        <p className="text-base font-medium text-white/80">
          {lyricsState.status === "error" ? "Lyrics couldn’t load" : "No lyrics for this track yet"}
        </p>
        <p className="text-sm text-white/50">
          {lyricsState.status === "error" ? "Try opening lyrics again in a moment." : "You can keep listening while you browse."}
        </p>
      </div>
    );
  } else if (synced) {
    body = (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-1 sm:gap-4"
        style={{ paddingBlock: "max(24px, calc(var(--lyrics-height, 480px) / 2 - 36px))" }}
      >
        {synced.map((line, index) => (
          <button
            key={`${line.timeMs}-${index}`}
            ref={(node) => { lineRefs.current[index] = node; }}
            type="button"
            title={`Jump to ${formatTime(line.timeMs / 1000)}`}
            aria-current={index === activeIndex ? "true" : undefined}
            aria-label={line.text ? undefined : "Instrumental"}
            onClick={() => {
              onSeek(line.timeMs / 1000);
              setFollowing(true);
            }}
            onFocus={() => { if (index !== activeIndex) setFollowing(false); }}
            className={cn(
              "w-full rounded-sm py-1 text-left text-[28px] font-semibold leading-[1.45] tracking-[-0.025em] transition-colors duration-200 sm:text-[36px] xl:text-[42px]",
              index === activeIndex ? "text-white" : "text-white/[0.4]",
              "cursor-pointer hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 motion-reduce:transition-none",
            )}
          >
            {line.text || "♪"}
          </button>
        ))}
      </div>
    );
  } else {
    body = (
      <div className="mx-auto w-full max-w-3xl whitespace-pre-wrap px-1 py-8 text-[28px] font-semibold leading-[1.65] tracking-[-0.025em] text-white/85 sm:text-[36px] xl:text-[42px]">
        {plain}
      </div>
    );
  }

  return (
    <div data-preserve-playback-keys className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={containerRef}
        role="region"
        aria-label="Song lyrics"
        tabIndex={0}
        onWheel={pauseFollowing}
        onTouchMove={pauseFollowing}
        onPointerDown={(event) => { if (event.target === event.currentTarget) pauseFollowing(); }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)
            || (event.key === " " && event.target === event.currentTarget)) pauseFollowing();
        }}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/50"
        style={{ maskImage: "linear-gradient(to bottom, transparent, black 20px, black calc(100% - 20px), transparent)" }}
      >
        {body}
      </div>
      {synced && !following ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button type="button" onClick={() => setFollowing(true)} className="wf-button pointer-events-auto shadow-lg">
            <AlignCenter size={16} />
            Resume lyrics
          </button>
        </div>
      ) : null}
    </div>
  );
}
