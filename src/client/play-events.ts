"use client";

import { isCapacitorFileUrl } from "@/client/capacitor-offline";
import { useOfflineStore } from "@/client/offline";
import { isOfflinePlaybackSong, isRadioSong } from "@/lib/player-song";
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

function isOfflineResolvedSong(song: PlayerSong): boolean {
  return isOfflinePlaybackSong(song) || isCapacitorFileUrl(song.audioUrl);
}

// Offline-resolved songs carry device-local URLs (capacitor file paths on
// native, ?spotify_offline=1 rewrites on web) that would poison the Home rails
// for every client. Swap in the canonical pre-resolution song kept on the
// download record; with no record there's nothing safe to record.
function canonicalPlayEventSong(song: PlayerSong): PlayerSong | null {
  const base = (() => {
    if (!isOfflineResolvedSong(song)) return song;
    const canonical = useOfflineStore.getState().records[song.id]?.song;
    if (!canonical || isOfflineResolvedSong(canonical)) return null;
    return canonical;
  })();
  if (!base) return null;
  // networkImageUrl is a render-time fallback derived during offline
  // resolution; snapshots should stay canonical.
  if (base.networkImageUrl === undefined) return base;
  const { networkImageUrl: _networkImageUrl, ...rest } = base;
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
  if (!eventSong) return;
  // Fire-and-forget. Relative /api works on native because window.fetch is
  // patched by CapacitorHttp; navigator.sendBeacon is not, so never use it.
  fetch("/api/play-events", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ song: eventSong, durationMs }),
  }).catch(() => {});
}
