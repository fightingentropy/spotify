"use client";

import { ExternalLink, Pause, Play, Radio, RadioTower } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { CoverImage } from "@/components/CoverImage";
import { RADIO_STATIONS } from "@/lib/radio-stations";
import { cn } from "@/lib/utils";

export default function RadioPage() {
  const setQueue = usePlayerStore((state) => state.setQueue);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const toggle = usePlayerStore((state) => state.toggle);
  const currentStationId = currentSong?.source === "radio" ? currentSong.id : null;

  function playStation(index: number) {
    const station = RADIO_STATIONS[index];
    if (!station) return;

    if (currentStationId === station.id) {
      toggle();
      return;
    }

    setQueue(RADIO_STATIONS, index);
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-200">
              <RadioTower size={23} />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">Radio Stations</h1>
              <div className="mt-1 text-sm text-white/[0.62]">
                {RADIO_STATIONS.length} live stations
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => playStation(0)}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-black transition hover:scale-[1.02]"
          >
            <Play size={17} className="translate-x-[1px]" />
            Play
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {RADIO_STATIONS.map((station, index) => {
            const active = currentStationId === station.id;
            const playing = active && isPlaying;
            return (
              <article
                key={station.id}
                className="overflow-hidden rounded-lg border border-white/[0.12] bg-white/[0.04]"
              >
                <div className={cn("h-1.5 bg-gradient-to-r", station.accentClassName)} />
                <div className="flex gap-4 p-4 sm:p-5">
                  <CoverImage
                    src={station.imageUrl}
                    alt={station.title}
                    width={96}
                    height={96}
                    className="h-24 w-24 shrink-0 rounded-md object-cover"
                    loading={index === 0 ? "eager" : "lazy"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-white/[0.56]">
                      <Radio size={14} />
                      Live Radio
                    </div>
                    <h2 className="truncate text-xl font-semibold">{station.title}</h2>
                    <div className="mt-1 truncate text-sm text-white/[0.66]">{station.location}</div>
                    <div className="mt-3 text-sm text-white/[0.56]">{station.streamLabel}</div>
                    <div className="mt-4 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => playStation(index)}
                        className={cn(
                          "inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition",
                          active
                            ? "bg-[#1ed760] text-black hover:bg-[#1fdf64]"
                            : "bg-white text-black hover:scale-[1.02]",
                        )}
                      >
                        {playing ? <Pause size={17} /> : <Play size={17} className="translate-x-[1px]" />}
                        {playing ? "Pause" : active ? "Resume" : "Play"}
                      </button>
                      <a
                        href={station.homepageUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${station.title} website`}
                        title={`${station.title} website`}
                        className="grid h-10 w-10 place-items-center rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white"
                      >
                        <ExternalLink size={17} />
                      </a>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <div className="h-8 lg:h-24" />
      </div>
    </div>
  );
}
