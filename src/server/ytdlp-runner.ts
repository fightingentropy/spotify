import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

// Runs yt-dlp for the music server. Calls go to a long-lived Python helper
// (ytdlp-helper.py) that keeps yt-dlp loaded. On the mini that made a search
// ~0.5 s and a song's YouTube lookups ~0.8 s faster than the yt-dlp command.
// The helper takes the command's own arguments, so a call it can't run goes to
// the command unchanged. YT_DLP_HELPER=0 turns the helper off.

const execFileAsync = promisify(execFile);
const HELPER_SCRIPT = join(import.meta.dir, "ytdlp-helper.py");
const HELPER_START_TIMEOUT_MS = 15_000;
// After the helper fails to start or crashes, use the command for a while.
const HELPER_RETRY_MS = 5 * 60_000;

export type YtDlpCall = {
  ytDlpPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
};

export type HelperProcess = {
  send(line: string): void;
  kill(): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (detail: string) => void): void;
};

type RunnerDeps = {
  // The interpreter to run the helper with, or null to always use the command.
  helperCommand(ytDlpPath: string): string[] | null;
  spawnHelper(command: string[], env: NodeJS.ProcessEnv | undefined): HelperProcess;
  runCommand(call: YtDlpCall): Promise<string>;
  // Changes when yt-dlp updates itself, which needs a fresh helper.
  fileVersion(path: string): string;
  now(): number;
  startTimeoutMs?: number;
};

type HelperMessage =
  | { ready: true; version: string }
  | { ready: false; error: string }
  | { id: number; ok: true; stdout: string }
  | { id: number; ok: false; kind: "ytdlp" | "internal"; error: string };

// The helper can't run this call, but the command can. A fault means the helper
// itself is broken, rather than restarted or unable to run this one call.
class HelperUnavailable extends Error {
  constructor(message: string, readonly fault: boolean) {
    super(message);
  }
}

type PendingCall = {
  resolve(stdout: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  maxBuffer: number;
};

class YtDlpHelper {
  private readonly started: Promise<void>;
  private markStarted = () => {};
  private markFailed: (error: Error) => void = () => {};
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private failure: HelperUnavailable | null = null;
  private retired = false;

  constructor(private readonly process: HelperProcess, readonly version: string, startTimeoutMs: number) {
    this.started = new Promise<void>((resolve, reject) => {
      this.markStarted = resolve;
      this.markFailed = reject;
    });
    // close() rejects this whether or not a call is waiting for the start.
    this.started.catch(() => {});
    const startTimer = setTimeout(
      () => this.close(new HelperUnavailable("yt-dlp helper did not start", true)),
      startTimeoutMs,
    );
    process.onLine((line) => {
      let message: HelperMessage;
      try {
        message = JSON.parse(line) as HelperMessage;
      } catch {
        return;
      }
      if ("ready" in message) {
        clearTimeout(startTimer);
        if (message.ready) this.markStarted();
        else this.close(new HelperUnavailable(`yt-dlp helper could not load yt-dlp: ${message.error}`, true));
        return;
      }
      this.settle(message);
    });
    process.onExit((detail) => {
      clearTimeout(startTimer);
      this.close(new HelperUnavailable(`yt-dlp helper exited (${detail})`, true));
    });
  }

  get closed(): boolean {
    return this.failure !== null;
  }

  async run(args: string[], timeoutMs: number, maxBuffer: number): Promise<string> {
    await this.started;
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`yt-dlp timed out after ${timeoutMs} ms`));
        // The stuck job still holds one of the helper's workers, so start over.
        // Other calls in flight run again as the command.
        this.close(new HelperUnavailable("yt-dlp helper restarted after a timeout", false));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, maxBuffer });
      this.process.send(`${JSON.stringify({ id, args })}\n`);
    });
  }

  // yt-dlp updated itself: finish the calls in flight, then stop.
  retire(): void {
    this.retired = true;
    if (this.pending.size === 0) this.close(new HelperUnavailable("yt-dlp helper replaced", false));
  }

  private settle(message: Exclude<HelperMessage, { ready: boolean }>): void {
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (!message.ok) {
      call.reject(message.kind === "ytdlp" ? new Error(message.error) : new HelperUnavailable(message.error, false));
    } else if (message.stdout.length > call.maxBuffer) {
      call.reject(new Error("yt-dlp output exceeded maxBuffer"));
    } else {
      call.resolve(message.stdout);
    }
    if (this.retired && this.pending.size === 0) this.close(new HelperUnavailable("yt-dlp helper replaced", false));
  }

  close(error: HelperUnavailable): void {
    if (this.failure) return;
    this.failure = error;
    this.markFailed(error);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.process.kill();
  }
}

