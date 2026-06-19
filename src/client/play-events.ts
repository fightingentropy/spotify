"use client";

import { isRadioSong } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

function isRecordablePlayEventSong(song: PlayerSong): boolean {
  return !(
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    song.id.startsWith("browser-local:") ||
    song.id.startsWith("picked-file:") ||
    isRadioSong(song)
  );
}

// networkImageUrl is a render-time cover fallback; snapshots should stay canonical.
function canonicalPlayEventSong(song: PlayerSong): PlayerSong {
  if (song.networkImageUrl === undefined) return song;
  const { networkImageUrl: _networkImageUrl, ...rest } = song;
  return rest;
}

const PLAY_EVENT_MIN_POSITION_SECONDS = 30;

export function shouldRecordPlay(maxPositionSeconds: number, durationSeconds?: number | null): boolean {
  if (!Number.isFinite(maxPositionSeconds) || maxPositionSeconds <= 0) return false;
  if (maxPositionSeconds >= PLAY_EVENT_MIN_POSITION_SECONDS) return true;
  return (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    maxPositionSeconds >= 0.5 * durationSeconds
  );
}

export function recordPlayEvent(song: PlayerSong, durationMs?: number): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (!isRecordablePlayEventSong(song)) return;
  const eventSong = canonicalPlayEventSong(song);
  // Fire-and-forget; sendBeacon is intentionally avoided (no credentials).
  fetch("/api/play-events", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ song: eventSong, durationMs }),
  }).catch(() => {});
}
