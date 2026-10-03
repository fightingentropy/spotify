import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { useLyrics } from "@/lib/credits";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { requestPlaybackSeek } from "@/lib/playback-position";
import { useLyricsNavigation } from "@/lib/use-lyrics-navigation";
import { CoverImage } from "@/components/CoverImage";
import { LyricsPanel } from "@/components/LyricsPanel";
import { PageHeader, PageLayout } from "@/components/PageLayout";
import type { PlayerSong } from "@/types/player";

function TrackLyrics({ song }: { song: PlayerSong }) {
  const state = useLyrics(song.id, song.lyricsUrl, true);
  return <LyricsPanel lyricsState={state} onSeek={requestPlaybackSeek} className="flex-1" />;
}

export default function LyricsPage() {
  const song = usePlayerStore((state) => state.currentSong);
  const { closeLyrics } = useLyricsNavigation();
  const titleRef = useRef<HTMLSpanElement>(null);
  const music = song && !isRadioSong(song) && !isPodcastSong(song);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('.wf-now-playing-panel[data-open="true"], [role="dialog"][aria-modal="true"]')) return;
      // Menus in the header/player own their Escape key. Closing one must not
      // also navigate away from lyrics underneath it.
      if (event.target instanceof Node && event.target !== document.body
        && !titleRef.current?.closest(".wf-page")?.contains(event.target)) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      closeLyrics();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeLyrics]);

  return (
    <PageLayout className="flex h-full min-h-0 flex-col pb-4 sm:pb-6">
      <PageHeader
        title={<span ref={titleRef} tabIndex={-1} className="outline-none">Lyrics</span>}
        actions={
          <button data-preserve-playback-keys type="button" onClick={closeLyrics} aria-label="Close lyrics" title="Close lyrics (Esc)" className="wf-icon-button">
            <X size={20} />
          </button>
        }
      />
      {song ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] pb-5">
          <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} alt="" sizes="40px" className="h-10 w-10 shrink-0 rounded object-cover" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white/90">{song.title}</p>
            <p className="truncate text-[13px] text-white/55">{song.artist}</p>
          </div>
        </div>
      ) : null}
      {music ? (
        <TrackLyrics key={`${song.id}:${song.lyricsUrl ?? ""}`} song={song} />
      ) : (
        <div className="grid flex-1 place-items-center text-center text-sm text-white/60">Play a song to see its lyrics.</div>
      )}
    </PageLayout>
  );
}
