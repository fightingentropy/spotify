import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { previousRestartsSong } from "../src/audio/previous-command";

describe("previous command", () => {
  test("goes to the previous song within the first 10 seconds", () => {
    for (const position of [0, 3, 9.9, 10]) expect(previousRestartsSong(position)).toBe(false);
  });

  test("restarts the song after 10 seconds", () => {
    for (const position of [10.01, 11, 240]) expect(previousRestartsSong(position)).toBe(true);
  });

  test("an unknown position goes to the previous song", () => {
    expect(previousRestartsSong(Number.NaN)).toBe(false);
  });

  test("live radio always goes to the previous station", () => {
    expect(previousRestartsSong(240, true)).toBe(false);
  });

  test("the Now Playing button, Android remote and iOS remote all use the rule", () => {
    const read = (path: string) => readFileSync(resolve(import.meta.dir, "../src", path), "utf8");
    expect(read("components/player/NowPlayingSheet.tsx")).toContain("onPress={() => void previousOrRestart()}");
    expect(read("audio/service.ts")).toContain("await previousOrRestart(position)");
    const actions = read("audio/actions.ts");
    expect(actions).toContain("previousRestartsSong(positionSeconds, live)");
    expect(actions).toContain("await seekTo(0)");
    const ios = read("audio/engine-native.ts");
    const prev = ios.slice(ios.indexOf('case "prev":'), ios.indexOf('case "seek":'));
    expect(prev).toContain("previousRestartsSong(");
    expect(prev).toContain("void seekNative(0)");
  });
});
