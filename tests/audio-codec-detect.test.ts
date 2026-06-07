import { describe, expect, test } from "bun:test";
import { classifyAudioBytes, classifyAudioContentType } from "../src/lib/audio-codec-detect";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function text(value: string): Uint8Array {
  return new Uint8Array([...value].map((char) => char.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  return bytes(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = concat(payloads);
  return concat([uint32(payload.length + 8), text(type), payload]);
}

function mp4WithAudioSampleEntry(codec: string): Uint8Array {
  const sampleEntry = box(codec, bytes(0, 0, 0, 0, 0, 0, 0, 1));
  const stsd = box("stsd", bytes(0, 0, 0, 0), uint32(1), sampleEntry);
  return concat([
    box("ftyp", text("M4A "), bytes(0, 0, 0, 0), text("M4A ")),
    box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd))))),
  ]);
}

describe("audio codec detection", () => {
  test("classifies AAC in MP4 as lossy", () => {
    expect(classifyAudioBytes(mp4WithAudioSampleEntry("mp4a"), "audio/mp4")).toEqual({
      codec: "mp4a",
      quality: "lossy",
    });
  });

  test("classifies FLAC in MP4 as lossless", () => {
    expect(classifyAudioBytes(mp4WithAudioSampleEntry("fLaC"), "audio/mp4")).toEqual({
      codec: "fLaC",
      quality: "lossless",
    });
  });

  test("classifies FLAC file signatures and lossy content types", () => {
    expect(classifyAudioBytes(text("fLaC"))).toEqual({ codec: "flac", quality: "lossless" });
    expect(classifyAudioContentType("audio/aac")).toEqual({ codec: "audio/aac", quality: "lossy" });
  });
});
