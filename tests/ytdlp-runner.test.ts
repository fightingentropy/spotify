import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createYtDlpRunner,
  helperInterpreter,
  spawnHelperProcess,
  type HelperProcess,
  type YtDlpCall,
} from "../src/server/ytdlp-runner";

// A full-suite `bun test` run cannot read child stdout (a file path argument
// can), so the real helper only runs when its replies reach this process.
const childStdoutReadable = spawnSync("/bin/echo", ["ok"]).stdout?.toString() === "ok\n";
const python = Bun.which("python3");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeHelper() {
  const sent: Array<{ id: number; args: string[] }> = [];
  let lineListener = (_line: string) => {};
  let exitListener = (_detail: string) => {};
  const helper = {
    sent,
    killed: false,
    reply: (message: unknown) => lineListener(JSON.stringify(message)),
    exit: (detail: string) => exitListener(detail),
    process: {
      send: (line: string) => {
        sent.push(JSON.parse(line));
      },
      kill: () => {
        helper.killed = true;
      },
      onLine: (listener: (line: string) => void) => {
        lineListener = listener;
      },
      onExit: (listener: (detail: string) => void) => {
        exitListener = listener;
      },
    } satisfies HelperProcess,
  };
  return helper;
}

function setup() {
  const state = { version: "1", now: 0 };
  const helpers: Array<ReturnType<typeof fakeHelper>> = [];
  const commands: YtDlpCall[] = [];
  const runner = createYtDlpRunner({
    helperCommand: () => ["python3"],
    spawnHelper: () => {
      helpers.push(fakeHelper());
      return helpers.at(-1)!.process;
    },
    runCommand: async (call) => {
      commands.push(call);
      return "from the command";
    },
    fileVersion: () => state.version,
    now: () => state.now,
    startTimeoutMs: 50,
  });
  const run = (args: string[], timeoutMs = 5_000) =>
    runner.run({ ytDlpPath: "/bin/yt-dlp", args, timeoutMs, maxBuffer: 1_000 });
  return { state, helpers, commands, run };
}

const tick = () => Bun.sleep(0);

describe("yt-dlp runner", () => {
  test("runs calls in one warm helper and returns what yt-dlp prints", async () => {
    const { helpers, commands, run } = setup();
    const first = run(["--flat-playlist", "-J", "ytsearch6:Artist Song"]);
    helpers[0].reply({ ready: true, version: "2026.08.19" });
    await tick();
    expect(helpers[0].sent[0].args).toEqual(["--flat-playlist", "-J", "ytsearch6:Artist Song"]);
    helpers[0].reply({ id: helpers[0].sent[0].id, ok: true, stdout: '{"entries":[]}' });
    expect(await first).toBe('{"entries":[]}');

    const second = run(["-x", "https://music.youtube.com/watch?v=abc123"]);
    await tick();
    helpers[0].reply({ id: helpers[0].sent[1].id, ok: true, stdout: "" });
    expect(await second).toBe("");
    expect(helpers).toHaveLength(1);
    expect(commands).toEqual([]);
  });

  test("reports a yt-dlp failure without running the command too", async () => {
    const { helpers, commands, run } = setup();
    const call = run(["-x", "https://music.youtube.com/watch?v=abc123"]);
    helpers[0].reply({ ready: true, version: "2026.08.19" });
    await tick();
    helpers[0].reply({ id: helpers[0].sent[0].id, ok: false, kind: "ytdlp", error: "ERROR: Requested format is not available" });

    await expect(call).rejects.toThrow("Requested format is not available");
    expect(commands).toEqual([]);
  });

  test("runs a call as the command when the helper fails it internally, and keeps the helper", async () => {
    const { helpers, commands, run } = setup();
    const call = run(["-J", "ytsearch6:Artist Song"]);
    helpers[0].reply({ ready: true, version: "2026.08.19" });
    await tick();
    helpers[0].reply({ id: helpers[0].sent[0].id, ok: false, kind: "internal", error: "RuntimeError: boom" });

    expect(await call).toBe("from the command");
    expect(commands).toHaveLength(1);
    expect(helpers[0].killed).toBe(false);
  });

  test("uses the command while the helper can't start, then tries the helper again", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { state, helpers, commands, run } = setup();
      const call = run(["-J", "ytsearch6:Artist Song"]);
      helpers[0].reply({ ready: false, error: "ModuleNotFoundError: No module named 'yt_dlp'" });
      expect(await call).toBe("from the command");

      expect(await run(["-J", "ytsearch6:Artist Song"])).toBe("from the command");
      expect(helpers).toHaveLength(1);
      expect(errors).toHaveBeenCalledTimes(1);

      state.now += 5 * 60_000;
      const retry = run(["-J", "ytsearch6:Artist Song"]);
      expect(helpers).toHaveLength(2);
      // A helper that never reports in counts as a failed start too.
      expect(await retry).toBe("from the command");
      expect(commands).toHaveLength(3);
    } finally {
      errors.mockRestore();
    }
  });

  test("runs calls in flight as the command when the helper crashes", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { helpers, commands, run } = setup();
      const call = run(["-x", "https://music.youtube.com/watch?v=abc123"]);
      helpers[0].reply({ ready: true, version: "2026.08.19" });
      await tick();
      helpers[0].exit("SIGKILL");

      expect(await call).toBe("from the command");
      expect(commands).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("starts a new helper after yt-dlp updates itself, and stops the old one once its calls finish", async () => {
    const { state, helpers, run } = setup();
    const before = run(["-x", "https://music.youtube.com/watch?v=one"]);
    helpers[0].reply({ ready: true, version: "2026.08.19" });
    await tick();

    state.version = "2";
    const after = run(["-x", "https://music.youtube.com/watch?v=two"]);
    expect(helpers).toHaveLength(2);
    expect(helpers[0].killed).toBe(false);

    helpers[0].reply({ id: helpers[0].sent[0].id, ok: true, stdout: "" });
    expect(await before).toBe("");
    expect(helpers[0].killed).toBe(true);

    helpers[1].reply({ ready: true, version: "2026.09.01" });
    await tick();
    helpers[1].reply({ id: helpers[1].sent[0].id, ok: true, stdout: "" });
    expect(await after).toBe("");
  });

  test("a timeout fails that call and restarts the helper; other calls in flight run as the command", async () => {
    const { helpers, commands, run } = setup();
    const slow = run(["-x", "https://music.youtube.com/watch?v=slow"], 20);
    const other = run(["-J", "ytsearch6:Artist Song"]);
    helpers[0].reply({ ready: true, version: "2026.08.19" });

    await expect(slow).rejects.toThrow("timed out");
    expect(await other).toBe("from the command");
    expect(helpers[0].killed).toBe(true);
    expect(commands.map((call) => call.args)).toEqual([["-J", "ytsearch6:Artist Song"]]);

    // A timeout is not the helper's fault, so the next call starts a new one.
    const next = run(["-J", "ytsearch6:Artist Song"]);
    expect(helpers).toHaveLength(2);
    helpers[1].reply({ ready: true, version: "2026.08.19" });
    await tick();
    helpers[1].reply({ id: helpers[1].sent[0].id, ok: true, stdout: "{}" });
    expect(await next).toBe("{}");
  });
});

