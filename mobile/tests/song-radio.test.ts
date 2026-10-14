import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("native search autoplay: real store/controller regression scenarios", () => {
  // Isolate native boundary mocks and mobile's @/ aliases from the web tests.
  const directory = mkdtempSync(resolve(tmpdir(), "mobile-song-radio-"));
  const report = resolve(directory, "result.json");
  try {
    const child = spawnSync(process.execPath, ["run", "tests/fixtures/song-radio-scenarios.ts", report], {
      cwd: resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 15_000,
    });
    expect({ code: child.status, error: child.error }).toEqual({ code: 0, error: undefined });
    expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ passed: 15 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
