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

// ETSI EC3SpecificBox carries the JOC complexity extension for Dolby Atmos.
// E-AC-3 by itself may be ordinary stereo/surround, so it is insufficient proof.
export function hasDolbyAtmosJoc(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = byteView(buffer);
  const jocDescriptor = (start: number, end: number): boolean => {
    let bit = start * 8;
    const take = (count: number): number => {
      if (bit + count > end * 8) throw new Error("Truncated EC3 descriptor");
      let value = 0;
      for (let n=0;n<count;n++,bit++) value=(value<<1)|((bytes[bit>>3]>>(7-(bit&7)))&1);
      return value;
    };
    try {
      take(13);
      const substreams=take(3)+1;
      for(let n=0;n<substreams;n++) {
        take(19);
        const dependent=take(4);
        take(dependent>0 ? 9 : 1);
      }
      return bit%8===0 && bit/8+2<=end && (take(8)&1)===1 && take(8)>0;
    } catch { return false; }
  };
  const walk = (start: number, end: number, depth: number): boolean => {
    if(depth>12) return false;
    for(let offset=start;offset+8<=end;) {
      const size32=readUint32(bytes,offset);
      const type=ascii(bytes,offset+4,4);
      const header=size32===1 ? 16 : 8;
      const size=size32===1 ? readUint64(bytes,offset+8) : size32===0 ? end-offset : size32;
      const stop=offset+size;
      if(size<header || stop>end || stop>bytes.length) return false;
      const content=offset+header;
      if(type==="stsd" && content+8<=stop) {
        const count=readUint32(bytes,content+4);
        let sample=content+8;
        for(let n=0;n<count && sample+36<=stop;n++) {
          const length=readUint32(bytes,sample);
          if(length<36 || sample+length>stop) break;
          if(ascii(bytes,sample+4,4)==="ec-3") {
            const version=(bytes[sample+16]<<8)|bytes[sample+17];
            const extra=version===1 ? 16 : version===2 ? 36 : 0;
            for(let child=sample+36+extra;child+8<=sample+length;) {
              const childSize=readUint32(bytes,child);
              if(childSize<8 || child+childSize>sample+length) break;
              if(ascii(bytes,child+4,4)==="dec3" && jocDescriptor(child+8,child+childSize)) return true;
              child+=childSize;
            }
          }
          sample+=length;
        }
      }
      if(MP4_CONTAINER_BOXES.has(type) && walk(content,stop,depth+1)) return true;
      offset=stop;
    }
    return false;
  };
  return walk(0,bytes.length,0);
}
