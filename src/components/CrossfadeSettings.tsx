"use client";

import { usePlayerStore } from "@/store/player";
import { SectionHeader } from "@/components/PageLayout";

export default function CrossfadeSettings() {
  // Crossfade settings are hydrated once by the player store's lazy initializer
  // (the single source of truth reading the stored crossfade keys), so this
  // component just reads from / writes to the store.
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  return (
    <section>
      <SectionHeader title="Playback" />
      <div className="wf-panel p-5">
        <label htmlFor="crossfade-enabled" className="flex min-h-10 cursor-pointer items-center justify-between gap-4 text-sm">
          <span>
            <span className="block font-medium">Crossfade</span>
            <span className="wf-muted mt-1 block">Blend the end of one song into the next.</span>
          </span>
          <input
            id="crossfade-enabled"
            type="checkbox"
            checked={crossfadeEnabled}
            onChange={(e) => setCrossfadeEnabled(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70"
          />
        </label>
        <div className="mt-5 border-t border-white/[0.08] pt-5">
          <label htmlFor="crossfade-seconds" className="mb-3 flex items-center justify-between text-sm">
            <span className="wf-muted">Duration</span>
            <span className="tabular-nums" suppressHydrationWarning>{crossfadeSeconds}s</span>
          </label>
          <input
            id="crossfade-seconds"
            type="range"
            min={0}
            max={12}
            step={1}
            value={crossfadeSeconds}
            aria-label="Crossfade duration"
            onChange={(e) => setCrossfadeSeconds(Number(e.target.value))}
            className="h-1.5 w-full appearance-none rounded bg-white/[0.12] accent-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40"
            disabled={!crossfadeEnabled}
          />
        </div>
      </div>
    </section>
  );
}
