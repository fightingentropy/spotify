import { describe, expect, test } from "bun:test";
import { albumDetailPath, albumPagePath, albumSearchPath, isYouTubeAlbumId, parseAlbumLink } from "../packages/shared/src/catalog-albums";
import { apiReadTimeoutMs, isProviderReadThroughRequest } from "../packages/shared/src/api-timeout-policy";
import { parseYouTubeAlbumDetail, parseYouTubeAlbumSearch } from "../src/lib/youtube-albums";
import { parseSpotifyAlbumCatalog, parseSpotifyAlbumSearch } from "../src/lib/spotify-pathfinder";
import youtubeSearch from "./fixtures/albums/youtube-search.json";
import youtubeAlbum from "./fixtures/albums/youtube-album.json";

const youtubeId = "OLAK5uy_mizQEF9wXLFxAjGlDF83JskTg49IZ1Ito";
const spotifyId = "3T4tUhGYeRNVUGevb0wThu";

describe("album navigation", () => {
  test("opens public album links from both providers, including shared and regional URLs", () => {
    expect(parseAlbumLink(`https://music.youtube.com/playlist?list=${youtubeId}&si=share`)).toEqual({ provider: "youtube", id: youtubeId });
    expect(parseAlbumLink("https://music.youtube.com/browse/MPREb_T5s950Swfdy")).toEqual({ provider: "youtube", id: "MPREb_T5s950Swfdy" });
    expect(parseAlbumLink(`https://open.spotify.com/intl-gb/album/${spotifyId}?si=share`)).toEqual({ provider: "spotify", id: spotifyId });
    expect(albumPagePath({ provider: "youtube", id: youtubeId })).toBe(`/search/album/youtube/${youtubeId}`);
    expect(albumDetailPath({ provider: "spotify", id: spotifyId })).toBe(`/api/catalog/spotify/albums/${spotifyId}`);
  });
  test("rejects arbitrary hosts, user info, schemes, paths and ordinary playlists", () => {
    for (const url of ["Ed Sheeran Divide", "file:///etc/passwd", `https://music.youtube.com.evil.test/playlist?list=${youtubeId}`,
      `https://user:password@music.youtube.com/playlist?list=${youtubeId}`, `https://music.youtube.com:8443/playlist?list=${youtubeId}`,
      "https://music.youtube.com/playlist?list=PLordinaryplaylist", "https://music.youtube.com/browse/../../private"]) expect(parseAlbumLink(url)).toBeNull();
    expect(isYouTubeAlbumId(`${youtubeId}/../secret`)).toBe(false);
  });
  test("album search preserves the full shared URL and uses provider timeouts", () => {
    const query = `https://music.youtube.com/playlist?list=${youtubeId}&si=${"a".repeat(80)}`;
    expect(new URL(albumSearchPath(query), "https://music.test").searchParams.get("q")).toBe(query);
    expect(isProviderReadThroughRequest(albumSearchPath(query))).toBe(true);
    expect(apiReadTimeoutMs(albumSearchPath(query))).toBe(15_000);
    expect(isProviderReadThroughRequest(albumDetailPath({ provider: "youtube", id: youtubeId }))).toBe(true);
  });
});

