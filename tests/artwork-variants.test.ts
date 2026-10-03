import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";
import { artworkWidth, getArtworkVariant } from "../src/server/artwork-variants";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(name = "cover.png", width = 800, height = 400) {
  const dir = await mkdtemp(join(tmpdir(), "spotify-artwork-test-"));
  directories.push(dir);
  const source = join(dir, name);
  await sharp({ create: { width, height, channels: 4, background: { r: 35, g: 130, b: 80, alpha: 0.8 } } }).png().toFile(source);
  return { dir, source, cache: join(dir, "cache") };
}

const sharpPrototype = Object.getPrototypeOf(sharp()) as { toFile: Sharp["toFile"] };

describe("artwork variants", () => {
  test("normalizes widths to bounded variants", () => {
    expect([null, "", "0", "-1", "not-a-number", "Infinity"].map(artworkWidth)).toEqual([null, null, null, null, null, null]);
    expect(["1", "64", "65", "129", "384", "400", "1024", "999999"].map(artworkWidth)).toEqual([64, 64, 128, 256, 384, 640, 1024, 1024]);
  });

  test("writes a smaller square WebP, preserves transparency and source bytes, and reuses the disk cache", async () => {
    const { source, cache } = await fixture();
    const originalBytes = await Bun.file(source).arrayBuffer();
    const convert = spyOn(sharpPrototype, "toFile");
    try {
      const output = await getArtworkVariant(source, cache, 128);
      const before = await stat(output);
      expect(output).not.toBe(source);
      expect((await sharp(output).metadata())).toMatchObject({ format: "webp", width: 128, height: 128, hasAlpha: true });
      expect(before.size).toBeLessThan((await stat(source)).size);
      expect(await getArtworkVariant(source, cache, 128)).toBe(output);
      expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
      expect(convert).toHaveBeenCalledTimes(1);
      expect(await Bun.file(source).arrayBuffer()).toEqual(originalBytes);
    } finally {
      convert.mockRestore();
    }
  });

  test("centre-crops a landscape cover at full square resolution", async () => {
    const { source, cache } = await fixture();
    const pixels = Buffer.alloc(800 * 400 * 4);
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 800; x++) {
        const offset = (y * 800 + x) * 4;
        pixels[offset + (x < 200 ? 0 : x >= 600 ? 2 : 1)] = 255;
        pixels[offset + 3] = 128;
      }
    }
    await sharp(pixels, { raw: { width: 800, height: 400, channels: 4 } }).png().toFile(source);
    const output = await getArtworkVariant(source, cache, 384);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 384, height: 384, channels: 4 });
    // Both corners and the centre should be inside the green middle square;
    // the red/blue side panels must be cropped, not squeezed into the result.
    for (const pixel of [0, Math.floor(info.width * info.height / 2), info.width * info.height - 1]) {
      const offset = pixel * info.channels;
      expect(data[offset]).toBeLessThan(12);
      expect(data[offset + 1]).toBeGreaterThan(240);
      expect(data[offset + 2]).toBeLessThan(12);
      expect(data[offset + 3]).toBeGreaterThanOrEqual(127);
      expect(data[offset + 3]).toBeLessThanOrEqual(129);
    }
  });

  test("ignores old landscape variants after the square cache version changes", async () => {
    const { source, cache } = await fixture();
    const sourceStat = await stat(source);
    const oldKey = createHash("sha256").update(`webp-v1:${source}:${sourceStat.size}:${sourceStat.mtimeMs}:128`).digest("hex");
    const oldOutput = join(cache, "variants", `${oldKey}.webp`);
    await mkdir(join(cache, "variants"), { recursive: true });
    await sharp(source).resize({ width: 128 }).webp().toFile(oldOutput);
    const output = await getArtworkVariant(source, cache, 128);
    expect(output).not.toBe(oldOutput);
    expect(await sharp(output).metadata()).toMatchObject({ width: 128, height: 128 });
    expect(await sharp(oldOutput).metadata()).toMatchObject({ width: 128, height: 64 });
  });

  test("never enlarges small source art", async () => {
    const { source, cache } = await fixture("small.png", 40, 20);
    const output = await getArtworkVariant(source, cache, 128);
    expect(await sharp(output).metadata()).toMatchObject({ width: 40, height: 20 });
  });

  test("invalidates variants after the source changes, including same-size timestamp updates", async () => {
    const { source, cache } = await fixture();
    const first = await getArtworkVariant(source, cache, 128);
    const previous = await stat(source);
    await utimes(source, previous.atime, new Date(previous.mtimeMs + 2_000));
    const second = await getArtworkVariant(source, cache, 128);
    expect(second).not.toBe(first);
    await sharp({ create: { width: 300, height: 600, channels: 3, background: "blue" } }).png().toFile(source);
    const third = await getArtworkVariant(source, cache, 128);
    expect(third).not.toBe(second);
    expect(await sharp(third).metadata()).toMatchObject({ format: "webp", width: 128, height: 128 });
  });

  test("deduplicates concurrent requests into exactly one real Sharp conversion", async () => {
    const { source, cache } = await fixture();
    const convert = spyOn(sharpPrototype, "toFile");
    try {
      const outputs = await Promise.all(Array.from({ length: 16 }, () => getArtworkVariant(source, cache, 256)));
      expect(new Set(outputs).size).toBe(1);
      expect(convert).toHaveBeenCalledTimes(1);
      expect(await readdir(join(cache, "variants"))).toEqual([outputs[0]!.split("/").pop()!]);
    } finally {
      convert.mockRestore();
    }
  });

  test("a cold grid of 16 covers all gets variants, with at most four active conversions", async () => {
    const { dir, source, cache } = await fixture();
    const sourceBytes = await Bun.file(source).arrayBuffer();
    const sources = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const path = join(dir, `cover-${index}.png`);
      await writeFile(path, new Uint8Array(sourceBytes));
      return path;
    }));
    const original = sharpPrototype.toFile;
    let active = 0;
    let maximumActive = 0;
    const convert = spyOn(sharpPrototype, "toFile").mockImplementation(function (this: Sharp, path: string) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      return original.call(this, path).finally(() => { active--; });
    } as Sharp["toFile"]);
    try {
      const outputs = await Promise.all(sources.map((path) => getArtworkVariant(path, cache, 128)));
      expect(outputs.every((path, index) => path !== sources[index] && path.endsWith(".webp"))).toBe(true);
      expect(convert).toHaveBeenCalledTimes(16);
      expect(maximumActive).toBeLessThanOrEqual(4);
      expect(maximumActive).toBeGreaterThan(1);
      expect((await readdir(join(cache, "variants"))).every((path) => path.endsWith(".webp"))).toBe(true);
      const metadata = await Promise.all(outputs.map((path) => sharp(path).metadata()));
      expect(metadata.every((value) => value.width === 128 && value.height === 128 && value.format === "webp")).toBe(true);
    } finally {
      convert.mockRestore();
    }
  });

  test("conversion failures clear the shared job and recover on the next attempt", async () => {
    const { source, cache } = await fixture();
    await writeFile(source, "not an image");
    const convert = spyOn(sharpPrototype, "toFile");
    try {
      await expect(getArtworkVariant(source, cache, 128)).rejects.toThrow();
      await expect(getArtworkVariant(source, cache, 128)).rejects.toThrow();
      expect(convert).toHaveBeenCalledTimes(2);
      expect(await readdir(join(cache, "variants"))).toEqual([]);
    } finally {
      convert.mockRestore();
    }
    await sharp({ create: { width: 200, height: 200, channels: 3, background: "red" } }).png().toFile(source);
    expect(await sharp(await getArtworkVariant(source, cache, 128)).metadata()).toMatchObject({ format: "webp", width: 128 });
  });

  test("removes an encoded temporary file if final rename fails, and can retry", async () => {
    const { source, cache } = await fixture();
    const sourceStat = await stat(source);
    const key = createHash("sha256").update(`square-v2:${source}:${sourceStat.size}:${sourceStat.mtimeMs}:128`).digest("hex");
    const blockedOutput = join(cache, "variants", `${key}.webp`);
    await mkdir(blockedOutput, { recursive: true });
    await expect(getArtworkVariant(source, cache, 128)).rejects.toThrow();
    expect(await readdir(join(cache, "variants"))).toEqual([`${key}.webp`]);
    await rm(blockedOutput, { recursive: true });
    expect(await getArtworkVariant(source, cache, 128)).toBe(blockedOutput);
    expect(await sharp(blockedOutput).metadata()).toMatchObject({ format: "webp", width: 128 });
  });
});
