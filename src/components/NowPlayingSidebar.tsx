"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Music4, Podcast, RadioTower } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import { parseCredits } from "@/lib/credits";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { CoverImage } from "@/components/CoverImage";
import { LyricsPreview } from "@/components/LyricsPreview";

export default function NowPlayingSidebar() {
  const currentSong = usePlayerStore((state) => state.currentSong);
  const displaySong = currentSong;
  const liveStream = isRadioSong(displaySong);
  const podcastEpisode = isPodcastSong(displaySong);
  const podcastDescription = displaySong?.description?.trim() ?? "";

  const [collapsed, setCollapsed] = useState(
    () => {
      try { return localStorage.getItem("spotify_now_playing_sidebar_open") !== "1"; }
      catch { return true; }
    },
  );
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);

  const credits = useMemo(
    () => parseCredits(displaySong?.artist || ""),
    [displaySong?.artist],
  );

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const width = collapsed ? "4rem" : "20rem";
    document.documentElement.style.setProperty("--wf-right-sidebar-width", width);
    try { localStorage.setItem("spotify_now_playing_sidebar_open", collapsed ? "0" : "1"); } catch {}
    return () => {
      document.documentElement.style.removeProperty("--wf-right-sidebar-width");
    };
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "wf-now-playing-sidebar hidden lg:flex fixed top-14 bottom-[84px] right-0 z-30 bg-black text-white transition-[width] duration-200",
        collapsed ? "w-16" : "w-80",
      )}
    >
      <div className={cn("h-full w-full overflow-y-auto", collapsed ? "p-2" : "p-4")}>
        <div className="mb-4 flex items-center justify-between">
          {!collapsed && (
            <div className="text-[13px] font-medium text-white/[0.55]">
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
        ) : !displaySong ? (
          <div className="h-full grid place-items-center text-[15px] leading-6 text-white/[0.62] text-center px-4">
            Select a song to see now playing details.
          </div>
        ) : (
          <div className="space-y-5 pb-4">
            <CoverImage
              src={displaySong.imageUrl}
              networkSrc={displaySong.networkImageUrl}
              alt={displaySong.title}
              loading="eager"
              sizes="288px"
              className="w-full aspect-square rounded object-cover bg-white/[0.045]"
            />

            <div>
              <div className="text-[22px] font-semibold leading-tight text-white">{displaySong.title}</div>
              <div className="text-[16px] leading-6 text-white/[0.68] mt-1">{displaySong.artist}</div>
            </div>

            {liveStream ? (
              <div className="border-t border-white/[0.08] pt-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white/60">
                    <RadioTower size={18} />
                  </div>
                  <div>
                    <div className="font-medium text-[16px] text-white">Live Radio</div>
                  </div>
                </div>
              </div>
            ) : podcastEpisode ? (
              <div className="border-t border-white/[0.08] pt-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white/60">
                    <Podcast size={18} />
                  </div>
                  <div>
                    <div className="font-medium text-[16px] text-white">Podcast Episode</div>
                  </div>
                </div>
                {podcastDescription ? (
                  <p className="mt-3 line-clamp-5 text-[13px] leading-5 text-white/[0.64]">
                    {podcastDescription}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                {desktop ? <LyricsPreview key={`${displaySong.id}:${displaySong.lyricsUrl ?? ""}`} song={displaySong} /> : null}

                <div className="border-t border-white/[0.08] pt-4">
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
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
