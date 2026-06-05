"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { resolveNativeApiUrl } from "@/lib/song-utils";

type MediaSessionSong = {
  title: string;
  artist: string;
  album?: string;
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

const FALLBACK_ARTWORK = "/icon-512.png";
const FALLBACK_ARTWORK_SMALL = "/apple-icon.png";

function resolveArtworkUrl(imageUrl: string): string {
  if (!imageUrl || /^blob:|^data:/i.test(imageUrl) || /\.svg(?:[?#]|$)/i.test(imageUrl)) {
    return `${location.origin}${FALLBACK_ARTWORK}`;
  }
  if (/^https?:/i.test(imageUrl)) return imageUrl;
  const nativeUrl = resolveNativeApiUrl(imageUrl);
  if (/^https?:/i.test(nativeUrl)) return nativeUrl;
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

  const actionHandlers = {
    play: () => handlers.onPlay(),
    pause: () => handlers.onPause(),
    previoustrack: () => handlers.onPrevious(),
    nexttrack: () => handlers.onNext(),
    seekto: (details: MediaSessionActionDetails) => {
      if (details.seekTime != null) handlers.onSeek(details.seekTime);
    },
  } satisfies Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;

  for (const [action, handler] of Object.entries(actionHandlers) as Array<
    [keyof typeof actionHandlers, MediaSessionActionHandler]
  >) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }
}

function applyMetadata(song: MediaSessionSong): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;

  const artworkSrc = resolveArtworkUrl(song.imageUrl);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album || "",
      artwork: [
        { src: `${location.origin}${FALLBACK_ARTWORK_SMALL}`, sizes: "180x180", type: "image/png" },
        { src: artworkSrc || `${location.origin}${FALLBACK_ARTWORK}`, sizes: "512x512", type: "image/png" },
      ],
    });
  } catch {}
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
  }, [song?.title, song?.artist, song?.album, song?.imageUrl, song, syncMediaSession]);

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

    const onActiveAudioEvent = (event: Event) => {
      const active = getActiveAudio();
      if (!active || event.currentTarget !== active) return;
      syncMediaSession();
    };

    const elements = audioRefs
      .map((ref) => ref.current)
      .filter((element): element is HTMLAudioElement => element != null);

    for (const element of elements) {
      element.addEventListener("loadedmetadata", onActiveAudioEvent);
      element.addEventListener("play", onActiveAudioEvent);
      element.addEventListener("playing", onActiveAudioEvent);
    }

    const active = getActiveAudio();
    if (active && !active.paused) {
      syncMediaSession();
    }

    return () => {
      for (const element of elements) {
        element.removeEventListener("loadedmetadata", onActiveAudioEvent);
        element.removeEventListener("play", onActiveAudioEvent);
        element.removeEventListener("playing", onActiveAudioEvent);
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
