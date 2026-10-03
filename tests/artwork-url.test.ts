import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { artworkSrcSet, artworkVariantUrl } from "../src/lib/artwork-url";

describe("responsive artwork URLs", () => {
  test("changes only width, preserving signed paths and auth query bytes", () => {
    const pathname = "/api/files/local/Artist%20%2b%20B%2fCover%23%25.jpg";
    const signature = createHmac("sha256", "test-secret").update(pathname).digest("hex");
    const auth = `keep=%2f&spotify_user=user%20one&spotify_scope=shared&spotify_exp=1900000000&spotify_sig=${signature}`;
    expect(artworkVariantUrl(`${pathname}?${auth}&w=64&%77=128#fragment`, 384)).toBe(`${pathname}?${auth}&w=384`);
  });

  test("supports embedded local artwork without an image extension", () => {
    expect(artworkVariantUrl("/api/artwork/local/local-server%3Aabc%23%25%2B%3F%26?spotify_sig=signature", 128))
      .toBe("/api/artwork/local/local-server%3Aabc%23%25%2B%3F%26?spotify_sig=signature&w=128");
  });

  test("maps existing encoded R2 keys without double encoding slashes or percent signs", () => {
    expect(artworkVariantUrl("/api/files/music%2FArtist%20%2B%20B%2FCover%2520.jpg?version=a%2fb", 256))
      .toBe("/api/artwork/r2/music%2FArtist%20%2B%20B%2FCover%2520.jpg?version=a%2fb&w=256");
    expect(artworkVariantUrl("/api/artwork/r2/music/cover.jpg?w=64", 256))
      .toBe("/api/artwork/r2/music/cover.jpg?w=256");
  });

  test("leaves audio, documents, remote providers and static app assets alone", () => {
    for (const source of [
      "/api/files/local/song.flac", "/api/files/music/song.mp3?image=cover.jpg", "/api/files/music/song.m4a",
      "/api/files/local/lyrics.lrc", "/api/files/local/metadata.json", "https://i.scdn.co/image/cover.jpg",
      "//example.com/api/files/local/cover.jpg", "/covers/cover.jpg", "/api/profile/cover.jpg", "/apple-icon.png",
    ]) {
      expect(artworkVariantUrl(source, 256)).toBeNull();
      expect(artworkSrcSet(source)).toBeUndefined();
    }
  });

  test("rejects invalid widths and ignores fragment query text", () => {
    for (const width of [0, -1, NaN, Infinity]) expect(artworkVariantUrl("/api/files/local/cover.jpg", width)).toBeNull();
    expect(artworkVariantUrl("/api/files/local/cover.jpg#ignored?w=99", 128)).toBe("/api/files/local/cover.jpg?w=128");
  });

  test("provides consistent width descriptors for every allowed thumbnail size", () => {
    expect(artworkSrcSet("/api/files/local/cover.jpg?spotify_sig=keep%2fme")).toBe(
      [64, 128, 256, 384, 640, 1024].map((width) => `/api/files/local/cover.jpg?spotify_sig=keep%2fme&w=${width} ${width}w`).join(", "),
    );
  });
});
