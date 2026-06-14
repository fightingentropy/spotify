import { apiFetch } from "@/lib/http";
import { isOfflinePlaybackSong, isRadioSong } from "@/lib/player-song";
import { useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

// Ported from src/client/play-events.ts. fetch → apiFetch; capacitor-file checks
// dropped (offline tracks are plain file:// in RN). The 30s-OR-≥50% threshold and
// the offline→canonical swap (so device-local URLs don't poison Home rails) stay.

const PLAY_EVENT_MIN_POSITION_SECONDS = 30;

function isRecordablePlayEventSong(song: PlayerSong): boolean {
  return !(
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    song.id.startsWith("browser-local:") ||
    song.id.startsWith("picked-file:") ||
    isRadioSong(song)
  );
}

function canonicalPlayEventSong(song: PlayerSong): PlayerSong | null {
  const base = (() => {
    if (!isOfflinePlaybackSong(song)) return song;
    const canonical = useOfflineStore.getState().records[song.id]?.song;
    if (!canonical || isOfflinePlaybackSong(canonical)) return null;
    return canonical;
  })();
  if (!base) return null;
  if (base.networkImageUrl === undefined) return base;
  const { networkImageUrl: _networkImageUrl, ...rest } = base;
  return rest;
}

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
  if (!isRecordablePlayEventSong(song)) return;
  const eventSong = canonicalPlayEventSong(song);
  if (!eventSong) return;
  // Fire-and-forget. No keepalive semantics in RN; a hard kill may drop the last
  // event (acceptable — the threshold means it had already been heard).
  void apiFetch("/api/play-events", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ song: eventSong, durationMs }),
  }).catch(() => {});
}

// Tracks the furthest position reached for the current song so the play-event can
// fire at the song-change boundary (where every advance path converges).
export type PlayListenEntry = {
  song: PlayerSong;
  maxPositionSeconds: number;
  durationSeconds: number;
  recorded: boolean;
  startedAtMs: number;
};

export function createPlayListen(song: PlayerSong): PlayListenEntry {
  return {
    song,
    maxPositionSeconds: 0,
    durationSeconds: song.duration ?? 0,
    recorded: false,
    startedAtMs: Date.now(),
  };
}

export function flushPlayListen(entry: PlayListenEntry | null): void {
  if (!entry || entry.recorded) return;
  if (!shouldRecordPlay(entry.maxPositionSeconds, entry.durationSeconds)) return;
  entry.recorded = true;
  recordPlayEvent(entry.song, Math.round(entry.maxPositionSeconds * 1000));
}
