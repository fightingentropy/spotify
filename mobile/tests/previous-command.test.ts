import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { previousRestartsSong } from "../src/audio/previous-command";

describe("headphone previous command", () => {
  test("goes to the previous song within the first 10 seconds", () => {
    for (const position of [0, 3, 9.9, 10]) expect(previousRestartsSong(position)).toBe(false);
  });

  test("restarts the song after 10 seconds", () => {
    for (const position of [10.01, 11, 240]) expect(previousRestartsSong(position)).toBe(true);
  });

  test("an unknown position goes to the previous song", () => {
    expect(previousRestartsSong(Number.NaN)).toBe(false);
  });

  test("the Android remote handler uses the rule", () => {
    const service = readFileSync(resolve(import.meta.dir, "../src/audio/service.ts"), "utf8");
    expect(service).toContain("previousRestartsSong(position)");
    expect(service).toContain("await seekTo(0)");
  });
});
