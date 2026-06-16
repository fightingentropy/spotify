"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/store/player";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { isUnstagedDiscoverSong, stageDiscoverSong } from "@/client/discover-queue";

// Drives just-in-time staging for curated-playlist queues. Curated tracks enter
// the queue as placeholders (empty audioUrl); this materializes the current one
// so it can play, and prefetch-stages the next one so advancing is seamless.
// Mounted once, app-wide (next to PlayerBar) so it keeps working after the user
// navigates away from the playlist page. Renders nothing.
const MAX_CONSECUTIVE_FAILURES = 3;

export function DiscoverQueueStager(): null {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const replaceStagedSong = usePlayerStore((s) => s.replaceStagedSong);
  const next = usePlayerStore((s) => s.next);
  const pause = usePlayerStore((s) => s.pause);

  // Placeholder ids with a stage request in flight (dedupe) and ones that failed
  // (don't retry forever / loop through the whole queue).
  const inFlightRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    const stage = (placeholderId: string, song: Parameters<typeof stageDiscoverSong>[0], isCurrent: boolean) => {
      if (inFlightRef.current.has(placeholderId) || failedRef.current.has(placeholderId)) return;
      inFlightRef.current.add(placeholderId);
      void stageDiscoverSong(song)
        .then((real) => {
          if (isCurrent) consecutiveFailuresRef.current = 0;
          replaceStagedSong(placeholderId, real);
          // Nudge playback for the active track (the load effect also picks up the
          // new src since isPlaying stays true — this is belt-and-suspenders for
          // autoplay). No-ops for a prefetched track that isn't current yet.
          const state = usePlayerStore.getState();
          if (state.currentSong?.id === real.id && state.isPlaying) requestImmediatePlayback(real);
        })
        .catch(() => {
          failedRef.current.add(placeholderId);
          if (!isCurrent) return;
          consecutiveFailuresRef.current += 1;
          // Skip a dead track so the playlist keeps moving, but stop after a few
          // misses in a row instead of churning through the entire queue.
          const state = usePlayerStore.getState();
          if (state.currentSong?.id !== placeholderId) return;
          if (consecutiveFailuresRef.current < MAX_CONSECUTIVE_FAILURES) next();
          else pause();
        })
        .finally(() => {
          inFlightRef.current.delete(placeholderId);
        });
    };

    const current = queue[currentIndex] ?? null;
    if (current && isUnstagedDiscoverSong(current)) {
      stage(current.id, current, true);
    }

    // Prefetch one ahead (linear only — shuffle's next pick is random). Stage it
    // while the current track plays so the transition is gapless.
    if (isPlaying && !usePlayerStore.getState().shuffle) {
      const upcoming = queue[currentIndex + 1] ?? null;
      if (upcoming && isUnstagedDiscoverSong(upcoming)) stage(upcoming.id, upcoming, false);
    }
  }, [queue, currentIndex, currentSongId, isPlaying, next, pause, replaceStagedSong]);

  return null;
}
