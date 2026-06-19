"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

type MediaSessionSong = {
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
};

type UseMediaSessionOptions = {
  // false on native iOS: the AVPlayer engine owns MPNowPlayingInfoCenter +
  // MPRemoteCommandCenter, so the web mediaSession must not also write them.
  enabled?: boolean;
  song: MediaSessionSong | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
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

function applyPositionState(currentTime: number, duration: number, playbackRate: number): void {
  if (!("mediaSession" in navigator)) return;
  if (duration <= 0) {
    clearPositionState();
    return;
  }
  try {
    navigator.mediaSession.setPositionState({
      duration,
      // The real effective rate, or the lock-screen scrubber drifts at 1.5x.
      playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
      position: Math.min(Math.max(0, currentTime), duration),
    });
  } catch {}
}

function clearPositionState(): void {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  try {
    // Clear any stale position (e.g. when switching to a live radio stream).
    navigator.mediaSession.setPositionState();
  } catch {}
}

export function useMediaSession({
  enabled = true,
  song,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  onPlay,
  onPause,
  onPrevious,
  onNext,
  onSeek,
  getActiveAudio,
  audioRefs,
}: UseMediaSessionOptions): void {
  // A ref so the effect guards read the latest value without re-subscribing
  // (enabled is platform-constant in practice, so it never actually flips).
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const handlersRef = useRef({ onPlay, onPause, onPrevious, onNext, onSeek });
  const songRef = useRef(song);
  const isPlayingRef = useRef(isPlaying);
  const currentTimeRef = useRef(currentTime);
  const durationRef = useRef(duration);
  const playbackRateRef = useRef(playbackRate);
  const lastPositionPublishRef = useRef(0);
  const lastPublishedDurationRef = useRef(0);
  const lastPublishedPlaybackRateRef = useRef(1);

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

  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

  const syncMediaSession = useCallback(() => {
    if (!enabledRef.current) return;
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
    applyPositionState(currentTimeRef.current, durationRef.current, playbackRateRef.current);
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
    if (!enabledRef.current || !("mediaSession" in navigator) || !song) return;
    applyPlaybackState(isPlaying);
  }, [isPlaying, song]);

  useEffect(() => {
    if (!enabledRef.current || !("mediaSession" in navigator) || !song) return;
    // The OS interpolates position on its own, so there's no need to push every
    // 4Hz currentTime tick. Publish immediately when the duration or rate
    // changes (so the lock-screen scrubber rescales for VBR/HLS and doesn't
    // drift at non-1x speed), otherwise throttle to ~1Hz.
    const durationChanged = duration !== lastPublishedDurationRef.current;
    const rateChanged = playbackRate !== lastPublishedPlaybackRateRef.current;
    const elapsed = Date.now() - lastPositionPublishRef.current;
    if (!durationChanged && !rateChanged && elapsed < 1000) return;
    lastPositionPublishRef.current = Date.now();
    lastPublishedDurationRef.current = duration;
    lastPublishedPlaybackRateRef.current = playbackRate;
    applyPositionState(currentTime, duration, playbackRate);
  }, [currentTime, duration, playbackRate, song]);

  useEffect(() => {
    if (!enabledRef.current || !("mediaSession" in navigator)) return;

    const onActiveAudioEvent = (event: Event) => {
      const active = getActiveAudio();
      if (!active || event.currentTarget !== active) return;
      syncMediaSession();
    };

    const onActiveDurationChange = (event: Event) => {
      const active = getActiveAudio();
      if (!active || event.currentTarget !== active) return;
      // A VBR/HLS duration update should re-publish position state right away so
      // the lock-screen scrubber rescales; bypass the ~1Hz throttle.
      lastPositionPublishRef.current = 0;
      lastPublishedDurationRef.current = -1;
      const mediaDuration = active.duration;
      if (Number.isFinite(mediaDuration)) durationRef.current = mediaDuration;
      syncMediaSession();
    };

    const elements = audioRefs
      .map((ref) => ref.current)
      .filter((element): element is HTMLAudioElement => element != null);

    for (const element of elements) {
      element.addEventListener("loadedmetadata", onActiveAudioEvent);
      element.addEventListener("play", onActiveAudioEvent);
      element.addEventListener("playing", onActiveAudioEvent);
      element.addEventListener("durationchange", onActiveDurationChange);
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
        element.removeEventListener("durationchange", onActiveDurationChange);
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
