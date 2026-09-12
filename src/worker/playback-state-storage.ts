import { Buffer } from "node:buffer";
import { gzipSync, gunzipSync } from "node:zlib";
import type { PlaybackStateSnapshot } from "@/lib/playback-state";
import { ApiError } from "./http";

export const MAX_PLAYBACK_STATE_BYTES = 8 * 1024 * 1024;
// Leave room for the other columns below D1's 2 MB row limit.
export const MAX_PLAYBACK_STORAGE_BYTES = 1_500_000;
const COMPRESS_ABOVE_BYTES = 512_000;
const GZIP_PREFIX = "gzip-v1:";

export function encodePlaybackState(state: PlaybackStateSnapshot): string {
  const json = JSON.stringify(state);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_PLAYBACK_STATE_BYTES) throw new ApiError("Playback state is too large", 413);

  // This is a storage format only: clients still send and receive the full queue.
  // Keep small snapshots in their original format, including existing D1 rows.
  const stored = bytes > COMPRESS_ABOVE_BYTES
    ? GZIP_PREFIX + gzipSync(json).toString("base64")
    : json;
  if (Buffer.byteLength(stored) + Buffer.byteLength(state.deviceId) > MAX_PLAYBACK_STORAGE_BYTES) {
    throw new ApiError("Playback state is too large", 413);
  }
  return stored;
}

export function decodePlaybackState(value: string): unknown {
  let json = value;
  if (value.startsWith(GZIP_PREFIX)) {
    if (Buffer.byteLength(value) > MAX_PLAYBACK_STORAGE_BYTES) return null;
    json = gunzipSync(Buffer.from(value.slice(GZIP_PREFIX.length), "base64"), {
      maxOutputLength: MAX_PLAYBACK_STATE_BYTES,
    }).toString("utf8");
  } else if (Buffer.byteLength(value) > MAX_PLAYBACK_STATE_BYTES) {
    return null;
  }
  return JSON.parse(json);
}
