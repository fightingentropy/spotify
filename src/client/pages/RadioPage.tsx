"use client";

import { Pause, Play, Radio } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { CoverImage } from "@/components/CoverImage";
import { PageHeader, PageLayout } from "@/components/PageLayout";
import { RADIO_STATIONS } from "@/lib/radio-stations";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";

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
      if (!isPlaying) requestImmediatePlayback(station);
      toggle();
      return;
    }

    requestImmediatePlayback(station);
    setQueue(RADIO_STATIONS, index);
  }

  return (
    <PageLayout>
      <PageHeader title="Radio" description={`${RADIO_STATIONS.length} live stations`} />
      <div className="divide-y divide-white/[0.08] border-t border-white/[0.08]">
        {RADIO_STATIONS.map((station, index) => {
          const active = currentStationId === station.id;
          const playing = active && isPlaying;
          return (
            <button
              key={station.id}
              type="button"
              onClick={() => playStation(index)}
              aria-label={`${playing ? "Pause" : "Play"} ${station.title}`}
              aria-pressed={playing}
              className={cn(
                "group flex w-full min-w-0 items-center gap-4 py-4 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70",
                active && "bg-white/[0.04]",
              )}
            >
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
                <CoverImage
                  src={station.imageUrl}
                  alt={station.title}
                  fill
                  className="object-cover"
                  loading={index === 0 ? "eager" : "lazy"}
                  sizes="64px"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[15px] font-semibold leading-6">{station.title}</h2>
                <p className="wf-muted truncate text-sm">{station.location}</p>
                <div className="wf-muted mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="inline-flex items-center gap-1"><Radio size={12} /> Live</span>
                  <span aria-hidden>·</span>
                  <span>{station.streamLabel}</span>
                </div>
              </div>
              <span className="wf-icon-button shrink-0" aria-hidden>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </span>
            </button>
          );
        })}
      </div>
    </PageLayout>
  );
}
