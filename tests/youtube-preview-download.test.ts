import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_YOUTUBE_PREVIEW_CONFIG,
  downloadYouTubePreviewAudioResilient,
  resolveYouTubePreviewMatch,
  type YouTubePreviewConfig,
} from "../src/server/youtube-preview";

const directories: string[] = [];
// A full-suite `bun test` run cannot read child stdout (a file path argument
// can), so search results are only checked when they reach this process.
const childStdoutReadable = spawnSync("/bin/echo", ["ok"]).stdout?.toString() === "ok\n";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// A stand-in yt-dlp that logs each call's arguments (tab-separated, one call per
// line) and fails a download whose player clients are listed in `failClients`.
// A signed-out search can fail, as when YouTube hides its results.
async function fakeYtDlp(
  failClients: string[],
  options: { failSignedOutSearch?: boolean } = {},
): Promise<{ config: YouTubePreviewConfig; calls: () => Promise<string[][]> }> {
  const directory = await mkdtemp(join(tmpdir(), "spotify-ytdlp-test-"));
  directories.push(directory);
  const log = join(directory, "calls.log");
  const script = join(directory, "yt-dlp");
  await writeFile(script, `#!/bin/sh
for arg in "$@"; do printf '%s\\t' "$arg"; done >> '${log}'
printf '\\n' >> '${log}'
case " $* " in *" --flat-playlist "*)
  case " $* " in *" --cookies "*) ;; *) [ "${options.failSignedOutSearch ? 1 : 0}" = 1 ] && exit 1;; esac
  printf '%s' '{"entries":[{"id":"abc123","title":"Song","channel":"Artist - Topic","duration":200}]}'
  exit 0;;
esac
clients=anonymous; previous=""; output=""
for arg in "$@"; do
  [ "$previous" = "--extractor-args" ] && clients="\${arg#youtube:player_client=}"
  [ "$previous" = "-o" ] && output="$arg"
  previous="$arg"
done
for failing in ${failClients.join(" ")}; do [ "$clients" = "$failing" ] && exit 1; done
printf '%s' "$clients" > "$(printf '%s' "$output" | sed 's/%(ext)s/opus/')"
`);
  await chmod(script, 0o755);
  return {
    config: { ...DEFAULT_YOUTUBE_PREVIEW_CONFIG, ytDlpPath: script, cookiesFile: join(directory, "cookies.txt") },
    calls: async () => (await readFile(log, "utf8")).split("\n").slice(0, -1).map((line) => line.split("\t").slice(0, -1)),
  };
}

function clientsUsed(args: string[]): string {
  if (!args.includes("--extractor-args")) return "anonymous";
  return args[args.indexOf("--extractor-args") + 1].replace("youtube:player_client=", "");
}

const song = { title: "Song", artist: "Artist", durationMs: 200_000 };

describe("YouTube preview match", () => {
  test.skipIf(!childStdoutReadable)("a signed-out match skips the signed-in search", async () => {
    const { config, calls } = await fakeYtDlp([]);

    expect((await resolveYouTubePreviewMatch(song, config))?.videoId).toBe("abc123");
    expect((await calls()).map((args) => args.includes("--cookies"))).toEqual([false]);
  });

  test("searches signed in when the signed-out search finds no match", async () => {
    const { config, calls } = await fakeYtDlp([], { failSignedOutSearch: true });
    const match = await resolveYouTubePreviewMatch(song, config);

    expect((await calls()).map((args) => args.includes("--cookies"))).toEqual([false, true]);
    if (childStdoutReadable) expect(match?.videoId).toBe("abc123");
  });

  test("searches once when there are no cookies", async () => {
    const { config, calls } = await fakeYtDlp([], { failSignedOutSearch: true });

    expect(await resolveYouTubePreviewMatch(song, { ...config, cookiesFile: undefined })).toBeNull();
    expect(await calls()).toHaveLength(1);
  });
});

describe("YouTube preview download", () => {
  test("downloads Premium audio through the Music client alone first", async () => {
    const { config, calls } = await fakeYtDlp([]);
    const audio = await downloadYouTubePreviewAudioResilient("abc123", config);

    expect(audio.bytes.toString()).toBe("web_music");
    const [download, ...rest] = await calls();
    expect(rest).toEqual([]);
    expect(download).toContain("--cookies");
    expect(download.at(-1)).toBe("https://music.youtube.com/watch?v=abc123");
  });

  test("falls back to the default clients, then to an anonymous download", async () => {
    const withDefault = await fakeYtDlp(["web_music"]);
    expect((await downloadYouTubePreviewAudioResilient("abc123", withDefault.config)).bytes.toString()).toBe("web_music,default");
    expect((await withDefault.calls()).map(clientsUsed)).toEqual(["web_music", "web_music,default"]);

    const anonymous = await fakeYtDlp(["web_music", "web_music,default"]);
    expect((await downloadYouTubePreviewAudioResilient("abc123", anonymous.config)).bytes.toString()).toBe("anonymous");
    const anonymousCalls = await anonymous.calls();
    expect(anonymousCalls.map(clientsUsed)).toEqual(["web_music", "web_music,default", "anonymous"]);
    expect(anonymousCalls[2]).not.toContain("--cookies");
    expect(anonymousCalls[2].at(-1)).toBe("https://www.youtube.com/watch?v=abc123");
  });

  test("a download without cookies makes a single anonymous attempt", async () => {
    const { config, calls } = await fakeYtDlp([]);
    await downloadYouTubePreviewAudioResilient("abc123", { ...config, cookiesFile: undefined });

    expect((await calls()).map(clientsUsed)).toEqual(["anonymous"]);
  });
});
