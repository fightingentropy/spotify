// Pure play-queue navigation helpers, deliberately free of React Native / storage
// imports so they can be unit-tested directly. (The player store reads native
// storage at module load, so importing it under a plain test runner isn't viable.)

/**
 * Step backward through the shuffle play-history to the most recent entry that is
 * still in range and playable. `canPlay(index)` lets the caller exclude entries
 * that aren't streamable right now — offline, only downloaded queue items pass —
 * so "previous" never lands on an un-streamable track. Online, `canPlay` is
 * always true and this simply returns the last visited index.
 *
 * Returns the target index plus the remaining history (consumed entries removed),
 * or null when no eligible entry exists (empty history, or every remembered track
 * is now out of range / un-downloaded).
 */
export function rewindHistory(
  history: readonly number[],
  queueLength: number,
  canPlay: (index: number) => boolean,
): { index: number; remaining: number[] } | null {
  const remaining = history.slice();
  while (remaining.length > 0) {
    const idx = remaining.pop();
    if (idx !== undefined && idx >= 0 && idx < queueLength && canPlay(idx)) {
      return { index: idx, remaining };
    }
  }
  return null;
}
