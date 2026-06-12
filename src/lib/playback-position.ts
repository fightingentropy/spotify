"use client";

// Window-event bridge between PlayerBar (which owns the audio elements and
// keeps position out of the zustand store to avoid 4Hz store churn) and
// satellite UIs like the desktop sidebar's synced lyrics.

export const PLAYBACK_POSITION_EVENT = "wf-playback-position";
export const PLAYBACK_SEEK_REQUEST_EVENT = "wf-playback-seek-request";

export type PlaybackPositionDetail = {
  currentTime: number;
  duration: number;
};

export function publishPlaybackPosition(detail: PlaybackPositionDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PlaybackPositionDetail>(PLAYBACK_POSITION_EVENT, { detail }));
}

export function subscribePlaybackPosition(
  callback: (detail: PlaybackPositionDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PlaybackPositionDetail>).detail;
    if (detail && typeof detail.currentTime === "number") callback(detail);
  };
  window.addEventListener(PLAYBACK_POSITION_EVENT, listener);
  return () => window.removeEventListener(PLAYBACK_POSITION_EVENT, listener);
}

export function requestPlaybackSeek(seconds: number): void {
  if (typeof window === "undefined" || !Number.isFinite(seconds)) return;
  window.dispatchEvent(new CustomEvent<number>(PLAYBACK_SEEK_REQUEST_EVENT, { detail: seconds }));
}
