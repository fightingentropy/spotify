import { describe, expect, test } from "bun:test";
import { createDiscoverPrepareQueue } from "../src/server/discover-prepare-queue";
import { configureDiscover, handleDiscoverPrepare } from "../src/server/local-discover";
import type { LibrarySource } from "../src/server/local-library-scan";
import { catalogPreparePayload } from "../src/worker/discover";
import type { PlayerSong } from "../src/types/player";

function deferred() {
  let resolve!: (prepared: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("discover prepare queue", () => {
  test("waits for the top song to settle and prepares only the newest", async () => {
    const prepare = createDiscoverPrepareQueue({ settleMs: 50, retryMs: 1_000 });
    const prepared: string[] = [];
    const record = (key: string) => async () => {
      prepared.push(key);
      return true;
    };
    prepare("little", record("little"));
    // Without the settle time, "little" would have started by now.
    await Bun.sleep(10);
    prepare("little simz gorilla", record("little simz gorilla"));
    await Bun.sleep(100);
    expect(prepared).toEqual(["little simz gorilla"]);
  });

  test("prepares one song at a time and keeps only the newest one waiting", async () => {
    const prepare = createDiscoverPrepareQueue({ settleMs: 0, retryMs: 1_000 });
    const first = deferred();
    const prepared: string[] = [];
    prepare("first", () => {
      prepared.push("first");
      return first.promise;
    });
    await Bun.sleep(5);
    for (const key of ["second", "third"]) {
      prepare(key, async () => {
        prepared.push(key);
        return true;
      });
    }
    await Bun.sleep(5);
    expect(prepared).toEqual(["first"]);
    first.resolve(true);
    await Bun.sleep(5);
    expect(prepared).toEqual(["first", "third"]);
  });

  test("ignores a song that is already waiting or being prepared", async () => {
    const prepare = createDiscoverPrepareQueue({ settleMs: 10, retryMs: 1_000 });
    const running = deferred();
    let runs = 0;
    const song = () => {
      runs++;
      return running.promise;
    };
    prepare("song", song);
    prepare("song", song);
    await Bun.sleep(20);
    prepare("song", song);
    await Bun.sleep(20);
    expect(runs).toBe(1);
    running.resolve(true);
  });

  test("waits before trying a failed song again", async () => {
    const prepare = createDiscoverPrepareQueue({ settleMs: 0, retryMs: 100 });
    let runs = 0;
    const failing = async () => {
      runs++;
      throw new Error("no YouTube match");
    };
    prepare("song", failing);
    await Bun.sleep(5);
    prepare("song", failing);
    await Bun.sleep(5);
    expect(runs).toBe(1);
    await Bun.sleep(110);
    prepare("song", failing);
    await Bun.sleep(5);
    expect(runs).toBe(2);
  });
});

describe("search prepare request", () => {
  const song = (overrides: Partial<PlayerSong>): PlayerSong => ({
    id: "discover:0pJO1tc1GpnxFyQp6Zp82r",
    title: "Gorilla",
    artist: "Little Simz",
    album: "NO THANK YOU",
    imageUrl: "https://i.scdn.co/image/cover",
    audioUrl: "",
    duration: 245.819,
    source: "server",
    discoverTrackId: "0pJO1tc1GpnxFyQp6Zp82r",
    preview: true,
    ...overrides,
  });

  test("asks the mini to stage the top song when it is not staged", () => {
    expect(catalogPreparePayload([song({}), song({ discoverTrackId: "second" })])).toEqual({
      trackId: "0pJO1tc1GpnxFyQp6Zp82r",
      title: "Gorilla",
      artist: "Little Simz",
      album: "NO THANK YOU",
      imageUrl: "https://i.scdn.co/image/cover",
      durationMs: 245_819,
    });
  });

  test("prepares nothing when the top song already plays at once", () => {
    const staged = song({ id: "local-server:gorilla", audioUrl: "/api/files/local/.discover/gorilla.opus", staged: true });
    expect(catalogPreparePayload([staged, song({ discoverTrackId: "second" })])).toBeNull();
    expect(catalogPreparePayload([])).toBeNull();
  });
});

describe("mini prepare endpoint", () => {
  const source: LibrarySource = {
    key: "prepare-test", root: "/nonexistent/music", cachePath: "/nonexistent/cache/library.json",
    artworkDir: "/nonexistent/artwork", shared: true,
  };
  const configure = (userId: string | null, shared = true) => configureDiscover({
    librarySourceForRequest: () => ({ ...source, shared }),
    currentUserIdForRequest: () => userId,
    forbiddenLibraryResponse: () => new Response(null, { status: 403 }),
    notFound: () => new Response(null, { status: 404 }),
    ffmpegPath: () => "unused",
    materializeLicensedStreamToResponse: async () => new Response(null, { status: 500 }),
    licensedMediaRequestHeaders: () => ({}),
    signMediaUrl: (url) => url,
  });
  const request = (body: unknown) =>
    new Request("http://local/api/discover/prepare", { method: "POST", body: JSON.stringify(body) });

  test("needs a signed-in owner and a song to stage", async () => {
    configure(null);
    expect((await handleDiscoverPrepare(request({ trackId: "a", title: "Gorilla", artist: "Little Simz" }))).status).toBe(401);
    configure("owner", false);
    expect((await handleDiscoverPrepare(request({ trackId: "a", title: "Gorilla", artist: "Little Simz" }))).status).toBe(403);
    configure("owner");
    expect((await handleDiscoverPrepare(request({ trackId: "a", artist: "Little Simz" }))).status).toBe(400);
  });
});
