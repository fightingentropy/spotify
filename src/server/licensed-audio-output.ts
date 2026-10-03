import { classifyAudioBytes, hasDolbyAtmosJoc } from "../lib/audio-codec-detect";
import type { LicensedSourceStream } from "../lib/licensed-source-download";

export function licensedAudioOutput(stream: LicensedSourceStream): {
  extension: "m4a" | "flac"; contentType: string; copyArgs: string[];
} {
  const spatial = stream.outputFormat === "m4a" || /^(?:ec-3|eac3|eac3_joc)$/i.test(stream.codec || "");
  return spatial
    ? {extension:"m4a",contentType:"audio/mp4",copyArgs:["-c:a","copy","-f","mp4","-movflags","+faststart"]}
    : {extension:"flac",contentType:"audio/flac",copyArgs:["-c:a","copy","-f","flac"]};
}

export function stagedAudioMatchesQuality(bytes: Uint8Array, quality?: "lossless" | "atmos"): boolean {
  const actual = classifyAudioBytes(bytes);
  return quality === "atmos" ? actual.codec === "ec-3" && hasDolbyAtmosJoc(bytes) : quality !== "lossless" || actual.quality === "lossless";
}