describe("helper interpreter", () => {
  async function file(contents: string | Buffer): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "spotify-ytdlp-interpreter-"));
    directories.push(directory);
    const path = join(directory, "yt-dlp");
    await writeFile(path, contents);
    return path;
  }

  test("uses the interpreter a Python yt-dlp names", async () => {
    expect(helperInterpreter(await file("#!/usr/bin/env python3\nPK\u0003\u0004..."))).toEqual(["/usr/bin/env", "python3"]);
    expect(helperInterpreter(await file("#!/opt/homebrew/opt/python@3.13/bin/python3.13\nimport sys\n"))).toEqual([
      "/opt/homebrew/opt/python@3.13/bin/python3.13",
    ]);
  });

  test("leaves packaged binaries, other scripts and relative paths to the command", async () => {
    expect(helperInterpreter(await file(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00])))).toBeNull();
    expect(helperInterpreter(await file("#!/bin/sh\nexit 0\n"))).toBeNull();
    expect(helperInterpreter("yt-dlp")).toBeNull();
  });

  test("YT_DLP_HELPER=0 turns the helper off", async () => {
    const path = await file("#!/usr/bin/env python3\n");
    process.env.YT_DLP_HELPER = "0";
    try {
      expect(helperInterpreter(path)).toBeNull();
    } finally {
      delete process.env.YT_DLP_HELPER;
    }
  });
});

// A stand-in yt_dlp package with just the API the helper uses. Its download
// prints to stdout, which must not reach the server's replies.
const STUB_YT_DLP = {
  "__init__.py": `
from types import SimpleNamespace
from . import utils, version

def parse_options(args):
    urls = [arg for arg in args if not arg.startswith("-")]
    return SimpleNamespace(ydl_opts={"dump_single_json": "-J" in args}, urls=urls)

class YoutubeDL:
    def __init__(self, options):
        self.cookiejar = None
    def extract_info(self, url, download=True):
        return {"id": url, "entries": [{"id": "abc123"}]}
    def post_extract(self, info):
        pass
    def sanitize_info(self, info):
        return info
    def download(self, urls):
        if urls[0].endswith("fail"):
            raise utils.DownloadError("ERROR: no formats")
        print("[download] 100% of 7.41MiB")
        return 0
    def close(self):
        pass
`,
  "utils.py": `
class YoutubeDLError(Exception):
    pass

class DownloadError(YoutubeDLError):
    pass
`,
  "version.py": `__version__ = "stub"\n`,
};

test.skipIf(!childStdoutReadable || !python)("the helper runs yt-dlp's own arguments in one Python process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spotify-ytdlp-helper-"));
  directories.push(directory);
  await mkdir(join(directory, "yt_dlp"));
  for (const [name, source] of Object.entries(STUB_YT_DLP)) await writeFile(join(directory, "yt_dlp", name), source);
  const runner = createYtDlpRunner({
    helperCommand: () => [python!],
    spawnHelper: spawnHelperProcess,
    runCommand: () => Promise.reject(new Error("the command ran instead of the helper")),
    fileVersion: () => "1",
    now: Date.now,
  });
  const run = (args: string[]) => runner.run({ ytDlpPath: directory, args, timeoutMs: 10_000, maxBuffer: 1_000_000 });
  try {
    expect(JSON.parse(await run(["--flat-playlist", "-J", "ytsearch6:Artist Song"]))).toEqual({
      id: "ytsearch6:Artist Song",
      entries: [{ id: "abc123" }],
    });
    expect(await run(["-x", "-o", "audio.%(ext)s", "https://music.youtube.com/watch?v=abc123"])).toBe("");
    await expect(run(["-x", "https://music.youtube.com/watch?v=fail"])).rejects.toThrow("no formats");
  } finally {
    runner.close();
  }
});
