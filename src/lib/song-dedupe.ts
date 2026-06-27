import type { PlayerSong } from "@/types/player";

/**
 * Normalizes a song title/artist for dedupe comparison: trims, lowercases, and
 * collapses internal whitespace runs to a single space.
 */
export function normalizeSongPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Cover-farm / non-canonical version markers. Smart Shuffle recommendations should
// surface the real, popular recording — not a karaoke take, a sped-up edit, or a
// label's SEO cover (seen in the wild: "BAD IDEA, Right? (R.R.C1)" by Ravens Rock,
// "HELL YEAH - RAVEN Ruin sessions"). These tells are matched as substrings, so the
// list is deliberately conservative — each phrase is one that real titles don't
// carry. Bare words that DO appear in canonical titles are intentionally absent
// (e.g. "Tribute" by Tenacious D, "Karaoke" by Drake, "Lullaby" by The Cure,
// "Ringtone" by 100 gecs), which is why the markers are qualified ("karaoke
// version", "tribute to", …) rather than the bare word.
const NON_CANONICAL_MARKERS = [
  "karaoke version",
  "(karaoke",
  "made famous",
  "originally performed",
  "in the style of",
  "tribute to",
  "tribute version",
  "cover version",
  "(cover)",
  "acoustic cover",
  "instrumental version",
  "8-bit",
  "8 bit",
  "nightcore",
  "sped up",
  "sped-up",
  "slowed + reverb",
  "slowed and reverb",
  "slowed down",
  "lullaby version",
  "lullaby rendition",
  "music box version",
  "ruin sessions",
];

// A short, code-like bracketed tag — "(R.R.C1)", "(V2)", "[X-3]" — is a label or
// upload version marker, never part of a canonical title. Detected apart from the
// keyword list because the codes are arbitrary. Requires the tag to be all-caps
// code characters AND carry BOTH a letter and a digit/dot, so legit tags like
// "(Reprise)", "(1990)", or "(Pt. 2)" are NOT matched.
function hasVersionCodeTag(title: string): boolean {
  const tags = title.match(/[([][^)\]]{1,8}[)\]]/g);
  if (!tags) return false;
  return tags.some((tag) => {
    const inner = tag.slice(1, -1);
    return /^[A-Z0-9.\-\s]+$/.test(inner) && /[A-Z]/.test(inner) && /[0-9.]/.test(inner);
  });
}

/**
 * Heuristic: does this {title, artist} look like a non-canonical cover / karaoke /
 * version edit rather than the original recording? Used to keep Smart Shuffle
 * recommendations on real, popular tracks (filtered out of the Last.fm pool and
 * rejected by the name→id resolver when a clean track was requested).
 */
export function looksNonCanonicalTrack(title: string, artist = ""): boolean {
  const haystack = `${title} ${artist}`.toLowerCase();
  if (NON_CANONICAL_MARKERS.some((marker) => haystack.includes(marker))) return true;
  return hasVersionCodeTag(title);
}

/**
 * Dedupes songs that share the same normalized title + artist, keeping the most
 * recently created entry. Uses Number.isFinite guards so an unparseable
 * createdAt (NaN) is treated as the oldest timestamp instead of corrupting the
 * comparison.
 */
export function dedupeSongsByTitleArtist(songs: PlayerSong[]): PlayerSong[] {
  const unique = new Map<string, PlayerSong>();
  for (const song of songs) {
    const key = `${normalizeSongPart(song.title)}::${normalizeSongPart(song.artist)}`;
    const current = unique.get(key);
    if (!current) {
      unique.set(key, song);
      continue;
    }
    const currentTime = Date.parse(current.createdAt || "");
    const nextTime = Date.parse(song.createdAt || "");
    const a = Number.isFinite(currentTime) ? currentTime : 0;
    const b = Number.isFinite(nextTime) ? nextTime : 0;
    if (b >= a) {
      unique.set(key, song);
    }
  }
  return [...unique.values()];
}
