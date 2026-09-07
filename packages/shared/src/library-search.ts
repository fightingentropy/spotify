export function normalizeLibrarySearchQuery(value: string): string {
  return value.slice(0, 100).normalize("NFKD").replace(/\p{M}+/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function songMatchesLibraryQuery(
  song: { title: string; artist: string },
  query: string,
): boolean {
  return !normalizeLibrarySearchQuery(query) || scoreLibrarySong(song, query) > 0;
}

// One edit, including a transposition, is enough to recover common typos without
// turning short names, track numbers, or unrelated words into fuzzy matches.
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length) return b.length <= a.length + 1;
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  return a.slice(i + 1) === b.slice(i + 1) || (
    a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  );
}

export function scoreLibrarySong(song: { title: string; artist: string }, query: string): number {
  const q = normalizeLibrarySearchQuery(query);
  if (!q) return 0;
  const title = normalizeLibrarySearchQuery(song.title);
  const artist = normalizeLibrarySearchQuery(song.artist);
  if (title === q) return 1000;
  if (`${title} ${artist}` === q || `${artist} ${title}` === q) return 950;
  const words = `${title} ${artist}`.split(/\s+/);
  const tokens = q.split(/\s+/);
  let fuzzy = 0;
  for (const token of tokens) {
    if (words.some((word) => word.includes(token))) continue;
    if (token.length >= 4 && words.some((word) => word.length >= 3 && oneEditApart(token, word))) {
      fuzzy++;
    } else return 0;
  }
  // Exact token matches always rank above spelling suggestions.
  if (fuzzy) return 100 - fuzzy;
  if (title.startsWith(q)) return 900;
  if (artist === q) return 850;
  if (artist.startsWith(q)) return 800;
  if (title.includes(q)) return 750;
  return 700;
}

export function rankLibrarySongs<T extends { title: string; artist: string }>(songs: readonly T[], query: string): T[] {
  if (!normalizeLibrarySearchQuery(query)) return [...songs];
  return songs.map((song) => ({ song, score: scoreLibrarySong(song, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.song);
}