describe("YouTube Music albums", () => {
  test("recognises the official Deluxe release, artwork and year from live provider metadata", () => {
    const albums = parseYouTubeAlbumSearch(youtubeSearch);
    expect(albums[0]).toMatchObject({ kind: "album", provider: "youtube", id: youtubeId, name: "÷ (Deluxe)", artist: "Ed Sheeran", releaseDate: "2017" });
    expect(albums[0].imageUrl).toContain("w544-h544");
    expect(albums).toHaveLength(2);
    expect(parseYouTubeAlbumSearch({ contents: { musicShelfRenderer: { contents: [...youtubeSearch.contents.musicShelfRenderer.contents, ...youtubeSearch.contents.musicShelfRenderer.contents] } } })).toHaveLength(2);
  });
  test("preserves all 16 official tracks in release order and exact video IDs", () => {
    const detail = parseYouTubeAlbumDetail(youtubeAlbum, youtubeId);
    expect(detail.album).toMatchObject({ name: "÷ (Deluxe)", artist: "Ed Sheeran", trackCount: 16, releaseDate: "2017" });
    expect(detail.tracks.map((track) => track.title)).toEqual(["Eraser", "Castle on the Hill", "Dive", "Shape of You", "Perfect", "Galway Girl", "Happier", "New Man", "Hearts Don't Break Around Here", "What Do I Know?", "How Would You Feel (Paean)", "Supermarket Flowers", "Barcelona", "Bibia Be Ye Ye", "Nancy Mulligan", "Save Myself"]);
    expect(detail.tracks[0]).toEqual({ videoId: "Xr5n32SkzGQ", title: "Eraser", artist: "Ed Sheeran", duration: 228 });
    expect(detail.tracks[3].videoId).toBe("ah4jxqEUekI");
    expect(detail.tracks.at(-1)?.duration).toBe(248);
  });
  test("treats malformed and empty album responses as failures", () => {
    expect(() => parseYouTubeAlbumDetail({}, youtubeId)).toThrow();
    expect(() => parseYouTubeAlbumDetail({ header: youtubeAlbum.header, contents: {} }, youtubeId)).toThrow();
    expect(parseYouTubeAlbumSearch({})).toEqual([]);
  });
});

describe("Spotify albums", () => {
  const trackId = "4uLU6hMCjMI75M1A2tKUQC";
  const album = { uri: `spotify:album:${spotifyId}`, name: "Divide", artists: { items: [{ profile: { name: "Ed Sheeran" } }] }, date: { year: 2017 }, coverArt: { sources: [{ url: "https://i.scdn.co/cover", width: 640 }] }, tracks: { totalCount: 1, items: [{ track: { uri: `spotify:track:${trackId}`, name: "Eraser", duration: { totalMilliseconds: 228000 } } }] } };
  test("reads albums only from album sections rather than incidental track credits", () => {
    expect(parseSpotifyAlbumSearch({ data: { searchV2: { tracksV2: { items: [album] }, albumsV2: { items: [{ data: album }] } } } })).toHaveLength(1);
    expect(parseSpotifyAlbumSearch({ data: { searchV2: { tracksV2: { items: [album] } } } })).toEqual([]);
  });
  test("handles nested track wrappers and retains album metadata on playback candidates", () => {
    const result = parseSpotifyAlbumCatalog({ data: { albumUnion: album } });
    expect(result.album).toMatchObject({ name: "Divide", artist: "Ed Sheeran", releaseDate: "2017", trackCount: 1 });
    expect(result.tracks[0]).toMatchObject({ id: trackId, name: "Eraser", artists: ["Ed Sheeran"], album: "Divide", durationMs: 228000, imageUrl: "https://i.scdn.co/cover" });
  });
  test("supports the Web API fallback shape", () => {
    const webAlbum = { id: spotifyId, name: "Divide", artists: [{ name: "Ed Sheeran" }], release_date: "2017-03-03", total_tracks: 1, images: [], tracks: { items: [{ id: trackId, name: "Eraser", duration_ms: 228000 }] } };
    expect(parseSpotifyAlbumSearch({ albums: { items: [webAlbum] } })[0].releaseDate).toBe("2017-03-03");
    expect(parseSpotifyAlbumCatalog(webAlbum).tracks[0].durationMs).toBe(228000);
  });
  test("reads current Pathfinder trackDuration and skips invalid legacy duration fields", () => {
    for (const duration of [
      { trackDuration: { totalMilliseconds: 225868 } },
      { trackDuration: { totalMilliseconds: "181270" }, duration: { totalMilliseconds: 0 } },
      { trackDuration: { totalMilliseconds: -1 }, duration: { totalMilliseconds: 225868 } },
      { duration: { totalMilliseconds: 0 }, durationMs: 225868 },
    ]) {
      const track = { uri: `spotify:track:${trackId}`, name: "Patient Zero", ...duration };
      const result = parseSpotifyAlbumCatalog({ data: { albumUnion: { ...album, tracks: { items: [{ track }] } } } });
      expect(result.tracks[0].durationMs).toBe(duration.trackDuration?.totalMilliseconds === "181270" ? 181270 : 225868);
    }
  });
});
