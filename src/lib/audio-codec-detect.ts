export type AudioQualityKind = "lossless" | "lossy" | "unknown";

export type AudioCodecInfo = {
  codec: string;
  quality: AudioQualityKind;
};

const LOSSLESS_MP4_CODECS = new Set(["alac", "flac", "fLaC", "lpcm", "sowt", "twos", "in24", "in32"]);
const LOSSY_MP4_CODECS = new Set(["mp4a", ".mp3", "ac-3", "ec-3", "opus", "Opus", "samr", "sawb"]);
const MP4_CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "dinf"]);

function byteView(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function readUint64(bytes: Uint8Array, offset: number): number {
  if (offset + 8 > bytes.length) return 0;
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : 0;
}

function parseStsdSampleEntry(bytes: Uint8Array, start: number, end: number): string {
  if (start + 8 > end) return "";
  const entryCount = readUint32(bytes, start + 4);
  let offset = start + 8;
  for (let index = 0; index < entryCount && offset + 8 <= end; index += 1) {
    const entrySize = readUint32(bytes, offset);
    const entryType = ascii(bytes, offset + 4, 4);
    if (entryType.trim()) return entryType;
    if (entrySize < 8) break;
    offset += entrySize;
  }
  return "";
}

function findMp4AudioSampleEntry(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth = 0,
): string {
  if (depth > 12) return "";
  let offset = start;
  while (offset + 8 <= end && offset + 8 <= bytes.length) {
    const size32 = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let boxEnd = size32 === 0 ? end : offset + size32;
    if (size32 === 1) {
      headerSize = 16;
      boxEnd = offset + readUint64(bytes, offset + 8);
    }
    if (!type.trim() || boxEnd <= offset + headerSize || boxEnd > end || boxEnd > bytes.length) break;

    const contentStart = offset + headerSize;
    if (type === "stsd") {
      const sampleEntry = parseStsdSampleEntry(bytes, contentStart, boxEnd);
      if (sampleEntry) return sampleEntry;
    }

    const childStart = type === "meta" ? contentStart + 4 : contentStart;
    if (MP4_CONTAINER_BOXES.has(type) && childStart < boxEnd) {
      const sampleEntry = findMp4AudioSampleEntry(bytes, childStart, boxEnd, depth + 1);
      if (sampleEntry) return sampleEntry;
    }

    offset = boxEnd;
  }
  return "";
}

function classifyMp4Codec(codec: string): AudioCodecInfo {
  if (!codec) return { codec: "", quality: "unknown" };
  if (LOSSLESS_MP4_CODECS.has(codec)) return { codec, quality: "lossless" };
  if (LOSSY_MP4_CODECS.has(codec)) return { codec, quality: "lossy" };
  return { codec, quality: "unknown" };
}

export function classifyAudioContentType(contentType: string): AudioCodecInfo {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (!normalized) return { codec: "", quality: "unknown" };
  if (normalized.includes("flac")) return { codec: "flac", quality: "lossless" };
  if (normalized.includes("wav") || normalized.includes("wave") || normalized.includes("aiff")) {
    return { codec: normalized, quality: "lossless" };
  }
  if (
    normalized.includes("mpeg") ||
    normalized.includes("mp3") ||
    normalized.includes("aac") ||
    normalized.includes("mp4a") ||
    normalized.includes("opus") ||
    normalized.includes("vorbis")
  ) {
    return { codec: normalized, quality: "lossy" };
  }
  return { codec: normalized, quality: "unknown" };
}

export function classifyAudioBytes(
  buffer: ArrayBuffer | Uint8Array,
  contentType = "",
): AudioCodecInfo {
  const bytes = byteView(buffer);
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") {
    return { codec: "flac", quality: "lossless" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return { codec: "wav", quality: "lossless" };
  }
  if (
    bytes.length >= 3 &&
    (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
  ) {
    return { codec: "mp3", quality: "lossy" };
  }

  const sampleEntry = findMp4AudioSampleEntry(bytes, 0, bytes.length);
  if (sampleEntry) return classifyMp4Codec(sampleEntry);

  return classifyAudioContentType(contentType);
}
