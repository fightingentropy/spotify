"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { chooseNextShuffleIndex, usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn, formatTime } from "@/lib/utils";
import { ChevronDown, ChevronUp, Heart, Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Volume2, VolumeX } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { isOfflinePlaybackSong, isRadioSong } from "@/lib/player-song";
import { PLAYBACK_GESTURE_EVENT, requestImmediatePlayback, type PlaybackGestureDetail } from "@/lib/playback-gesture";
import { useMediaSession } from "@/lib/use-media-session";
import { resolveNativeApiUrl } from "@/lib/song-utils";
import {
  notePlaybackNetworkFailure,
  notePlaybackNetworkSuccess,
  prefetchUpcomingPlayback,
} from "@/client/playback-warm";
import { normalizeOfflineAccountScope, resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";
import { useAuth } from "@/client/auth";

function resolvePlayableSrc(src: string): string {
  if (/^(blob:|data:|file:|capacitor:|https?:)/i.test(src)) return src;
  const nativeUrl = resolveNativeApiUrl(src);
  if (/^https?:/i.test(nativeUrl)) return nativeUrl;
  return `${location.origin}${src}`;
}

function requestMediaCache(song: PlayerSong | null): void {
  if (!song || !("serviceWorker" in navigator)) return;
  const urls = [song.imageUrl, song.lyricsUrl].filter((url) => {
    return typeof url === "string" && url.length > 0 && !/^(blob:|data:)/i.test(url);
  });
  if (urls.length === 0) return;

  const message = { type: "CACHE_MEDIA", urls };
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(message);
    return;
  }
  navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => {});
}

function finiteMediaDuration(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isHlsPlaylistSrc(src: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(src);
}

function canPlayHlsNatively(audio: HTMLAudioElement): boolean {
  return (
    audio.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    audio.canPlayType("application/x-mpegURL") !== ""
  );
}

type AudioSourceState = {
  src: string;
  hls: HlsInstance | null;
};

type HlsInstance = {
  attachMedia: (media: HTMLMediaElement) => void;
  destroy: () => void;
  loadSource: (src: string) => void;
};

type HlsConstructor = {
  new (config?: { enableWorker?: boolean; lowLatencyMode?: boolean }): HlsInstance;
  isSupported: () => boolean;
};

let hlsConstructorPromise: Promise<HlsConstructor | null> | null = null;
const NowPlayingSheet = lazy(() => import("@/components/NowPlayingSheet"));

function loadHlsConstructor(): Promise<HlsConstructor | null> {
  hlsConstructorPromise ??= import("hls.js/light")
    .then((module) => module.default as HlsConstructor)
    .catch(() => null);
  return hlsConstructorPromise;
}

function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return String((error as { name?: unknown }).name || "");
}

