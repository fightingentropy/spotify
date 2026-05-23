"use client";

import { useEffect, useRef, type RefObject } from "react";

type MediaSessionSong = {
  title: string;
  artist: string;
  imageUrl: string;
};

type UseMediaSessionOptions = {
  song: MediaSessionSong | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlay: () => void;
  onPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  audioRefs: Array<RefObject<HTMLAudioElement | null>>;
};

function resolveArtworkUrl(imageUrl: string): string {
  if (/^blob:|^data:/i.test(imageUrl)) {
    return `${location.origin}/icon-512.png`;
  }
  if (/^https?:/i.test(imageUrl)) return imageUrl;
  return `${location.origin}${imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`}`;
}

function clearActionHandlers(): void {
  if (!("mediaSession" in navigator)) return;
  const actions = ["play", "pause", "previoustrack", "nexttrack", "seekto"] as const;
  for (const action of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {}
  }
}

function registerActionHandlers(handlers: Pick<UseMediaSessionOptions, "onPlay" | "onPause" | "onPrevious" | "onNext" | "onSeek">): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => handlers.onPlay());
  navigator.mediaSession.setActionHandler("pause", () => handlers.onPause());
  navigator.mediaSession.setActionHandler("previoustrack", () => handlers.onPrevious());
  navigator.mediaSession.setActionHandler("nexttrack", () => handlers.onNext());
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime != null) handlers.onSeek(details.seekTime);
  });
}

export function useMediaSession({
  song,
  isPlaying,
  currentTime,
  duration,
  onPlay,
  onPause,
  onPrevious,
  onNext,
  onSeek,
  audioRefs,
}: UseMediaSessionOptions): void {
  const handlersRef = useRef({ onPlay, onPause, onPrevious, onNext, onSeek });

  useEffect(() => {
    handlersRef.current = { onPlay, onPause, onPrevious, onNext, onSeek };
  }, [onPlay, onPause, onPrevious, onNext, onSeek]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!song) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      return;
    }

    const artworkSrc = resolveArtworkUrl(song.imageUrl);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: "Waveform",
      artwork: [
        { src: artworkSrc, sizes: "512x512", type: "image/png" },
        { src: `${location.origin}/apple-icon.png`, sizes: "180x180", type: "image/png" },
      ],
    });
  }, [song?.title, song?.artist, song?.imageUrl, song]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !song) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying, song]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !song || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(Math.max(0, currentTime), duration),
      });
    } catch {}
  }, [currentTime, duration, song]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    let registered = false;
    const ensureHandlers = () => {
      if (registered) return;
      registered = true;
      registerActionHandlers(handlersRef.current);
    };

    const onPlaying = () => ensureHandlers();
    const elements = audioRefs
      .map((ref) => ref.current)
      .filter((element): element is HTMLAudioElement => element != null);

    for (const element of elements) {
      element.addEventListener("playing", onPlaying);
      if (!element.paused) ensureHandlers();
    }

    return () => {
      for (const element of elements) {
        element.removeEventListener("playing", onPlaying);
      }
      registered = false;
      clearActionHandlers();
    };
  }, [audioRefs, song?.title]);
}
