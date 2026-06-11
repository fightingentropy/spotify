/**
 * Audio format conversion utilities for browser environment
 * Uses Web Audio API and client-side processing
 */

export type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

export interface ConversionOptions {
  format: OutputFormat;
  quality?: number; // 0-1 for lossy formats
  bitRate?: number; // kbps for MP3/AAC
  sampleRate?: number;
  channels?: number;
}

export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;
  genre?: string;
  releaseDate?: string;
  isrc?: string;
  upc?: string;
  composer?: string;
  publisher?: string;
  copyright?: string;
  duration?: number;
}

/**
 * Check if the browser supports the required audio conversion features
 */
export function isConversionSupported(): boolean {
  return !!(
    window.AudioContext ||
    (window as any).webkitAudioContext
  ) && !!window.MediaRecorder;
}

/**
 * Get supported output formats based on browser capabilities
 */
export function getSupportedFormats(): OutputFormat[] {
  const formats: OutputFormat[] = ["wav"]; // WAV is always supported via Web Audio API

  if (typeof MediaRecorder !== "undefined") {
    // Check for native MediaRecorder support
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      formats.push("opus");
    }
    if (MediaRecorder.isTypeSupported("audio/ogg;codecs=vorbis")) {
      formats.push("ogg");
    }
    if (MediaRecorder.isTypeSupported("audio/mp4;codecs=mp4a.40.2")) {
      formats.push("aac");
    }
    if (MediaRecorder.isTypeSupported("audio/mpeg")) {
      formats.push("mp3");
    }
  }

  return formats;
}

/**
 * Convert audio buffer to the specified format
 */
export async function convertAudioBuffer(
  audioBuffer: AudioBuffer,
  options: ConversionOptions,
  _metadata?: AudioMetadata
): Promise<Blob> {
  switch (options.format) {
    case "wav":
      return convertToWav(audioBuffer);
    case "ogg":
    case "opus":
      return convertWithMediaRecorder(audioBuffer, options);
    case "aac":
      return convertWithMediaRecorder(audioBuffer, options);
    default:
      return convertToWav(audioBuffer);
  }
}

/**
 * Convert audio file (ArrayBuffer) to the specified format
 */
export async function convertAudioFile(
  audioData: ArrayBuffer,
  options: ConversionOptions,
  _metadata?: AudioMetadata
): Promise<Blob> {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

  try {
    const audioBuffer = await audioContext.decodeAudioData(audioData.slice(0));
    return await convertAudioBuffer(audioBuffer, options, _metadata);
  } finally {
    await audioContext.close();
  }
}

/**
 * Convert AudioBuffer to WAV format
 */
function convertToWav(audioBuffer: AudioBuffer): Blob {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = audioBuffer.length * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // Convert audio data
  const channels: Float32Array[] = [];
  for (let i = 0; i < numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/**
 * Convert using MediaRecorder API (for OGG, Opus, AAC)
 */
async function convertWithMediaRecorder(
  audioBuffer: AudioBuffer,
  options: ConversionOptions
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Create MediaStreamAudioDestinationNode
    const destination = audioContext.createMediaStreamDestination();

    // Create buffer source
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(destination);

    // Determine MIME type
    let mimeType = "audio/webm;codecs=opus";
    if (options.format === "ogg") {
      mimeType = "audio/ogg;codecs=vorbis";
    } else if (options.format === "aac") {
      mimeType = "audio/mp4;codecs=mp4a.40.2";
    }

    // Check if the MIME type is supported
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      // Close the just-created context on this early-reject path so we don't leak
      // an AudioContext (browsers cap the number of live contexts).
      audioContext.close();
      reject(new Error(`Format ${options.format} not supported`));
      return;
    }

    const chunks: Blob[] = [];
    const mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType,
      audioBitsPerSecond: options.bitRate ? options.bitRate * 1000 : undefined,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      audioContext.close();
      resolve(blob);
    };

    mediaRecorder.onerror = () => {
      audioContext.close();
      reject(new Error("MediaRecorder error"));
    };

    mediaRecorder.start();
    source.start();

    // Stop recording after audio finishes
    setTimeout(() => {
      mediaRecorder.stop();
    }, (audioBuffer.duration + 0.1) * 1000);
  });
}

/**
 * Get file extension for format
 */
export function getExtensionForFormat(format: OutputFormat): string {
  switch (format) {
    case "flac": return ".flac";
    case "mp3": return ".mp3";
    case "aac": return ".m4a";
    case "ogg": return ".ogg";
    case "opus": return ".opus";
    case "wav": return ".wav";
    default: return ".flac";
  }
}
