import { useEffect, useState } from "react";
import { activeLyricIndex, type SyncedLyricLine } from "@/lib/lrc";
import { getPlaybackPosition, subscribePlaybackPosition } from "@/lib/playback-position";

// Lead the coarse audio clock slightly so a line doesn't land after the beat.
const SYNC_LOOKAHEAD_MS = 250;

export function useLyricPosition(lines: SyncedLyricLine[] | null): number {
  const [index, setIndex] = useState(() => lines
    ? activeLyricIndex(lines, getPlaybackPosition().currentTime * 1000 + SYNC_LOOKAHEAD_MS)
    : -1);

  useEffect(() => {
    if (!lines) return;
    // React bails out on unchanged indices: only the lyric surfaces update,
    // and only when the song reaches another line, rather than on every tick.
    return subscribePlaybackPosition(({ currentTime }) => {
      setIndex(activeLyricIndex(lines, currentTime * 1000 + SYNC_LOOKAHEAD_MS));
    });
  }, [lines]);

  return lines ? index : -1;
}
