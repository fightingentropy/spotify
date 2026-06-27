import { storage } from "@/lib/storage";

// "Don't recommend this again" blocklist for Smart Shuffle. Persisted to MMKV
// (same synchronous `storage` shim the player store uses) so a skipped rec stays
// skipped across relaunches. Keyed two ways: a normalized `title::artist` key
// (catches the same track regardless of which provider id it resolves to) and the
// known Spotify/library id. The controller hands both to the worker as
// `exclude`/`excludeIds`, keeping the recommender stateless. Per-device by design
// (a personal app); a cross-device D1 table is a future option. Bounded to the
// most-recent ~500 of each so the JSON blob can't grow without limit.

const BLOCKLIST_STORAGE_KEY = "spotify_smart_shuffle_blocklist";
const MAX_ENTRIES = 500;

type Blocklist = {
  keys: string[];
  ids: string[];
};

// Replicates normalizeSongPart from src/lib/song-dedupe.ts (trim, lowercase,
// collapse internal whitespace). Kept local — that module lives outside mobile/.
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function blockKey(title: string, artist: string): string {
  return `${normalize(title)}::${normalize(artist)}`;
}

function readBlocklist(): Blocklist {
  try {
    const raw = storage.getItem(BLOCKLIST_STORAGE_KEY);
    if (raw === null) return { keys: [], ids: [] };
    const parsed = JSON.parse(raw) as Partial<Blocklist> | null;
    return {
      keys: Array.isArray(parsed?.keys) ? parsed!.keys.filter((k): k is string => typeof k === "string") : [],
      ids: Array.isArray(parsed?.ids) ? parsed!.ids.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return { keys: [], ids: [] };
  }
}

function writeBlocklist(list: Blocklist): void {
  try {
    storage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(list));
  } catch {}
}

// Push `value` to the end (most-recent), drop any earlier duplicate, and cap to
// the newest MAX_ENTRIES.
function pushBounded(list: string[], value: string): string[] {
  const next = list.filter((item) => item !== value);
  next.push(value);
  return next.slice(-MAX_ENTRIES);
}

export function addBlocked(song: { id?: string; title: string; artist: string }): void {
  const current = readBlocklist();
  const keys = pushBounded(current.keys, blockKey(song.title, song.artist));
  const ids = song.id ? pushBounded(current.ids, song.id) : current.ids;
  writeBlocklist({ keys, ids });
}

export function getBlockedKeys(): string[] {
  return readBlocklist().keys;
}

export function getBlockedIds(): string[] {
  return readBlocklist().ids;
}

export function isBlocked(song: { id?: string; title: string; artist: string }): boolean {
  const list = readBlocklist();
  if (song.id && list.ids.includes(song.id)) return true;
  return list.keys.includes(blockKey(song.title, song.artist));
}
