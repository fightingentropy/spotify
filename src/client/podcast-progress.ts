export type PodcastEpisodeProgress = {
  time: number;
  duration: number;
  updatedAt: number;
};

export const PODCAST_PROGRESS_STORAGE_KEY = "spotify_podcast_progress";
export const PODCAST_PROGRESS_MAX_ENTRIES = 200;
// Within this many seconds of the end (outro/credits) the episode counts as
// finished, so resume doesn't restart a completed episode at the very end.
export const PODCAST_FINISHED_TAIL_SECONDS = 30;
// Episodes this short have no meaningful outro tail; require nearly the full
// runtime instead so they aren't instantly "finished".
export const PODCAST_SHORT_EPISODE_SECONDS = 60;
export const PODCAST_SHORT_EPISODE_FINISHED_RATIO = 0.95;

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
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(PODCAST_PROGRESS_STORAGE_KEY);
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
    if (typeof window === "undefined") return;
    const entries = Object.entries(map);
    if (entries.length > PODCAST_PROGRESS_MAX_ENTRIES) {
      entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
      entries.length = PODCAST_PROGRESS_MAX_ENTRIES;
    }
    localStorage.setItem(PODCAST_PROGRESS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
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

export function writeEpisodeProgress(id: string, time: number, duration: number): void {
  if (!id || !Number.isFinite(time) || time < 0) return;
  const map = readProgressMap();
  map[id] = {
    time,
    duration: Number.isFinite(duration) && duration > 0 ? duration : map[id]?.duration ?? 0,
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
