import { describe, expect, test } from "bun:test";
import {
  shouldForwardMacMiniUserForPathname,
  spotiflacStatusKeyForEndpoint,
} from "../src/worker/index";

describe("Mac mini proxy user forwarding", () => {
  test("forwards user context for local library reads", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/music/source")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/home")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/liked")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/songs")).toBe(true);
    expect(shouldForwardMacMiniUserForPathname("/api/songs/local-server%3Aabc123")).toBe(true);
  });

  test("does not steal Spotify import routes from the Worker", () => {
    expect(shouldForwardMacMiniUserForPathname("/api/songs/spotify")).toBe(false);
    expect(shouldForwardMacMiniUserForPathname("/api/songs/spotify/batch")).toBe(false);
  });
});

describe("SpotiFLAC status mapping", () => {
  test("maps spotbye resolver hosts to status keys", () => {
    expect(spotiflacStatusKeyForEndpoint("https://qbz-x.spotbye.qzz.io/api/dl")).toBe("qobuz_x");
    expect(spotiflacStatusKeyForEndpoint("https://amz-a.spotbye.qzz.io/api/dl")).toBe("amazon_a");
    expect(spotiflacStatusKeyForEndpoint("https://dzr-e.spotbye.qzz.io/api/dl")).toBe("deezer_e");
    expect(spotiflacStatusKeyForEndpoint("https://am.spotbye.qzz.io/api/dl")).toBe("apple");
    expect(spotiflacStatusKeyForEndpoint("https://provider.example.test/api/dl")).toBe("");
  });
});
