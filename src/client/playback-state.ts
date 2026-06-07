"use client";

import {
  PLAYBACK_DEVICE_ID_STORAGE_KEY,
  PLAYBACK_STATE_STORAGE_KEY,
  PLAYBACK_STATE_VERSION,
  type PlaybackStateSnapshot,
} from "@/lib/playback-state";
import { isPersistablePlayerSong } from "@/lib/player-persistence";
import type { PlayerSong } from "@/types/player";

type PlaybackStateResponse = {
  state?: unknown;
};

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coercePlayerSong(value: unknown): PlayerSong | null {
  const payload = toObject(value);
  if (!payload) return null;
  const id = toStringValue(payload.id);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const audioUrl = toStringValue(payload.audioUrl);
  if (!id || !title || !artist || !audioUrl) return null;
  const album = toStringValue(payload.album);
  const imageUrl = toStringValue(payload.imageUrl) || "/apple-icon.png";
  const lyricsUrl = toStringValue(payload.lyricsUrl);
  const description = toStringValue(payload.description);
  const link = toStringValue(payload.link);
  const createdAt = toStringValue(payload.createdAt);
  const source = toStringValue(payload.source);
  const localPath = toStringValue(payload.localPath);
  const duration = toNumberValue(payload.duration);
  const audioBitDepth = toNumberValue(payload.audioBitDepth);
  const audioSampleRate = toNumberValue(payload.audioSampleRate);
  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl,
    audioUrl,
    lyricsUrl: lyricsUrl || undefined,
    description: description || undefined,
    link: link || undefined,
    createdAt: createdAt || undefined,
    duration: duration ?? undefined,
    audioBitDepth: audioBitDepth ?? undefined,
    audioSampleRate: audioSampleRate ?? undefined,
    source: source ? (source as PlayerSong["source"]) : undefined,
    localPath: localPath || undefined,
  };
}

function randomDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getPlaybackDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const stored = localStorage.getItem(PLAYBACK_DEVICE_ID_STORAGE_KEY);
    if (stored) return stored;
    const id = randomDeviceId();
    localStorage.setItem(PLAYBACK_DEVICE_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return randomDeviceId();
  }
}

export function coercePlaybackState(value: unknown, fallbackUpdatedAt = 0): PlaybackStateSnapshot | null {
  const payload = toObject(value);
  if (!payload) return null;

  const rawQueue = Array.isArray(payload.queue) ? payload.queue : [];
  const queue = rawQueue
    .map(coercePlayerSong)
    .filter((song): song is PlayerSong => Boolean(song && isPersistablePlayerSong(song)));
  const payloadSong = coercePlayerSong(payload.song);
  const song = payloadSong && isPersistablePlayerSong(payloadSong)
    ? payloadSong
    : queue[Math.max(0, Math.min(queue.length - 1, Math.floor(toNumberValue(payload.currentIndex) ?? 0)))] ?? null;
  if (!song) return null;

  const queueWithSong = queue.some((item) => item.id === song.id) ? queue : [song, ...queue];
  const indexFromPayload = Math.floor(toNumberValue(payload.currentIndex) ?? -1);
  const indexFromSong = queueWithSong.findIndex((item) => item.id === song.id);
  const currentIndex = indexFromSong >= 0
    ? indexFromSong
    : Math.max(0, Math.min(queueWithSong.length - 1, indexFromPayload));
  const currentTime = Math.max(0, toNumberValue(payload.currentTime) ?? 0);
  const updatedAt = Math.max(0, toNumberValue(payload.updatedAt) ?? fallbackUpdatedAt);
  const accountScope = toStringValue(payload.accountScope) || "anonymous";
  const deviceId = toStringValue(payload.deviceId) || getPlaybackDeviceId();

  return {
    version: PLAYBACK_STATE_VERSION,
    accountScope,
    queue: queueWithSong,
    currentIndex,
    song,
    currentTime,
    isPlaying: payload.isPlaying === true,
    updatedAt,
    deviceId,
  };
}

export function readLocalPlaybackState(): PlaybackStateSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PLAYBACK_STATE_STORAGE_KEY);
    return raw ? coercePlaybackState(JSON.parse(raw), 0) : null;
  } catch {
    return null;
  }
}

export function writeLocalPlaybackState(state: PlaybackStateSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PLAYBACK_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function removeLocalPlaybackState(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PLAYBACK_STATE_STORAGE_KEY);
  } catch {}
}

export async function fetchServerPlaybackState(): Promise<PlaybackStateSnapshot | null> {
  const response = await fetch("/api/playback-state", {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error("Could not fetch playback state");
  const payload = await response.json() as PlaybackStateResponse;
  return coercePlaybackState(payload.state, 0);
}

export async function writeServerPlaybackState(
  state: PlaybackStateSnapshot,
  options?: { keepalive?: boolean },
): Promise<PlaybackStateSnapshot | null> {
  const response = await fetch("/api/playback-state", {
    method: "PUT",
    credentials: "include",
    cache: "no-store",
    keepalive: options?.keepalive,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ state }),
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error("Could not write playback state");
  const payload = await response.json() as PlaybackStateResponse;
  return coercePlaybackState(payload.state, state.updatedAt);
}
