import { fetchLrclibLyrics } from "../../src/lib/download-lyrics";
import { fetchMiniDownloadLyrics } from "../../src/worker/download-lyrics";

const lyric = "First synthetic line\nSecond synthetic line\nThird synthetic line\nFourth synthetic line\nFifth synthetic line\nSixth synthetic line";

export default {
  async fetch() {
    let miniRequests = 0;
    const mini = await fetchMiniDownloadLyrics(
      { MAC_MINI_ORIGIN: "https://private.example.test", MAC_MINI_REQUEST_SIGNING_SECRET: "test-only" },
      { id: "test-user", email: "", name: null },
      "Example", "Artist", {},
      async options => {
        // Construct the real workerd Request, which rejects unsupported init
        // options before any network I/O. Bun's Request accepts redirect:error.
        const request = new Request("https://private.example.test/api/downloads/lyrics", options);
        miniRequests += 1;
        if (request.redirect !== "manual") throw new Error("A private request must not follow redirects");
        return Response.json({ lyrics: lyric });
      },
    );
    let lrclibRequests = 0;
    const direct = await fetchLrclibLyrics("Example", "Artist", {}, async (url, init) => {
      const request = new Request(url, init);
      lrclibRequests += 1;
      if (request.redirect !== "manual") throw new Error("A lyrics request must not follow redirects");
      return Response.json({ trackName: "Example", artistName: "Artist", plainLyrics: lyric });
    });
    return Response.json({ miniFound: mini === lyric, directFound: direct === lyric, miniRequests, lrclibRequests });
  },
};
