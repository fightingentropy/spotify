// Parser for LRC (timed lyrics) files with a plain-text fallback.
//
// Accepts the common shapes seen in the wild: `[mm:ss.xx]` / `[mm:ss]` tags,
// multiple tags sharing one line (`[01:10.00][02:40.00]chorus`), metadata tags
// (`[ar:...]`, `[offset:+250]`), and untimed plain text.

export type SyncedLyricLine = {
  timeMs: number;
  text: string;
};

export type ParsedLyrics = {
  // Present when the source had enough timestamps to drive a synced view.
  synced: SyncedLyricLine[] | null;
  // Always present: the lyric text without any LRC tags.
  plain: string;
};

const TIME_TAG_PATTERN = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const METADATA_TAG_PATTERN = /^\[(ar|ti|al|au|by|re|ve|length|la|tool|#)\b[^\]]*\]\s*$/i;
const OFFSET_TAG_PATTERN = /\[offset:\s*([+-]?\d+)\s*\]/i;

// Below this many timed lines the timestamps are likely noise (a stray tag in
// otherwise plain text), so the synced view is not offered.
const MIN_SYNCED_LINES = 3;

function fractionToMs(fraction: string | undefined): number {
  if (!fraction) return 0;
  if (fraction.length === 1) return Number(fraction) * 100;
  if (fraction.length === 2) return Number(fraction) * 10;
  return Number(fraction.slice(0, 3));
}

export function parseLyrics(raw: string): ParsedLyrics {
  const text = (raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return { synced: null, plain: "" };

  const offsetMatch = text.match(OFFSET_TAG_PATTERN);
  // Positive LRC offset means lyrics should appear earlier.
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0;

  const synced: SyncedLyricLine[] = [];
  const plainLines: string[] = [];

  for (const line of text.split("\n")) {
    if (METADATA_TAG_PATTERN.test(line.trim())) continue;

    const tags = Array.from(line.matchAll(TIME_TAG_PATTERN));
    const lineText = line.replace(TIME_TAG_PATTERN, "").trim();

    if (tags.length === 0) {
      plainLines.push(lineText);
      continue;
    }

    plainLines.push(lineText);
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) continue;
      const timeMs = Math.max(0, minutes * 60_000 + seconds * 1_000 + fractionToMs(tag[3]) - offsetMs);
      synced.push({ timeMs, text: lineText });
    }
  }

  synced.sort((left, right) => left.timeMs - right.timeMs);

  // Trim leading/trailing blank plain lines while preserving inner stanza gaps.
  while (plainLines.length > 0 && !plainLines[0]) plainLines.shift();
  while (plainLines.length > 0 && !plainLines[plainLines.length - 1]) plainLines.pop();
  const plain = plainLines.join("\n").replace(/\n{3,}/g, "\n\n");

  return {
    synced: synced.length >= MIN_SYNCED_LINES ? synced : null,
    plain,
  };
}

// Index of the lyric line active at `positionMs`: the last line whose
// timestamp has passed. -1 before the first line.
export function activeLyricIndex(lines: SyncedLyricLine[], positionMs: number): number {
  if (lines.length === 0 || positionMs < lines[0].timeMs) return -1;
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lines[mid].timeMs <= positionMs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
