import { describe, expect, test } from "bun:test";
import { activeLyricIndex, parseLyrics } from "../src/lib/lrc";

const SAMPLE_LRC = `[ar:ABBA]
[ti:Voulez-Vous]
[al:ABBA Gold]
[00:12.34]People everywhere
[00:15.90]A sense of expectation hanging in the air
[00:21.05]
[00:24.50]Giving out a spark
[01:02.00]Masters of the scene
`;

describe("parseLyrics", () => {
  test("parses timestamped lines into a sorted synced list", () => {
    const parsed = parseLyrics(SAMPLE_LRC);
    expect(parsed.synced).not.toBeNull();
    expect(parsed.synced!).toHaveLength(5);
    expect(parsed.synced![0]).toEqual({ timeMs: 12_340, text: "People everywhere" });
    expect(parsed.synced![4]).toEqual({ timeMs: 62_000, text: "Masters of the scene" });
  });

  test("skips metadata tags and keeps them out of plain text", () => {
    const parsed = parseLyrics(SAMPLE_LRC);
    expect(parsed.plain).not.toContain("ABBA Gold");
    expect(parsed.plain).toContain("People everywhere");
  });

  test("keeps empty timestamped lines as instrumental gaps", () => {
    const parsed = parseLyrics(SAMPLE_LRC);
    expect(parsed.synced![2]).toEqual({ timeMs: 21_050, text: "" });
  });

  test("expands repeated-timestamp lines", () => {
    const parsed = parseLyrics("[00:10.00][00:30.00]chorus line\n[00:20.00]verse\n[00:25.00]more");
    expect(parsed.synced).not.toBeNull();
    expect(parsed.synced!.map((line) => line.timeMs)).toEqual([10_000, 20_000, 25_000, 30_000]);
    expect(parsed.synced![0].text).toBe("chorus line");
    expect(parsed.synced![3].text).toBe("chorus line");
  });

  test("applies the offset tag (positive shifts earlier)", () => {
    const parsed = parseLyrics("[offset:+500]\n[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
    expect(parsed.synced!.map((line) => line.timeMs)).toEqual([9_500, 19_500, 29_500]);
  });

  test("handles two-digit and three-digit fractions", () => {
    const parsed = parseLyrics("[00:01.5]a\n[00:02.50]b\n[00:03.500]c");
    expect(parsed.synced!.map((line) => line.timeMs)).toEqual([1_500, 2_500, 3_500]);
  });

  test("falls back to plain text when too few timestamps exist", () => {
    const parsed = parseLyrics("Just some words\n[00:10.00]one stray tag\nmore words");
    expect(parsed.synced).toBeNull();
    expect(parsed.plain).toContain("Just some words");
    expect(parsed.plain).toContain("one stray tag");
  });

  test("plain input stays plain and trimmed", () => {
    const parsed = parseLyrics("\n\nLine one\n\nLine two\n\n\n");
    expect(parsed.synced).toBeNull();
    expect(parsed.plain).toBe("Line one\n\nLine two");
  });

  test("empty input yields empty result", () => {
    expect(parseLyrics("")).toEqual({ synced: null, plain: "" });
    expect(parseLyrics("   \n  ")).toEqual({ synced: null, plain: "" });
  });

  test("rejects invalid seconds (>= 60)", () => {
    const parsed = parseLyrics("[00:75.00]bad\n[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
    expect(parsed.synced!.map((line) => line.timeMs)).toEqual([10_000, 20_000, 30_000]);
  });
});

describe("activeLyricIndex", () => {
  const lines = [
    { timeMs: 10_000, text: "a" },
    { timeMs: 20_000, text: "b" },
    { timeMs: 30_000, text: "c" },
  ];

  test("is -1 before the first line", () => {
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 9_999)).toBe(-1);
  });

  test("selects the last line whose time has passed", () => {
    expect(activeLyricIndex(lines, 10_000)).toBe(0);
    expect(activeLyricIndex(lines, 19_999)).toBe(0);
    expect(activeLyricIndex(lines, 20_000)).toBe(1);
    expect(activeLyricIndex(lines, 25_000)).toBe(1);
  });

  test("stays on the final line past the end", () => {
    expect(activeLyricIndex(lines, 30_000)).toBe(2);
    expect(activeLyricIndex(lines, 999_000)).toBe(2);
  });

  test("handles empty input", () => {
    expect(activeLyricIndex([], 5_000)).toBe(-1);
  });
});