function PlayerBar(): React.ReactElement | null {
  // Individual selectors so we only re-render when each specific value changes
  // (instead of on every store mutation, as a full destructure would cause).
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const shuffleRemaining = usePlayerStore((s) => s.shuffleRemaining);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const play = usePlayerStore((s) => s.play);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setSong = usePlayerStore((s) => s.setSong);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const advanceToIndex = usePlayerStore((s) => s.advanceToIndex);
  const replaceSong = usePlayerStore((s) => s.replaceSong);
  const pause = usePlayerStore((s) => s.pause);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  const navigate = useNavigate();
  const { user, status: authStatus } = useAuth();
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);
  const hydrateOffline = useOfflineStore((state) => state.hydrate);
  const offlineRecords = useOfflineStore((state) => state.records);

  const resolvePlaybackSong = useCallback((song: PlayerSong) => resolveOfflinePlaybackSong(song), [offlineRecords]);
  const playbackSong = useMemo(
    () => (currentSong ? resolvePlaybackSong(currentSong) : null),
    [currentSong, resolvePlaybackSong],
  );

  const currentSongId = playbackSong?.id ?? null;
  const currentSongIsBrowserLocal = isBrowserLocalSong(playbackSong);
  const currentSongIsRadio = isRadioSong(playbackSong);
  const currentSongIsOffline = isOfflinePlaybackSong(playbackSong);
  const songIsLiked = currentSongId ? !!likedLookup[currentSongId] : false;
  const likePending = currentSongId ? !!pendingLookup[currentSongId] : false;

  const handleToggleLike = useCallback(async () => {
    if (!currentSongId || !likesHydrated || likePending || currentSongIsRadio) return;
    const result = await toggleLike(currentSongId, !songIsLiked, currentSong ?? undefined);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }, [currentSong, currentSongId, currentSongIsRadio, likesHydrated, likePending, toggleLike, songIsLiked, navigate]);

  // Dual audio elements for real crossfade
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceStateRef = useRef<WeakMap<HTMLAudioElement, AudioSourceState>>(new WeakMap());
  const [activeIdx, setActiveIdx] = useState<0 | 1>(0);
  const getActiveAudio = useCallback(
    () => (activeIdx === 0 ? audioARef.current : audioBRef.current),
    [activeIdx]
  );
  const getInactiveAudio = useCallback(
    () => (activeIdx === 0 ? audioBRef.current : audioARef.current),
    [activeIdx]
  );
  const mediaSessionAudioRefs = useMemo(() => [audioARef, audioBRef], []);

  const crossfadingRef = useRef<boolean>(false);
  const crossfadeCancelRef = useRef<(() => void) | null>(null);
  const crossfadeCommitSongIdRef = useRef<string | null>(null);
  const suppressAutoLoadRef = useRef<boolean>(false);
  const resumeAfterSeekRef = useRef<boolean>(false);
  const pendingSeekTimeoutRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{ audio: HTMLAudioElement; time: number; duration: number } | null>(null);
  const lastSeekTargetRef = useRef<number | null>(null);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const playRequestIdRef = useRef<number>(0);
  const volumeRef = useRef<number>(volume);
  const mutedRef = useRef<boolean>(isMuted);
  const restoredPlayerStateRef = useRef(false);
  const accountScopeRef = useRef<string | null>(null);

  const savedSeekRef = useRef<number | null>(null);
  const lockedPlaybackSourceRef = useRef<{ songId: string; src: string } | null>(null);
  const nowPlayingOpenFrameRef = useRef<number | null>(null);
  const nowPlayingCloseTimeoutRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMounted, setNowPlayingMounted] = useState(false);

  const desiredSrc = playbackSong?.audioUrl || null;
  const authSettled = authStatus !== "loading";
  const accountScope = normalizeOfflineAccountScope(user?.id ?? authStatus);

  useEffect(() => {
    if (!authSettled) return;
    if (accountScopeRef.current === null) {
      accountScopeRef.current = accountScope;
      return;
    }
    if (accountScopeRef.current === accountScope) return;
    accountScopeRef.current = accountScope;
    setQueue([], 0);
    pause();
  }, [accountScope, authSettled, pause, setQueue]);

  useEffect(() => {
    void hydrateOffline();
  }, [hydrateOffline]);

  const closeNowPlaying = useCallback(() => {
    if (nowPlayingOpenFrameRef.current != null) {
      window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
      nowPlayingOpenFrameRef.current = null;
    }
    setNowPlayingOpen(false);
    if (nowPlayingCloseTimeoutRef.current != null) {
      window.clearTimeout(nowPlayingCloseTimeoutRef.current);
    }
    nowPlayingCloseTimeoutRef.current = window.setTimeout(() => {
      nowPlayingCloseTimeoutRef.current = null;
      setNowPlayingMounted(false);
    }, 380);
  }, []);

  const openNowPlaying = useCallback(() => {
    if (nowPlayingCloseTimeoutRef.current != null) {
      window.clearTimeout(nowPlayingCloseTimeoutRef.current);
      nowPlayingCloseTimeoutRef.current = null;
    }
    setNowPlayingMounted(true);
    if (nowPlayingOpenFrameRef.current != null) {
      window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
    }
    nowPlayingOpenFrameRef.current = window.requestAnimationFrame(() => {
      nowPlayingOpenFrameRef.current = null;
      setNowPlayingOpen(true);
    });
  }, []);

  const toggleNowPlaying = useCallback(() => {
    if (nowPlayingOpen) closeNowPlaying();
    else openNowPlaying();
  }, [closeNowPlaying, nowPlayingOpen, openNowPlaying]);

  const unloadAudioSource = useCallback((audio: HTMLAudioElement) => {
    const current = audioSourceStateRef.current.get(audio);
    current?.hls?.destroy();
    audioSourceStateRef.current.delete(audio);
    try { audio.pause(); } catch {}
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const loadAudioSource = useCallback((audio: HTMLAudioElement, nextSrc: string) => {
    const absolute = resolvePlayableSrc(nextSrc);
    const current = audioSourceStateRef.current.get(audio);
    if (current?.src === absolute) return;

    current?.hls?.destroy();
    audioSourceStateRef.current.delete(audio);

    if (isHlsPlaylistSrc(absolute) && !canPlayHlsNatively(audio)) {
      audio.removeAttribute("src");
      audio.load();
      audioSourceStateRef.current.set(audio, { src: absolute, hls: null });
      void (async () => {
        const HlsConstructor = await loadHlsConstructor();
        const latest = audioSourceStateRef.current.get(audio);
        if (latest?.src !== absolute || latest.hls) return;

        if (!HlsConstructor?.isSupported()) {
          if (audio.src !== absolute) audio.src = absolute;
          if (isPlayingRef.current) void audio.play().catch(() => {});
          return;
        }

        const hls = new HlsConstructor({
          enableWorker: true,
          lowLatencyMode: true,
        });
        hls.loadSource(absolute);
        hls.attachMedia(audio);

        const currentAfterAttach = audioSourceStateRef.current.get(audio);
        if (currentAfterAttach?.src === absolute) {
          audioSourceStateRef.current.set(audio, { src: absolute, hls });
          if (isPlayingRef.current) void audio.play().catch(() => {});
        } else {
          hls.destroy();
        }
      })();
      return;
    }

    if (audio.src !== absolute) audio.src = absolute;
    audioSourceStateRef.current.set(audio, { src: absolute, hls: null });
  }, []);

  const cancelActiveCrossfade = useCallback(() => {
    const cancel = crossfadeCancelRef.current;
    crossfadeCancelRef.current = null;
    suppressAutoLoadRef.current = false;
    crossfadingRef.current = false;
    cancel?.();
  }, []);

  const resetPendingSeek = useCallback(() => {
    if (pendingSeekTimeoutRef.current != null) {
      window.clearTimeout(pendingSeekTimeoutRef.current);
      pendingSeekTimeoutRef.current = null;
    }
    pendingSeekRef.current = null;
    lastSeekTargetRef.current = null;
    resumeAfterSeekRef.current = false;
  }, []);

  const resetPlaybackClock = useCallback((nextDuration = 0) => {
    resetPendingSeek();
    setCurrentTime(0);
    setDuration(finiteMediaDuration(nextDuration) ?? 0);
  }, [resetPendingSeek]);

  const playAudio = useCallback((audio: HTMLAudioElement): Promise<boolean> => {
    const requestId = ++playRequestIdRef.current;
    return audio.play()
      .then(() => requestId === playRequestIdRef.current)
      .catch((error: unknown) => {
        if (errorName(error) === "AbortError") return false;
        if (requestId !== playRequestIdRef.current) return false;
        if (audio !== getActiveAudio() || !isPlayingRef.current) return false;
        pause();
        return false;
      });
  }, [getActiveAudio, pause]);

  useEffect(() => {
    function onPlaybackGesture(event: Event) {
      const detail = (event as CustomEvent<PlaybackGestureDetail>).detail;
      if (!detail?.audioUrl) return;
      const audio = getActiveAudio();
      if (!audio) return;

      cancelActiveCrossfade();
      if (audioSourceStateRef.current.get(audio)?.src !== resolvePlayableSrc(detail.audioUrl)) {
        resetPlaybackClock();
      }
      loadAudioSource(audio, detail.audioUrl);
      isPlayingRef.current = true;
      void playAudio(audio);
    }

    window.addEventListener(PLAYBACK_GESTURE_EVENT, onPlaybackGesture);
    return () => window.removeEventListener(PLAYBACK_GESTURE_EVENT, onPlaybackGesture);
  }, [cancelActiveCrossfade, getActiveAudio, loadAudioSource, playAudio, resetPlaybackClock]);

  const resumeActivePlayback = useCallback((audio: HTMLAudioElement) => {
    if (!isPlayingRef.current || audio !== getActiveAudio()) return;
    playAudio(audio).then((started) => {
      if (started && audio === getActiveAudio()) resumeAfterSeekRef.current = false;
    });
  }, [getActiveAudio, playAudio]);

  const performSeek = useCallback((active: HTMLAudioElement, nextTime: number, seekDuration: number) => {
    if (active !== getActiveAudio()) return;
    if (crossfadingRef.current) cancelActiveCrossfade();
    const inactive = getInactiveAudio();
    resumeAfterSeekRef.current = isPlayingRef.current;
    try {
      active.currentTime = nextTime;
    } catch {
      resumeAfterSeekRef.current = false;
      return;
    }
    if (crossfadingRef.current && inactive) {
      try {
        const inactiveDuration = finiteMediaDuration(inactive.duration) ?? seekDuration;
        inactive.currentTime = Math.max(0, Math.min(inactiveDuration, nextTime));
      } catch {}
    }
    setCurrentTime(nextTime);
    if (resumeAfterSeekRef.current) resumeActivePlayback(active);
  }, [cancelActiveCrossfade, getActiveAudio, getInactiveAudio, resumeActivePlayback]);

  const onSeek = useCallback((value: number) => {
    const active = getActiveAudio();
    if (!active || !Number.isFinite(value)) return;
    const seekDuration = finiteMediaDuration(duration) ?? finiteMediaDuration(active.duration);
    if (seekDuration == null) return;
    const nextTime = Math.max(0, Math.min(seekDuration, value));
    lastSeekTargetRef.current = nextTime;
    pendingSeekRef.current = { audio: active, time: nextTime, duration: seekDuration };
    setCurrentTime(nextTime);

    if (pendingSeekTimeoutRef.current != null) {
      window.clearTimeout(pendingSeekTimeoutRef.current);
    }
    pendingSeekTimeoutRef.current = window.setTimeout(() => {
      pendingSeekTimeoutRef.current = null;
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (!pending) return;
      performSeek(pending.audio, pending.time, pending.duration);
      if (lastSeekTargetRef.current === pending.time) {
        lastSeekTargetRef.current = null;
      }
    }, 90);
  }, [duration, getActiveAudio, performSeek]);

  useMediaSession({
    song: playbackSong,
    isPlaying,
    currentTime,
    duration,
    onPlay: play,
    onPause: pause,
    onPrevious: previous,
    onNext: next,
    onSeek,
    getActiveAudio,
    audioRefs: mediaSessionAudioRefs,
  });

  useEffect(() => {
    if (!currentSongIsRadio && !currentSongIsOffline) requestMediaCache(playbackSong);
  }, [playbackSong?.id, playbackSong?.audioUrl, playbackSong?.imageUrl, currentSongIsOffline, currentSongIsRadio]);

  useEffect(() => {
    return () => {
      const a = audioARef.current;
      const b = audioBRef.current;
      if (a) unloadAudioSource(a);
      if (b) unloadAudioSource(b);
    };
  }, [unloadAudioSource]);

  useEffect(() => {
    if (!currentSong) return;
    void prefetchUpcomingPlayback(queue, currentIndex);
  }, [currentIndex, currentSong?.id, queue]);

  useEffect(() => {
    return () => {
      if (pendingSeekTimeoutRef.current != null) {
        window.clearTimeout(pendingSeekTimeoutRef.current);
      }
      if (nowPlayingOpenFrameRef.current != null) {
        window.cancelAnimationFrame(nowPlayingOpenFrameRef.current);
      }
      if (nowPlayingCloseTimeoutRef.current != null) {
        window.clearTimeout(nowPlayingCloseTimeoutRef.current);
      }
    };
  }, []);

  // Client hydration of crossfade settings to ensure feature works without visiting /settings
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const storedEnabled = localStorage.getItem("spotify_crossfade_enabled");
      const enabled = storedEnabled === null ? true : storedEnabled === "1";
      const secs = Math.max(0, Math.min(12, Number(localStorage.getItem("spotify_crossfade_seconds") ?? 4)));
      if (enabled !== crossfadeEnabled) setCrossfadeEnabled(enabled);
      if (secs !== crossfadeSeconds) setCrossfadeSeconds(secs);
    } catch {}
  }, []);

  // Keep mute state in sync on both elements
  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (a) a.muted = isMuted;
    if (b) b.muted = isMuted;
  }, [isMuted]);

  // Track latest volume/mute for fades without re-running effects
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (!isPlaying) resumeAfterSeekRef.current = false;
  }, [isPlaying]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = isMuted; }, [isMuted]);

  // Keep volume on the active element (crossfade code manages both during fades)
  useEffect(() => {
    if (crossfadingRef.current) return;
    const audio = getActiveAudio();
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted, getActiveAudio]);

  // Ensure play/pause controls affect both elements during an active crossfade
  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (crossfadingRef.current) {
      if (isPlaying) {
        a?.play().catch(() => {});
        b?.play().catch(() => {});
      } else {
        try { a?.pause(); } catch {}
        try { b?.pause(); } catch {}
      }
    } else {
      const active = getActiveAudio();
      const inactive = getInactiveAudio();
      if (isPlaying) {
        if (active) void playAudio(active);
      } else {
        playRequestIdRef.current += 1;
        try { active?.pause(); } catch {}
      }
      // Keep inactive paused when not crossfading
      if (inactive && inactive !== active) {
        try { inactive.pause(); } catch {}
        inactive.currentTime = inactive.currentTime; // noop to avoid iOS suspending issues
      }
    }
  }, [isPlaying, activeIdx, getActiveAudio, getInactiveAudio, playAudio]);

  // Restore last played queue/song and time on client mount to avoid SSR mismatches
  useEffect(() => {
    if (!authSettled || restoredPlayerStateRef.current) return;
    try {
      const raw = localStorage.getItem("spotify_player_state");
      if (!raw) return;
      const data = JSON.parse(raw) as
        | {
            accountScope?: string;
            queue?: PlayerSong[];
            currentIndex?: number;
            song?: PlayerSong;
            currentTime?: number;
            isPlaying?: boolean;
          }
        | null;
      if (typeof data?.accountScope !== "string") return;
      if (normalizeOfflineAccountScope(data.accountScope) !== accountScope) return;
      restoredPlayerStateRef.current = true;
      if (data?.queue && Array.isArray(data.queue) && typeof data.currentIndex === "number") {
        const restoredQueue = data.queue.filter((song) => !isBrowserLocalSong(song));
        const restoredSongId = data.queue[data.currentIndex]?.id;
        const idxFromSong = restoredQueue.findIndex((song) => song.id === restoredSongId);
        const idx = idxFromSong >= 0 ? idxFromSong : Math.max(0, Math.min(restoredQueue.length - 1, data.currentIndex));
        if (restoredQueue.length === 0) return;
        setQueue(restoredQueue, idx);
        // Always start paused on fresh load to avoid autoplay restrictions
        pause();
        if (typeof data.currentTime === "number") {
          savedSeekRef.current = data.currentTime;
          setCurrentTime(data.currentTime);
        }
      } else if (data?.song) {
        setSong(data.song);
        pause();
        if (typeof data.currentTime === "number") {
          savedSeekRef.current = data.currentTime;
          setCurrentTime(data.currentTime);
        }
      }
    } catch {}
  }, [accountScope, authSettled, pause, setSong, setQueue]);

  useEffect(() => {
    if (!currentSongId || currentSongIsBrowserLocal || currentSongIsRadio || currentSongIsOffline) return;

    let cancelled = false;
    const songId = currentSongId;

    async function refreshCurrentSong() {
      try {
        const response = await fetch(`/api/songs/${encodeURIComponent(songId)}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const song = (await response.json()) as PlayerSong;
        if (cancelled || !song?.id || song.id !== songId) return;
        replaceSong(song);
      } catch {}
    }

    refreshCurrentSong();

    return () => {
      cancelled = true;
    };
  }, [currentSongId, currentSongIsBrowserLocal, currentSongIsOffline, currentSongIsRadio, replaceSong]);

  useEffect(() => {
    if (!currentSongId) {
      cancelActiveCrossfade();
      return;
    }
    if (crossfadeCommitSongIdRef.current === currentSongId) {
      crossfadeCommitSongIdRef.current = null;
      return;
    }
    cancelActiveCrossfade();
  }, [cancelActiveCrossfade, currentSongId]);

  // Load current song into the ACTIVE element when not crossfading
  useEffect(() => {
    if (suppressAutoLoadRef.current) {
      cancelActiveCrossfade();
    }
    const audio = getActiveAudio();
    const other = getInactiveAudio();
    if (!audio) return;
    if (!playbackSong?.id || !desiredSrc) {
      lockedPlaybackSourceRef.current = null;
      unloadAudioSource(audio);
      if (other) unloadAudioSource(other);
      resetPlaybackClock();
      return;
    }
    const lockedSource = lockedPlaybackSourceRef.current;
    const activeSourceIsSettled = audio.currentTime > 0 || audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    const canKeepLockedSource =
      lockedSource?.songId === playbackSong.id &&
      lockedSource.src !== desiredSrc &&
      activeSourceIsSettled;
    const src =
      canKeepLockedSource
        ? lockedSource.src
        : desiredSrc;
    const sourceChanged = audioSourceStateRef.current.get(audio)?.src !== resolvePlayableSrc(src);
    if (sourceChanged) resetPlaybackClock(playbackSong?.duration ?? 0);
    if (sourceChanged || lockedSource?.songId !== playbackSong.id) {
      lockedPlaybackSourceRef.current = { songId: playbackSong.id, src };
    }
    loadAudioSource(audio, src);
    if (other && other !== audio) {
      // Ensure the inactive element is quiet and not playing
      try { other.pause(); } catch {}
      other.volume = 0;
      unloadAudioSource(other);
    }
    if (isPlaying) {
      void playAudio(audio);
    } else {
      playRequestIdRef.current += 1;
      audio.pause();
    }
  }, [desiredSrc, isPlaying, playbackSong?.duration, playbackSong?.id, getActiveAudio, getInactiveAudio, loadAudioSource, unloadAudioSource, cancelActiveCrossfade, playAudio, resetPlaybackClock]);

  // Crossfade: if enabled, monitor active element time and overlap next track
  useEffect(() => {
    if (!crossfadeEnabled) return;
    const audio = getActiveAudio();
    if (!audio) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const fadeWindow = Math.min(crossfadeSeconds, Math.max(0, duration / 2));
    if (fadeWindow <= 0) return;

    let raf: number | null = null;
    let started = false;
    let isMounted = true;
    let cancelFade: (() => void) | null = null;

    function step() {
      if (!isMounted) return;
      const current = getActiveAudio();
      if (!current) return;
      const remaining = (duration || 0) - (current.currentTime || 0);
      if (!started && remaining <= fadeWindow + 0.05 && isPlaying && repeatMode !== "one") {
        started = true;
        crossfadingRef.current = true;

        const fromAudio = current;
        const toAudio = getInactiveAudio();
        if (!toAudio) {
          crossfadingRef.current = false;
          return;
        }
        const incoming = toAudio as HTMLAudioElement;
        
        // Compute upcoming track based on current queue snapshot
        let nextIdx = currentIndex;
        let nextSong = undefined as undefined | PlayerSong;
        if (Array.isArray(queue) && queue.length > 0) {
          if (shuffle) {
            if (queue.length === 1) {
              crossfadingRef.current = false;
              return;
            }
            const idx = chooseNextShuffleIndex(queue.length, currentIndex, shuffleRemaining);
            if (idx === currentIndex || idx < 0 || idx >= queue.length) {
              crossfadingRef.current = false;
              return;
            }
            nextIdx = idx;
          } else {
            const atEnd = currentIndex >= queue.length - 1;
            if (atEnd) {
              if (repeatMode === "all") nextIdx = 0;
              else {
                crossfadingRef.current = false;
                return;
              }
            } else {
              nextIdx = currentIndex + 1;
            }
          }
          nextSong = queue[nextIdx];
        } else {
          crossfadingRef.current = false;
          return;
        }
        if (!nextSong) { crossfadingRef.current = false; return; }
        const nextPlaybackSong = resolvePlaybackSong(nextSong);
        const nextSongId = nextPlaybackSong.id;
        const nextIndexToCommit = nextIdx;

        // Prepare incoming track
        suppressAutoLoadRef.current = true;
        if (nextPlaybackSong.audioUrl) loadAudioSource(incoming, nextPlaybackSong.audioUrl);
        incoming.currentTime = 0;
        incoming.volume = 0;

        // Do not switch UI yet; we will switch after fade completes to keep time/progress stable

        const fadeMs = fadeWindow * 1000;
        const startTs = performance.now();
        const targetVol = mutedRef.current ? 0 : volumeRef.current;
        const fromStartTime = fromAudio.currentTime || 0;
        // Lock the total duration snapshot used for remaining calculations during fade
        // Start incoming playback, ensure it's running while we fade
        incoming.play().catch(() => {});
        cancelFade = () => {
          isMounted = false;
          if (raf) cancelAnimationFrame(raf);
          try { incoming.pause(); } catch {}
          incoming.volume = 0;
          fromAudio.volume = mutedRef.current ? 0 : volumeRef.current;
          suppressAutoLoadRef.current = false;
          crossfadingRef.current = false;
        };
        crossfadeCancelRef.current = cancelFade;

        function fade() {
          const now = performance.now();
          const elapsed = Math.min(fadeMs, now - startTs);
          const t = elapsed / fadeMs;
          // Ease linear
          const fromVol = Math.max(0, (mutedRef.current ? 0 : volumeRef.current) * (1 - t));
          const toVol = Math.max(0, targetVol * t);
          // Apply volumes only if still the same segment (avoid jumps after seeks)
          if ((fromAudio.currentTime || 0) >= fromStartTime) {
            fromAudio.volume = fromVol;
          }
          incoming.volume = toVol;

          if (elapsed < fadeMs && isPlaying && isMounted) {
            raf = requestAnimationFrame(fade);
          } else {
            // Finish: pause outgoing, keep incoming playing, then switch UI to the new track
            try { fromAudio.pause(); } catch {}
            if (!isPlaying) { try { incoming.pause(); } catch {} }
            // Keep previous track silent to avoid bleed-through
            fromAudio.volume = 0;
            crossfadeCancelRef.current = null;
            crossfadeCommitSongIdRef.current = nextSongId;
            // Switch UI/active element now that audio is already running
            advanceToIndex(nextIndexToCommit);
            setActiveIdx(activeIdx === 0 ? 1 : 0);
            // Update duration from incoming element if known
            if (Number.isFinite(incoming.duration)) {
              setDuration(incoming.duration || 0);
            }
            suppressAutoLoadRef.current = false;
            crossfadingRef.current = false;
          }
        }
        raf = requestAnimationFrame(fade);
      }
      if (!started && isMounted) raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);
    // Ensure we don't pause or change volume elsewhere during fade
    return () => { 
      isMounted = false;
      if (raf) cancelAnimationFrame(raf); 
      if (cancelFade && crossfadeCancelRef.current === cancelFade) {
        crossfadeCancelRef.current = null;
        cancelFade();
      }
    };
  }, [activeIdx, advanceToIndex, crossfadeEnabled, crossfadeSeconds, currentIndex, duration, getActiveAudio, getInactiveAudio, isPlaying, loadAudioSource, queue, repeatMode, resolvePlaybackSong, shuffle, shuffleRemaining]);

  // Save queue/song and playback position right before page unload
  useEffect(() => {
    function saveState() {
      try {
        if (!currentSong || isBrowserLocalSong(currentSong)) {
          localStorage.removeItem("spotify_player_state");
          return;
        }
        const persistableQueue = queue.filter((song) => !isBrowserLocalSong(song));
        const persistableIndex = persistableQueue.findIndex((song) => song.id === currentSong.id);
        if (persistableIndex < 0) {
          localStorage.removeItem("spotify_player_state");
          return;
        }
        const active = activeIdx === 0 ? audioARef.current : audioBRef.current;
        const time = active?.currentTime ?? currentTime;
        const payload = {
          accountScope,
          queue: persistableQueue,
          currentIndex: persistableIndex,
          song: currentSong,
          currentTime: time,
          isPlaying,
        };
        localStorage.setItem("spotify_player_state", JSON.stringify(payload));
      } catch {}
    }

    window.addEventListener("beforeunload", saveState);
    window.addEventListener("pagehide", saveState);
    return () => {
      window.removeEventListener("beforeunload", saveState);
      window.removeEventListener("pagehide", saveState);
    };
  }, [accountScope, queue, currentIndex, currentSong, currentTime, isPlaying, activeIdx]);

  const handleActiveAudioResumePoint = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    const audio = event.currentTarget;
    if (audio !== getActiveAudio()) return;
    setCurrentTime(audio.currentTime || 0);
    if (resumeAfterSeekRef.current) resumeActivePlayback(audio);
  }, [getActiveAudio, resumeActivePlayback]);

  const handleActiveAudioPlaying = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget === getActiveAudio()) {
      resumeAfterSeekRef.current = false;
      notePlaybackNetworkSuccess();
    }
  }, [getActiveAudio]);

  const handleActiveAudioError = useCallback((event: React.SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget !== getActiveAudio()) return;
    if (currentSongIsBrowserLocal || currentSongIsRadio || currentSongIsOffline) return;
    notePlaybackNetworkFailure();
  }, [currentSongIsBrowserLocal, currentSongIsOffline, currentSongIsRadio, getActiveAudio]);

  const handleTogglePlayback = useCallback(() => {
    if (isPlaying) {
      pause();
      return;
    }
    requestImmediatePlayback(playbackSong);
    play();
  }, [playbackSong, isPlaying, pause, play]);

  // Global keyboard shortcuts (always register to keep hook order stable)
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || target.isContentEditable;
    }

    function seekBy(seconds: number) {
      const audio = getActiveAudio();
      if (!audio) return;
      const total = finiteMediaDuration(audio.duration) ?? finiteMediaDuration(duration);
      if (total == null) return;
      const baseTime = lastSeekTargetRef.current ?? audio.currentTime ?? 0;
      const nextTime = Math.max(0, Math.min(total, baseTime + seconds));
      onSeek(nextTime);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      // Spacebar toggles play/pause
      if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        handleTogglePlayback();
        return;
      }
      // Meta + Arrow for previous/next track
      if (e.metaKey && e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        next();
        return;
      }
      if (e.metaKey && e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        previous();
        return;
      }
      // Arrow keys for seeking +/- 5 seconds
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        seekBy(5);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        seekBy(-5);
      }
    }

    const options = { capture: true };
    window.addEventListener("keydown", onKeyDown, options);
    return () => window.removeEventListener("keydown", onKeyDown, options);
  }, [next, previous, duration, handleTogglePlayback, getActiveAudio, onSeek]);

  const audioElements = (
    <>
      <audio
        ref={audioARef}
        hidden
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          if (audio !== getActiveAudio()) return;
          setDuration(finiteMediaDuration(audio.duration) ?? 0);
          const pending = savedSeekRef.current;
          const seekDuration = finiteMediaDuration(audio.duration);
          if (typeof pending === "number" && seekDuration != null) {
            const clamped = Math.max(0, Math.min(seekDuration, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) {
            setCurrentTime(currentSongIsRadio ? 0 : e.currentTarget.currentTime || 0);
          }
        }}
        onSeeked={handleActiveAudioResumePoint}
        onCanPlay={handleActiveAudioResumePoint}
        onPlaying={handleActiveAudioPlaying}
        onError={handleActiveAudioError}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one" || (repeatMode === "all" && queue.length <= 1)) {
            audio.currentTime = 0;
            void playAudio(audio);
            return;
          }
          next();
        }}
      />
      <audio
        ref={audioBRef}
        hidden
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          if (audio !== getActiveAudio()) return;
          setDuration(finiteMediaDuration(audio.duration) ?? 0);
          const pending = savedSeekRef.current;
          const seekDuration = finiteMediaDuration(audio.duration);
          if (typeof pending === "number" && seekDuration != null) {
            const clamped = Math.max(0, Math.min(seekDuration, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) {
            setCurrentTime(currentSongIsRadio ? 0 : e.currentTarget.currentTime || 0);
          }
        }}
        onSeeked={handleActiveAudioResumePoint}
        onCanPlay={handleActiveAudioResumePoint}
        onPlaying={handleActiveAudioPlaying}
        onError={handleActiveAudioError}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one" || (repeatMode === "all" && queue.length <= 1)) {
            audio.currentTime = 0;
            void playAudio(audio);
            return;
          }
          next();
        }}
      />
    </>
  );

  if (!playbackSong) return audioElements;
  const hasSeekableDuration = duration > 0 && Number.isFinite(duration) && !currentSongIsRadio;
  const safeCurrentTime = hasSeekableDuration ? Math.min(currentTime, duration) : 0;
  const progress = hasSeekableDuration ? Math.min(100, Math.max(0, (safeCurrentTime / duration) * 100)) : 0;

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : Volume2;

  return (
    <>
      {nowPlayingMounted ? (
        <Suspense fallback={null}>
          <NowPlayingSheet
            open={nowPlayingOpen}
            onClose={closeNowPlaying}
            song={playbackSong}
            isPlaying={isPlaying}
            currentTime={safeCurrentTime}
            duration={hasSeekableDuration ? duration : 0}
            onSeek={onSeek}
          />
        </Suspense>
      ) : null}
      <div className="fixed inset-x-0 z-40 border-t border-white/[0.12] bg-background text-white bottom-[calc(var(--wf-mobile-nav-height)+env(safe-area-inset-bottom))] lg:bottom-0">
      {audioElements}
      {/* Mobile mini player */}
      <div className="lg:hidden relative">
        <div
          className="absolute inset-x-0 top-0 h-0.5 bg-white/[0.12]"
          aria-hidden
        >
          <div
            className="h-full bg-emerald-500 transition-[width] duration-150"
            style={{ width: currentSongIsRadio ? "100%" : `${progress}%` }}
          />
        </div>
        <div className="h-[var(--wf-mobile-player-height)] px-3 flex items-center gap-3">
          <button
            type="button"
            onClick={openNowPlaying}
            className="wf-pressable flex items-center gap-3 min-w-0 flex-1 text-left touch-manipulation"
            aria-label="Open now playing"
          >
            <CoverImage
              src={playbackSong.imageUrl || "/apple-icon.png"}
              alt="cover"
              width={48}
              height={48}
              loading="eager"
              className="wf-song-cover w-12 h-12 rounded-md object-cover shrink-0"
              sizes="48px"
            />
            <div className="min-w-0">
              <div className="text-[15px] font-medium leading-5 truncate text-white">{playbackSong.title}</div>
              <div className="text-[13px] leading-5 text-white/[0.62] truncate">{playbackSong.artist}</div>
            </div>
          </button>
          {!currentSongIsRadio ? (
            <button
              type="button"
              aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
              onClick={handleToggleLike}
              disabled={!likesHydrated || likePending || !currentSongId}
              className={cn(
                "wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation shrink-0",
                likePending ? "opacity-60" : "",
                songIsLiked ? "text-[#1ed760]" : "text-white/[0.68]",
              )}
            >
              <Heart size={20} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={handleTogglePlayback}
            className="wf-control-button h-11 w-11 rounded-full grid place-items-center bg-white text-black touch-manipulation shrink-0"
          >
            {isPlaying ? <Pause size={20} /> : <Play size={20} className="translate-x-[1px]" />}
          </button>
        </div>
      </div>

      {/* Desktop player */}
      <div className="hidden h-[84px] grid-cols-[minmax(15rem,1fr)_minmax(27rem,44rem)_minmax(15rem,1fr)] items-center gap-4 px-4 py-3 sm:px-6 lg:grid">
        <div className="flex min-w-0 items-center justify-start gap-3 sm:gap-4">
          <CoverImage
            src={playbackSong.imageUrl || "/apple-icon.png"}
            alt="cover"
            width={48}
            height={48}
            loading="eager"
            className="wf-song-cover h-12 w-12 shrink-0 rounded-[5px] object-cover"
            sizes="48px"
          />
          <div className="min-w-0 max-w-[20rem]">
            <div className="truncate text-[15px] font-medium leading-5 text-white">{playbackSong.title}</div>
            <div className="truncate text-[13px] leading-5 text-white/[0.62]">{playbackSong.artist}</div>
          </div>
          {!currentSongIsRadio ? (
            <button
              type="button"
              aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
              title={songIsLiked ? "In liked songs" : "Save to liked songs"}
              onClick={handleToggleLike}
              disabled={!likesHydrated || likePending || !currentSongId}
              className={cn(
                "wf-control-button flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                likePending ? "cursor-wait opacity-60" : "hover:bg-white/[0.09] hover:text-white",
                songIsLiked ? "text-[#1ed760]" : "text-white/[0.68]",
              )}
            >
              <Heart size={18} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
            </button>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col items-center gap-2">
          <div className="flex items-center justify-center gap-4">
            <button
              aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
              title={shuffle ? "Disable shuffle" : "Enable shuffle"}
              onClick={toggleShuffle}
              className={cn(
                "wf-control-button relative p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white",
                shuffle && "text-[#1ed760]",
              )}
            >
              <Shuffle size={18} />
              <span
                className={cn(
                  "absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[#1ed760] transition-opacity",
                  shuffle ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
            <button aria-label="Previous" onClick={previous} className="wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <SkipBack size={18} />
            </button>
            <button aria-label={isPlaying ? "Pause" : "Play"} onClick={handleTogglePlayback} className="wf-control-button h-9 w-9 rounded-full grid place-items-center bg-white text-black transition hover:scale-105">
              {isPlaying ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
            </button>
            <button aria-label="Next" onClick={next} className="wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <SkipForward size={18} />
            </button>
            <button aria-label="Repeat" onClick={cycleRepeatMode} className={cn("wf-control-button p-2 rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white", repeatMode !== "off" && "text-[#1ed760]")}>
              <Repeat size={18} />
            </button>
          </div>

          {currentSongIsRadio ? (
            <div className="flex w-full items-center gap-3">
              <span className="w-10 text-right text-[12px] font-semibold text-emerald-300">LIVE</span>
              <div className="h-1.5 w-full overflow-hidden rounded bg-white/[0.12]">
                <div className={cn("h-full w-full bg-emerald-500/75", isPlaying && "animate-pulse")} />
              </div>
              <span className="w-10 text-[12px] text-white/[0.62]">Radio</span>
            </div>
          ) : (
            <div className="flex w-full items-center gap-3">
              <span className="w-10 text-right text-[12px] tabular-nums text-white/[0.62]">{formatTime(safeCurrentTime)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, duration)}
                step={0.1}
                value={safeCurrentTime}
                onChange={(e) => onSeek(Number(e.target.value))}
                tabIndex={-1}
                onFocus={(e) => e.currentTarget.blur()}
                className="h-1.5 w-full appearance-none rounded bg-white/[0.12] accent-[#1ed760] focus:outline-none focus-visible:outline-none"
                style={{
                  background: `linear-gradient(to right, rgb(16 185 129) 0%, rgb(16 185 129) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
                }}
              />
              <span className="w-10 text-[12px] tabular-nums text-white/[0.62]">{formatTime(duration)}</span>
            </div>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          <button
            type="button"
            aria-label={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
            title={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
            onClick={toggleNowPlaying}
            className={cn(
              "wf-control-button flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
              nowPlayingOpen
                ? "bg-white/[0.08] text-[#1ed760]"
                : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
            )}
          >
            {nowPlayingOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
          <div className="hidden items-center gap-2 xl:flex">
            <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="wf-control-button rounded-full p-2 text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white">
              <VolumeIcon size={18} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              tabIndex={-1}
              onFocus={(e) => e.currentTarget.blur()}
              className="h-1.5 w-28 appearance-none rounded bg-white/[0.12] accent-[#1ed760] focus:outline-none focus-visible:outline-none"
            />
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export { PlayerBar };
export default PlayerBar;
