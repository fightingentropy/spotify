// Minimal .lrc parsing. Each line may be prefixed with one or more
// [mm:ss.xx] timestamps; we strip them for plain display and also expose the
// parsed timed lines for optional sync highlighting.
export type LrcLine = { time: number; text: string };

const TIMESTAMP = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(raw: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const text = rawLine.replace(TIMESTAMP, "").trim();
    let match: RegExpExecArray | null;
    TIMESTAMP.lastIndex = 0;
    let matched = false;
    while ((match = TIMESTAMP.exec(rawLine)) !== null) {
      matched = true;
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const frac = match[3] ? Number(`0.${match[3]}`) : 0;
      lines.push({ time: min * 60 + sec + frac, text });
    }
    if (!matched && text) lines.push({ time: -1, text });
  }
  return lines;
}

export function stripLrc(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
