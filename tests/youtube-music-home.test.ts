import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchYouTubeMusicHome,
  parseYouTubeMusicHomeShelves,
  youtubeCookiesFromJar,
  youtubeMusicAuthorization,
} from "../src/server/youtube-music-home";

const LIST_A = "RDTMAK5uy_kset8DisdE7LSD4TNjEVvrKRTmG7a56sY";
const LIST_B = "PLxPTYhtNDsDOfwHtPwvWCV8w6gqs8cAIL";

function runs(text: string) {
  return { runs: [{ text }] };
}

function playlist(listId: string, title: string, subtitle = "Mix • YouTube Music", thumbnail = "https://lh3.googleusercontent.com/abc=w226-h226-l90-rj") {
  return {
    musicTwoRowItemRenderer: {
      title: runs(title),
      subtitle: { runs: subtitle.split(" • ").flatMap((part, index) => index ? [{ text: " • " }, { text: part }] : [{ text: part }]) },
      thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://lh3.googleusercontent.com/abc=w60-h60" }, { url: thumbnail }] } } },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: `VL${listId}`,
          browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_PLAYLIST" } },
        },
      },
    },
  };
}

function album(browseId: string) {
  return {
    musicTwoRowItemRenderer: {
      title: runs("An album"),
      navigationEndpoint: {
        browseEndpoint: {
          browseId,
          browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } },
        },
      },
    },
  };
}

function shelf(title: string, contents: unknown[], strapline?: string) {
  return {
    musicCarouselShelfRenderer: {
      header: { musicCarouselShelfBasicHeaderRenderer: { title: runs(title), ...(strapline ? { strapline: runs(strapline) } : {}) } },
      contents,
    },
  };
}

describe("YouTube Music Home shelves", () => {
  test("keeps playlist cards in YouTube's order and drops everything else", () => {
    const shelves = parseYouTubeMusicHomeShelves([
      shelf("Listen again", [
        playlist("LM", "Liked Music"),
        playlist(LIST_A, "My Supermix"),
        album("MPREb_T5s950Swfdy"),
        { musicResponsiveListItemRenderer: {} },
        playlist(LIST_A, "My Supermix"),
      ]),
      shelf("Quick picks", [{ musicResponsiveListItemRenderer: {} }]),
      shelf("Timbaland", [playlist(LIST_B, "2000s hit", "A B • 85K views", "https://i.ytimg.com/vi/x/sddefault.jpg")], "Similar to"),
      { musicTastebuilderShelfRenderer: {} },
    ]);
    expect(shelves).toEqual([
      {
        id: "listen-again",
        title: "Listen again",
        playlists: [{
          id: `yt-mix-${LIST_A}`,
          name: "My Supermix",
          subtitle: "Mix • YouTube Music",
          imageUrl: "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj",
        }],
      },
      {
        id: "timbaland",
        title: "Timbaland",
        eyebrow: "Similar to",
        playlists: [{
          id: `yt-mix-${LIST_B}`,
          name: "2000s hit",
          subtitle: "A B • 85K views",
          imageUrl: "https://i.ytimg.com/vi/x/sddefault.jpg",
        }],
      },
    ]);
  });

  test("gives repeated shelf titles distinct ids and skips untrusted artwork", () => {
    const shelves = parseYouTubeMusicHomeShelves([
      shelf("Cosy Season 🍁", [playlist(LIST_A, "Autumn Feel", "Mix", "https://evil.example/cover.jpg")]),
      shelf("Cosy Season 🍁", [playlist(LIST_B, "Sweater Weather", "Mix", "https://music.youtube.com/image/mixart?r=abc")]),
      shelf("Mixed for you", [playlist(LIST_A, "My Supermix", "Mix", "https://music.youtube.com/watch?v=abc")]),
    ]);
    expect(shelves.map((entry) => entry.id)).toEqual(["cosy-season", "cosy-season-2", "mixed-for-you"]);
    expect(shelves[1]?.playlists[0]?.imageUrl).toBe("https://music.youtube.com/image/mixart?r=abc");
    // Only the mix-art path is trusted on music.youtube.com.
    expect(shelves[2]?.playlists[0]?.imageUrl).toBe("https://lh3.googleusercontent.com/abc=w544-h544");
    // The largest thumbnail is off-host, so the next trusted size is used.
    expect(shelves[0]?.playlists[0]?.imageUrl).toBe("https://lh3.googleusercontent.com/abc=w544-h544");
  });
});

describe("YouTube Music Home session", () => {
  test("reads only youtube.com cookies from a full browser jar", () => {
    const jar = [
      "# Netscape HTTP Cookie File",
      ".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsapisid-value",
      "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PSID\tpsid-value",
      ".claude.ai\tTRUE\t/\tTRUE\t0\tsessionKey\tsecret",
      ".notyoutube.com\tTRUE\t/\tTRUE\t0\tSID\tother",
      "music.youtube.com\tFALSE\t/\tTRUE\t0\tPREF\tf1=1",
    ].join("\n");
    expect([...youtubeCookiesFromJar(jar)]).toEqual([
      ["SAPISID", "sapisid-value"],
      ["__Secure-3PSID", "psid-value"],
      ["PREF", "f1=1"],
    ]);
  });

  test("signs requests the way the YouTube Music web client does", () => {
    expect(youtubeMusicAuthorization("abc", 1_700_000_000)).toBe(
      "SAPISIDHASH 1700000000_2f3ec011e870f3fbd0238c090c2062c208cead32",
    );
  });

  test("follows continuation pages as the configured account", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ytm-home-"));
    try {
      const cookiesFile = join(dir, "cookies.txt");
      await writeFile(cookiesFile, [
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsapisid-value",
        ".claude.ai\tTRUE\t/\tTRUE\t0\tsessionKey\tsecret",
      ].join("\n"));
      const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
      const pages = [
        {
          contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: {
            contents: [shelf("Listen again", [playlist(LIST_A, "My Supermix")])],
            continuations: [{ nextContinuationData: { continuation: "next/page" } }],
          } } } }] } },
        },
        {
          continuationContents: { sectionListContinuation: {
            contents: [shelf("From the community", [playlist(LIST_B, "2000s hit")])],
          } },
        },
      ];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return Response.json(pages[calls.length - 1]);
      }) as typeof fetch;

      const shelves = await fetchYouTubeMusicHome({ cookiesFile, authUser: "1", fetchImpl, nowSeconds: () => 1_700_000_000 });

      expect(shelves.map((entry) => entry.title)).toEqual(["Listen again", "From the community"]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.body.browseId).toBe("FEmusic_home");
      expect(calls[1]?.url).toContain("ctoken=next%2Fpage&continuation=next%2Fpage&type=next");
      for (const call of calls) {
        expect(call.headers.get("x-goog-authuser")).toBe("1");
        expect(call.headers.get("cookie")).toBe("SAPISID=sapisid-value");
        expect(call.headers.get("authorization")).toBe(youtubeMusicAuthorization("sapisid-value", 1_700_000_000));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
