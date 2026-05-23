"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

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
  getActiveAudio: () => HTMLAudioElement | null;
  audioRefs: Array<RefObject<HTMLAudioElement | null>>;
};

function resolveArtworkUrl(imageUrl: string): string {
  if (/^blob:|^data:/i.test(imageUrl)) {
    return `${location.origin}/waveform-pwa-icon-512.png`;
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

function registerActionHandlers(
  handlers: Pick<UseMediaSessionOptions, "onPlay" | "onPause" | "onPrevious" | "onNext" | "onSeek">,
): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => handlers.onPlay());
  navigator.mediaSession.setActionHandler("pause", () => handlers.onPause());
  navigator.mediaSession.setActionHandler("previoustrack", () => handlers.onPrevious());
  navigator.mediaSession.setActionHandler("nexttrack", () => handlers.onNext());
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime != null) handlers.onSeek(details.seekTime);
  });
}

function applyMetadata(song: MediaSessionSong): void {
  if (!("mediaSession" in navigator)) return;

  const artworkSrc = resolveArtworkUrl(song.imageUrl);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    artwork: [
      { src: `${location.origin}/waveform-pwa-icon-180.png`, sizes: "180x180", type: "image/png" },
      { src: artworkSrc, sizes: "512x512", type: "image/png" },
    ],
  });
}

function applyPlaybackState(isPlaying: boolean): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function applyPositionState(currentTime: number, duration: number): void {
  if (!("mediaSession" in navigator) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(Math.max(0, currentTime), duration),
    });
  } catch {}
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
  getActiveAudio,
  audioRefs,
}: UseMediaSessionOptions): void {
  const handlersRef = useRef({ onPlay, onPause, onPrevious, onNext, onSeek });
  const songRef = useRef(song);
  const isPlayingRef = useRef(isPlaying);
  const currentTimeRef = useRef(currentTime);
  const durationRef = useRef(duration);

  useEffect(() => {
    handlersRef.current = { onPlay, onPause, onPrevious, onNext, onSeek };
  }, [onPlay, onPause, onPrevious, onNext, onSeek]);

  useEffect(() => {
    songRef.current = song;
  }, [song]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const syncMediaSession = useCallback(() => {
    const currentSong = songRef.current;
    if (!currentSong) {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
      return;
    }

    applyMetadata(currentSong);
    applyPlaybackState(isPlayingRef.current);
    applyPositionState(currentTimeRef.current, durationRef.current);
    registerActionHandlers(handlersRef.current);
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!song) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      return;
    }

    syncMediaSession();
  }, [song?.title, song?.artist, song?.imageUrl, song, syncMediaSession]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !song) return;
    applyPlaybackState(isPlaying);
  }, [isPlaying, song]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !song || duration <= 0) return;
    applyPositionState(currentTime, duration);
  }, [currentTime, duration, song]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const onPlaying = (event: Event) => {
      const active = getActiveAudio();
      if (!active || event.currentTarget !== active) return;
      syncMediaSession();
    };

    const elements = audioRefs
      .map((ref) => ref.current)
      .filter((element): element is HTMLAudioElement => element != null);

    for (const element of elements) {
      element.addEventListener("playing", onPlaying);
    }

    const active = getActiveAudio();
    if (active && !active.paused) {
      syncMediaSession();
    }

    return () => {
      for (const element of elements) {
        element.removeEventListener("playing", onPlaying);
      }
      clearActionHandlers();
    };
  }, [audioRefs, getActiveAudio, song?.title, syncMediaSession]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const refreshOnForeground = () => {
      if (document.visibilityState !== "visible") return;
      syncMediaSession();
    };

    document.addEventListener("visibilitychange", refreshOnForeground);
    window.addEventListener("pageshow", refreshOnForeground);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnForeground);
      window.removeEventListener("pageshow", refreshOnForeground);
    };
  }, [syncMediaSession]);
}
