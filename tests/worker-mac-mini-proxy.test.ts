import { describe, expect, test } from "bun:test";
import { shouldForwardMacMiniUserForPathname } from "../src/worker/index";

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
