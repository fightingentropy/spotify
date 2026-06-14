// Synced-lyrics helpers on top of the LrcLine[] produced by parseLrc().
//
// parseLrc keeps untimed lines as { time: -1 } interleaved with timed lines.
// For highlighting we treat a line as "synced" only when it carries a real
// timestamp; the helpers below ignore the untimed (-1) entries.
import type { LrcLine } from "@/lib/lrc";

// Below this many timed lines the timestamps are likely noise (a stray tag in
// otherwise plain text), so the synced view is not offered. Mirrors web's
// parseLyrics MIN_SYNCED_LINES.
const MIN_SYNCED_LINES = 3;

// True when the parsed lyrics carry enough timestamps to drive a synced view.
export function hasSyncedTiming(lines: LrcLine[]): boolean {
  let timed = 0;
  for (const line of lines) {
    if (line.time >= 0 && ++timed >= MIN_SYNCED_LINES) return true;
  }
  return false;
}

// Index (into `lines`) of the lyric line active at `positionSec`: the last
// timed line whose timestamp has passed. Returns -1 before the first timed
// line. Ported from web's activeLyricIndex; adapted to LrcLine[] (seconds, with
// interleaved untimed -1 lines that are skipped). `lines` is assumed in source
// order, with timed entries non-decreasing in time (parseLrc preserves this).
export function activeLyricIndex(lines: LrcLine[], positionSec: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const time = lines[i].time;
    if (time < 0) continue; // untimed line — carry the current highlight
    if (time <= positionSec) active = i;
    else break;
  }
  return active;
}
