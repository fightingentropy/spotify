import { storage } from "@/lib/storage";

// Ported verbatim from src/client/podcast-progress.ts; localStorage → MMKV.
export type PodcastEpisodeProgress = {
  time: number;
  duration: number;
  updatedAt: number;
};

const PODCAST_PROGRESS_STORAGE_KEY = "spotify_podcast_progress";
const PODCAST_PROGRESS_MAX_ENTRIES = 200;
export const PODCAST_FINISHED_TAIL_SECONDS = 30;
const PODCAST_SHORT_EPISODE_SECONDS = 60;
const PODCAST_SHORT_EPISODE_FINISHED_RATIO = 0.95;
export const PODCAST_RESUME_MIN_SECONDS = 10;
export const PODCAST_PROGRESS_WRITE_INTERVAL_MS = 5000;

type ProgressMap = Record<string, PodcastEpisodeProgress>;

function coerceProgress(value: unknown): PodcastEpisodeProgress | null {
  if (!value || typeof value !== "object") return null;
  const { time, duration, updatedAt } = value as Record<string, unknown>;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return null;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return { time, duration, updatedAt };
}

function readProgressMap(): ProgressMap {
  try {
    const raw = storage.getItem(PODCAST_PROGRESS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: ProgressMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      const entry = coerceProgress(value);
      if (entry) map[id] = entry;
    }
    return map;
  } catch {
    return {};
  }
}

function writeProgressMap(map: ProgressMap): void {
  try {
    const entries = Object.entries(map);
    if (entries.length > PODCAST_PROGRESS_MAX_ENTRIES) {
      entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
      entries.length = PODCAST_PROGRESS_MAX_ENTRIES;
    }
    storage.setItem(PODCAST_PROGRESS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

export function isEpisodeFinished(progress: PodcastEpisodeProgress): boolean {
  const { time, duration } = progress;
  if (duration <= 0) return false;
  if (duration <= PODCAST_SHORT_EPISODE_SECONDS) {
    return time >= duration * PODCAST_SHORT_EPISODE_FINISHED_RATIO;
  }
  return time > duration - PODCAST_FINISHED_TAIL_SECONDS;
}

export function readEpisodeProgress(id: string): PodcastEpisodeProgress | null {
  if (!id) return null;
  return readProgressMap()[id] ?? null;
}

export function readAllEpisodeProgress(): ProgressMap {
  return readProgressMap();
}

// Guards against torn-down-element zero positions clobbering a real listen.
export function writeEpisodeProgressGuarded(id: string, time: number, duration: number): void {
  if (!id || !Number.isFinite(time) || time < 0) return;
  const map = readProgressMap();
  const existing = map[id];
  if (time < PODCAST_RESUME_MIN_SECONDS && existing && existing.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(existing)) {
    return;
  }
  map[id] = {
    time,
    duration: Number.isFinite(duration) && duration > 0 ? duration : existing?.duration ?? 0,
    updatedAt: Date.now(),
  };
  writeProgressMap(map);
}

export function markEpisodeFinished(id: string): void {
  const map = readProgressMap();
  const existing = map[id];
  if (!existing || existing.duration <= 0) return;
  map[id] = { ...existing, time: existing.duration, updatedAt: Date.now() };
  writeProgressMap(map);
}

export function clearEpisodeProgress(id: string): void {
  const map = readProgressMap();
  if (!(id in map)) return;
  delete map[id];
  writeProgressMap(map);
}
