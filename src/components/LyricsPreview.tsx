import { ArrowUpRight } from "lucide-react";
import { useLyrics } from "@/lib/credits";
import { useLyricPosition } from "@/lib/use-lyric-position";
import { useLyricsNavigation } from "@/lib/use-lyrics-navigation";
import { cn } from "@/lib/utils";
import type { PlayerSong } from "@/types/player";

export function LyricsPreview({ song }: { song: PlayerSong }) {
  const lyrics = useLyrics(song.id, song.lyricsUrl, true);
  const { openLyrics, lyricsOpen } = useLyricsNavigation();
  const synced = lyrics.status === "ready" ? lyrics.parsed?.synced ?? null : null;
  const activeIndex = useLyricPosition(synced);
  const start = synced ? Math.max(0, Math.min(activeIndex - 1, synced.length - 3)) : 0;
  const lines = synced
    ? synced.slice(start, start + 3).map((line) => line.text || "♪")
    : (lyrics.parsed?.plain ?? lyrics.text).split("\n").filter((line) => line.trim()).slice(0, 3);

  return (
    <section className="space-y-3 border-t border-white/[0.08] pt-4" aria-label="Lyrics preview">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium text-white">Lyrics</h2>
        {song.lyricsUrl && !lyricsOpen ? (
          <button
            data-preserve-playback-keys
            type="button"
            onClick={openLyrics}
            aria-label="Open lyrics"
            title="Open lyrics"
            className="wf-control-button -mr-1 grid h-8 w-8 place-items-center rounded-md text-white/60 transition hover:bg-white/[0.09] hover:text-white focus-visible:outline-2 focus-visible:outline-white/60"
          >
            <ArrowUpRight size={18} />
          </button>
        ) : null}
      </div>
      {lyrics.status === "loading" ? (
        <div role="status" aria-label="Loading lyrics" className="space-y-3 py-1">
          {["85%", "65%", "75%"].map((width) => <div key={width} className="wf-skeleton h-4 rounded" style={{ width }} />)}
        </div>
      ) : lines.length ? (
        <div className="space-y-2 text-[17px] font-medium leading-6 tracking-[-0.01em]">
          {lines.map((line, index) => (
            <p key={`${start + index}-${line}`} className={cn("line-clamp-2", synced && start + index === activeIndex ? "text-white" : "text-white/45")}>
              {line}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-[13px] leading-5 text-white/50">
          {lyrics.status === "error" ? "Lyrics couldn’t load." : "No lyrics available for this track."}
        </p>
      )}
    </section>
  );
}
