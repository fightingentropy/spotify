import { describe, expect, test } from "bun:test";
import { stageDiscoverWithFallback } from "../src/worker/discover-stage";

describe("library download fallback", () => {
  test("keeps the provider result when it downloads successfully", async () => {
    const sources: unknown[] = [];
    const result = await stageDiscoverWithFallback({
      preview: false,
      resolve: async () => ({ streamUrl: "https://audio.example/song.flac" }),
      stage: async (source) => { sources.push(source); return Response.json({ audioUrl: "song.flac" }); },
    });
    expect(await result.json()).toEqual({ audioUrl: "song.flac" });
    expect(sources).toEqual([{ resolved: { streamUrl: "https://audio.example/song.flac" } }]);
  });

  test("downloads a keepable YouTube copy when provider resolution fails", async () => {
    const sources: unknown[] = [];
    const result = await stageDiscoverWithFallback({
      preview: false,
      resolve: async () => { throw new Error("SpotiFLAC overloaded"); },
      stage: async (source) => { sources.push(source); return Response.json({ audioUrl: "song.opus" }); },
    });
    expect(await result.json()).toEqual({ audioUrl: "song.opus" });
    expect(sources).toEqual([{ preview: true, libraryFallback: true }]);
  });

  for (const status of [503, 429, 408]) {
    test(`falls back once when the resolved file download fails with ${status}`, async () => {
      const sources: unknown[] = [];
      const result = await stageDiscoverWithFallback({
        preview: false,
        resolve: async () => "provider",
        stage: async (source) => {
          sources.push(source);
          return sources.length === 1 ? new Response("unavailable", { status }) : Response.json({ audioUrl: "song.m4a" });
        },
      });
      expect(await result.json()).toEqual({ audioUrl: "song.m4a" });
      expect(sources).toEqual([{ resolved: "provider" }, { preview: true, libraryFallback: true }]);
    });
  }

  test("propagates failure when both download sources fail", async () => {
    let calls = 0;
    const result = await stageDiscoverWithFallback({
      preview: false,
      resolve: async () => "provider",
      stage: async () => { calls++; return new Response("unavailable", { status: 503 }); },
    });
    expect(result.status).toBe(503);
    expect(calls).toBe(2);
  });

  test("does not retry an authentication failure as a download failure", async () => {
    let calls = 0;
    const result = await stageDiscoverWithFallback({
      preview: false,
      resolve: async () => "provider",
      stage: async () => { calls++; return new Response("unauthorized", { status: 401 }); },
    });
    expect(result.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("ordinary previews remain previews, while exact YouTube songs can be kept", async () => {
    const sources: unknown[] = [];
    const options = {
      preview: true,
      resolve: async () => { throw new Error("Playback must not call SpotiFLAC"); },
      stage: async (source: unknown) => { sources.push(source); return Response.json({}); },
    };
    await stageDiscoverWithFallback(options);
    await stageDiscoverWithFallback({ ...options, youtubeVideoId: "GsPq9mzFNGY" });
    expect(sources).toEqual([{ preview: true }, { preview: true, libraryFallback: true }]);
  });
});

test("explicit lossless-only downloads do not silently fall back", async () => {
  const seen: unknown[] = [];
  await expect(stageDiscoverWithFallback({
    preview: false,
    allowYouTubeFallback: false,
    resolve: async () => { throw new Error("Lossless source unavailable"); },
    stage: async (source) => { seen.push(source); return new Response("ok"); },
  })).rejects.toThrow("Lossless source unavailable");
  expect(seen).toEqual([]);
});

test("explicit YouTube library selection is eligible for promotion", async () => {
  const seen: unknown[] = [];
  await stageDiscoverWithFallback({
    preview: true,
    libraryFallback: true,
    resolve: async () => "unused",
    stage: async (source) => { seen.push(source); return new Response("ok"); },
  });
  expect(seen).toEqual([{preview:true,libraryFallback:true}]);
});
