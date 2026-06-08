import { normalizeSearchValue } from "./provider-http";

// Shared title/artist/album text-match scoring used by the qobuz and tidal
// search-candidate rankers. Both providers scored these three fields
// identically (exact match vs. substring match) before the per-provider
// quality bonus; only the field extraction and that trailing bonus differ, so
// those stay in each provider.
//
// Weights match the original copies:
//   title:  1000 exact / 500 substring
//   artist:  300 exact / 180 substring
//   album:   150 exact /  90 substring

function scoreField(
  needleRaw: string,
  haystackRaw: string,
  exactScore: number,
  partialScore: number,
  requireHaystack: boolean,
): number {
  const needle = normalizeSearchValue(needleRaw);
  const haystack = normalizeSearchValue(haystackRaw);
  if (needle && haystack === needle) {
    return exactScore;
  }
  if (
    needle &&
    (!requireHaystack || haystack) &&
    (haystack.includes(needle) || needle.includes(haystack))
  ) {
    return partialScore;
  }
  return 0;
}

export function scoreTitleArtistAlbum(
  needles: { title: string; artist: string; album: string },
  haystacks: { title: string; artist: string; album: string },
): number {
  return (
    scoreField(needles.title, haystacks.title, 1000, 500, false) +
    scoreField(needles.artist, haystacks.artist, 300, 180, true) +
    scoreField(needles.album, haystacks.album, 150, 90, true)
  );
}
