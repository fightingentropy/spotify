"use client";

import { useEffect } from "react";
import { usePlayerStore } from "@/store/player";

export default function CrossfadeSettings() {
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  // Hydrate settings from localStorage on client to avoid SSR mismatch
  useEffect(() => {
    try {
      const storedEnabled = localStorage.getItem("spotify_crossfade_enabled");
      const enabled = storedEnabled === null ? true : storedEnabled === "1";
      const secs = Math.max(0, Math.min(12, Number(localStorage.getItem("spotify_crossfade_seconds") ?? 4)));
      setCrossfadeEnabled(enabled);
      setCrossfadeSeconds(secs);
    } catch {}
  }, [setCrossfadeEnabled, setCrossfadeSeconds]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Playback</h2>
        <div className="rounded border border-black/10 dark:border-white/10 p-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={crossfadeEnabled}
              onChange={(e) => setCrossfadeEnabled(e.target.checked)}
            />
            <span>Enable crossfade between songs</span>
          </label>
          <div className="mt-4 opacity-80">
            <label className="block text-sm mb-2">
              Crossfade duration: <span suppressHydrationWarning>{crossfadeSeconds}</span>s
            </label>
            <input
              type="range"
              min={0}
              max={12}
              step={1}
              value={crossfadeSeconds}
              onChange={(e) => setCrossfadeSeconds(Number(e.target.value))}
              className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500"
              disabled={!crossfadeEnabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

