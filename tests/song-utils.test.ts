import { describe, expect, test } from "bun:test";
import { normalizeMediaUrl } from "../src/lib/song-utils";

describe("normalizeMediaUrl", () => {
  // Regression for the converted-folder signature break: a signed mini media URL
  // carries an HMAC (spotify_sig=) over the percent-ENCODED pathname. Decoding it
  // changes the path and 403s streaming/artwork for names with # % + ? &. Signed
  // URLs must round-trip BYTE-FOR-BYTE.
  test("passes signed mini URLs through verbatim", () => {
    const signed = [
      "/api/files/local/Song%20%231.flac?spotify_user=u&spotify_scope=lib&spotify_sig=abc123",
      "/api/files/local/100%25%20Real.flac?spotify_user=u&spotify_scope=lib&spotify_sig=def456",
      "/api/files/local/A%20%2B%20B.flac?spotify_user=u&spotify_scope=lib&spotify_sig=ghi789",
      "/api/files/local/Track%3F.flac?spotify_user=u&spotify_scope=lib&spotify_sig=jkl",
      "/api/files/local/Earth%2C%20Wind%20%26%20Fire.cover.jpg?spotify_user=u&spotify_scope=lib&spotify_sig=mno",
      "/api/files/local/Caf%C3%A9.flac?spotify_user=u&spotify_scope=lib&spotify_sig=pqr",
    ];
    for (const url of signed) {
      expect(normalizeMediaUrl(url)).toBe(url);
    }
  });

  test("still normalizes legacy unsigned double-encoded paths", () => {
    // No signature → legacy native-upload path: collapse double-encoding.
    expect(normalizeMediaUrl("/api/files/local/A%2520B.flac")).toBe("/api/files/local/A B.flac");
    expect(normalizeMediaUrl("/api/files/local/Ghetto%20-%20Akon.flac")).toBe(
      "/api/files/local/Ghetto - Akon.flac",
    );
  });

  test("leaves non-/api/files URLs and empties untouched", () => {
    expect(normalizeMediaUrl("https://example.com/x.flac?spotify_sig=z")).toBe(
      "https://example.com/x.flac?spotify_sig=z",
    );
    expect(normalizeMediaUrl("")).toBe("");
    expect(normalizeMediaUrl(null)).toBe("");
    expect(normalizeMediaUrl(undefined)).toBe("");
  });
});
