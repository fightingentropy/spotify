import { describe, expect, test } from "bun:test";
import { assertValidImageBlob, looksLikeImageBytes } from "../src/client/capacitor-offline";

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(Math.max(12, values.length)));
  out.set(values);
  return out;
}

const JPEG_HEADER = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01);
const PNG_HEADER = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const GIF_HEADER = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00);
const WEBP_HEADER = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);

describe("looksLikeImageBytes", () => {
  test("accepts real image headers", () => {
    expect(looksLikeImageBytes(JPEG_HEADER)).toBe(true);
    expect(looksLikeImageBytes(PNG_HEADER)).toBe(true);
    expect(looksLikeImageBytes(GIF_HEADER)).toBe(true);
    expect(looksLikeImageBytes(WEBP_HEADER)).toBe(true);
  });

  test("rejects persisted HTTP error bodies (the poisoning case)", () => {
    const jsonBody = new TextEncoder().encode('{"error":"Unauthorized"}');
    const htmlBody = new TextEncoder().encode("<!DOCTYPE html><html><body>502</body></html>");
    expect(looksLikeImageBytes(jsonBody)).toBe(false);
    expect(looksLikeImageBytes(htmlBody)).toBe(false);
  });

  test("rejects empty and truncated data", () => {
    expect(looksLikeImageBytes(new Uint8Array(0))).toBe(false);
    expect(looksLikeImageBytes(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  test("rejects RIFF containers that are not WebP (e.g. WAV audio)", () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(looksLikeImageBytes(wav)).toBe(false);
  });
});

describe("assertValidImageBlob", () => {
  test("passes a valid JPEG blob", async () => {
    const blob = new Blob([JPEG_HEADER, new Uint8Array(64)]);
    await expect(assertValidImageBlob(blob)).resolves.toBeUndefined();
  });

  test("throws for an empty blob", async () => {
    await expect(assertValidImageBlob(new Blob([]))).rejects.toThrow("empty");
  });

  test("throws for a JSON error body saved as an image", async () => {
    const blob = new Blob([new TextEncoder().encode('{"error":"Forbidden"}')]);
    await expect(assertValidImageBlob(blob)).rejects.toThrow("not a valid image");
  });
});
