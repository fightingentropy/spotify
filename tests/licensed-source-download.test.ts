import { afterEach, describe, expect, test } from "bun:test";
import {
  LicensedSourceDownloadError,
  resolveLicensedSourceStreamUrl,
} from "../src/lib/licensed-source-download";

const originalFetch = globalThis.fetch;

describe("licensed source downloader", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts Spotify metadata and reads a JSON stream URL", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        streamUrl: "https://media.example.test/song.flac",
        headers: { "x-provider-token": "stream-token" },
        contentType: "audio/flac",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const stream = await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://provider.example.test/resolve",
      apiKey: "provider-key",
      spotifyId: "0BRwoCBQR3azPbxoIjF0yR",
      spotifyUrl: "https://open.spotify.com/track/0BRwoCBQR3azPbxoIjF0yR",
      region: "us",
      title: "Lola's Theme",
      artist: "The Shapeshifters",
      qualityProfile: "max",
      outputFormat: "flac",
    });

    expect(requestUrl).toBe("https://provider.example.test/resolve");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      spotifyId: "0BRwoCBQR3azPbxoIjF0yR",
      region: "US",
      title: "Lola's Theme",
      artist: "The Shapeshifters",
      qualityProfile: "max",
      outputFormat: "flac",
    });
    expect(stream).toEqual({
      kind: "url",
      streamUrl: "https://media.example.test/song.flac",
      headers: { "x-provider-token": "stream-token" },
      contentType: "audio/flac",
      metadata: {},
      dash: undefined,
    });
  });

  test("accepts a plain signed URL response", async () => {
    globalThis.fetch = (async () =>
      new Response("https://media.example.test/signed.flac", { status: 200 })) as unknown as typeof fetch;

    const stream = await resolveLicensedSourceStreamUrl({
      endpointUrl: "https://provider.example.test/resolve",
      spotifyId: "spotify-track",
      spotifyUrl: "https://open.spotify.com/track/spotify-track",
    });

    expect(stream.kind).toBe("url");
    expect(stream.streamUrl).toBe("https://media.example.test/signed.flac");
  });

  test("fails clearly when the provider is not configured", async () => {
    await expect(resolveLicensedSourceStreamUrl({
      endpointUrl: "",
      spotifyId: "spotify-track",
      spotifyUrl: "https://open.spotify.com/track/spotify-track",
    })).rejects.toMatchObject({
      message: "Licensed source provider is not configured",
      status: 501,
    } satisfies Partial<LicensedSourceDownloadError>);
  });
});