export function createYtDlpRunner(deps: RunnerDeps): { run(call: YtDlpCall): Promise<string>; close(): void } {
  const helpers = new Map<string, YtDlpHelper>();
  const retryAt = new Map<string, number>();

  async function run(call: YtDlpCall): Promise<string> {
    const command = deps.helperCommand(call.ytDlpPath);
    const key = JSON.stringify([call.ytDlpPath, command, call.env?.PATH ?? ""]);
    if (command && (retryAt.get(key) ?? 0) <= deps.now()) {
      const version = deps.fileVersion(call.ytDlpPath);
      let helper = helpers.get(key);
      if (helper && (helper.closed || helper.version !== version)) {
        helper.retire();
        helper = undefined;
      }
      if (!helper) {
        helper = new YtDlpHelper(
          deps.spawnHelper([...command, HELPER_SCRIPT, call.ytDlpPath], call.env),
          version,
          deps.startTimeoutMs ?? HELPER_START_TIMEOUT_MS,
        );
        helpers.set(key, helper);
      }
      try {
        return await helper.run(call.args, call.timeoutMs, call.maxBuffer);
      } catch (error) {
        if (!(error instanceof HelperUnavailable)) throw error;
        if (error.fault && (retryAt.get(key) ?? 0) <= deps.now()) {
          retryAt.set(key, deps.now() + HELPER_RETRY_MS);
          console.error(`${error.message}; using the yt-dlp command for now`);
        }
      }
    }
    return deps.runCommand(call);
  }

  return {
    run,
    close() {
      for (const helper of helpers.values()) helper.close(new HelperUnavailable("yt-dlp helper closed", false));
      helpers.clear();
    },
  };
}

// The yt-dlp file's own interpreter when it is a Python script: a zipapp, or a
// pip or Homebrew entry point. A packaged binary has none and uses the command.
export function helperInterpreter(ytDlpPath: string): string[] | null {
  if (process.env.YT_DLP_HELPER === "0" || !isAbsolute(ytDlpPath)) return null;
  const override = process.env.YT_DLP_PYTHON?.trim();
  if (override) return [override];
  let head: string;
  try {
    const fd = openSync(ytDlpPath, "r");
    try {
      const buffer = Buffer.alloc(256);
      head = buffer.toString("latin1", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const interpreter = /^#!(.*)/.exec(head)?.[1].trim().split(/\s+/) ?? [];
  return interpreter.some((part) => /python/i.test(part)) ? interpreter : null;
}

export function spawnHelperProcess(command: string[], env: NodeJS.ProcessEnv | undefined): HelperProcess {
  const child = spawn(command[0], command.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
  });
  // Writing after the helper exits fails; the exit itself is reported below.
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  return {
    send: (line) => {
      child.stdin.write(line);
    },
    kill: () => {
      child.kill();
    },
    onLine: (listener) => {
      lines.on("line", listener);
    },
    onExit: (listener) => {
      child.on("error", (error) => listener(error.message));
      child.on("exit", (code, signal) => {
        const lastLine = stderrTail.trim().split("\n").at(-1);
        listener(`${signal ?? `code ${code}`}${lastLine ? `: ${lastLine}` : ""}`);
      });
    },
  };
}

const runner = createYtDlpRunner({
  helperCommand: helperInterpreter,
  spawnHelper: spawnHelperProcess,
  runCommand: async (call) =>
    (await execFileAsync(call.ytDlpPath, call.args, { maxBuffer: call.maxBuffer, timeout: call.timeoutMs, env: call.env }))
      .stdout,
  fileVersion: (path) => {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  },
  now: Date.now,
});

export function runYtDlp(call: YtDlpCall): Promise<string> {
  return runner.run(call);
}
