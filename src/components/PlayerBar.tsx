"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn, formatTime } from "@/lib/utils";
import { ChevronDown, ChevronUp, Heart, Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Volume2, VolumeX } from "lucide-react";
import NowPlayingSheet from "@/components/NowPlayingSheet";
import { CoverImage } from "@/components/CoverImage";
import { isBrowserLocalSong } from "@/store/browser-local-library";
import { useMediaSession } from "@/lib/use-media-session";

function resolvePlayableSrc(src: string): string {
  if (/^(blob:|data:|https?:)/i.test(src)) return src;
  return `${location.origin}${src}`;
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
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const toggle = usePlayerStore((s) => s.toggle);
  const play = usePlayerStore((s) => s.play);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setSong = usePlayerStore((s) => s.setSong);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const replaceSong = usePlayerStore((s) => s.replaceSong);
  const pause = usePlayerStore((s) => s.pause);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  const navigate = useNavigate();
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);

  const currentSongId = currentSong?.id ?? null;
  const currentSongIsBrowserLocal = isBrowserLocalSong(currentSong);
  const songIsLiked = currentSongId ? !!likedLookup[currentSongId] : false;
  const likePending = currentSongId ? !!pendingLookup[currentSongId] : false;

  const handleToggleLike = useCallback(async () => {
    if (!currentSongId || !likesHydrated || likePending) return;
    const result = await toggleLike(currentSongId, !songIsLiked);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }, [currentSongId, likesHydrated, likePending, toggleLike, songIsLiked, navigate]);

  // Dual audio elements for real crossfade
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
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
  const suppressAutoLoadRef = useRef<boolean>(false);
  const volumeRef = useRef<number>(volume);
  const mutedRef = useRef<boolean>(isMuted);

  const savedSeekRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);

  const src = currentSong?.audioUrl || null;

  const onSeek = useCallback((value: number) => {
    const active = getActiveAudio();
    const inactive = getInactiveAudio();
    if (!active || !duration) return;
    const nextTime = Math.max(0, Math.min(duration, value));
    active.currentTime = nextTime;
    if (crossfadingRef.current && inactive) {
      try {
        inactive.currentTime = Math.max(0, Math.min(inactive.duration || nextTime, nextTime));
      } catch {}
    }
    setCurrentTime(nextTime);
  }, [duration, getActiveAudio, getInactiveAudio]);

  useMediaSession({
    song: currentSong,
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
      if (isPlaying) active?.play().catch(() => {});
      else try { active?.pause(); } catch {}
      // Keep inactive paused when not crossfading
      if (inactive && inactive !== active) {
        try { inactive.pause(); } catch {}
        inactive.currentTime = inactive.currentTime; // noop to avoid iOS suspending issues
      }
    }
  }, [isPlaying, activeIdx, getActiveAudio, getInactiveAudio]);

  // Restore last played queue/song and time on client mount to avoid SSR mismatches
  useEffect(() => {
    try {
      const raw = localStorage.getItem("spotify_player_state");
      if (!raw) return;
      const data = JSON.parse(raw) as
        | {
            queue?: PlayerSong[];
            currentIndex?: number;
            song?: PlayerSong;
            currentTime?: number;
            isPlaying?: boolean;
          }
        | null;
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
  }, [setSong, setQueue, pause]);

  useEffect(() => {
    if (!currentSongId || currentSongIsBrowserLocal) return;

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
  }, [currentSongId, currentSongIsBrowserLocal, replaceSong]);

  // Load current song into the ACTIVE element when not crossfading
  useEffect(() => {
    if (suppressAutoLoadRef.current) return;
    const audio = getActiveAudio();
    const other = getInactiveAudio();
    if (!audio) return;
    if (!src) {
      audio.pause();
      if (other) other.pause();
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    const absolute = src ? resolvePlayableSrc(src) : null;
    if (absolute && audio.src !== absolute) audio.src = absolute;
    if (other && other !== audio) {
      // Ensure the inactive element is quiet and not playing
      try { other.pause(); } catch {}
      other.volume = 0;
    }
    if (isPlaying) audio.play().catch(() => { pause(); });
    else audio.pause();
  }, [src, isPlaying, pause, getActiveAudio, getInactiveAudio]);

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
            let idx = currentIndex;
            while (idx === currentIndex) {
              idx = Math.floor(Math.random() * queue.length);
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

        // Prepare incoming track
        suppressAutoLoadRef.current = true;
        const absoluteNext = nextSong.audioUrl ? resolvePlayableSrc(nextSong.audioUrl) : null;
        if (absoluteNext && incoming.src !== absoluteNext) incoming.src = absoluteNext;
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
            // Switch UI/active element now that audio is already running
            setQueue(queue, nextIdx);
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
    };
  }, [crossfadeEnabled, crossfadeSeconds, duration, isPlaying, repeatMode]);

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
  }, [queue, currentIndex, currentSong, currentTime, isPlaying, activeIdx]);

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
      const total = Number.isFinite(audio.duration) ? audio.duration : duration;
      if (!total || Number.isNaN(total)) return;
      const nextTime = Math.max(0, Math.min(total, (audio.currentTime || 0) + seconds));
      audio.currentTime = nextTime;
      setCurrentTime(nextTime);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      // Spacebar toggles play/pause
      if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
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
  }, [next, previous, duration, toggle, getActiveAudio]);

  if (!currentSong) return null;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : Volume2;

  return (
    <>
      <NowPlayingSheet
        open={nowPlayingOpen}
        onClose={() => setNowPlayingOpen(false)}
        song={currentSong}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        onSeek={onSeek}
      />
      <div className="fixed inset-x-0 z-40 border-t border-black/10 dark:border-white/10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85 bottom-[calc(var(--wf-mobile-nav-height)+env(safe-area-inset-bottom))] lg:bottom-0">
      <audio
        ref={audioARef}
        hidden
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          if (audio !== getActiveAudio()) return;
          setDuration(audio.duration || 0);
          const pending = savedSeekRef.current;
          if (typeof pending === "number") {
            const clamped = Math.max(0, Math.min(audio.duration || 0, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) setCurrentTime(e.currentTarget.currentTime || 0);
        }}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one") {
            audio.currentTime = 0;
            audio.play().catch(() => {});
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
          setDuration(audio.duration || 0);
          const pending = savedSeekRef.current;
          if (typeof pending === "number") {
            const clamped = Math.max(0, Math.min(audio.duration || 0, pending));
            audio.currentTime = clamped;
            setCurrentTime(clamped);
            savedSeekRef.current = null;
          }
          audio.volume = isMuted ? 0 : volume;
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget === getActiveAudio()) setCurrentTime(e.currentTarget.currentTime || 0);
        }}
        onEnded={(e) => {
          if (e.currentTarget !== getActiveAudio()) return;
          if (crossfadingRef.current) return;
          const audio = e.currentTarget;
          if (repeatMode === "one") {
            audio.currentTime = 0;
            audio.play().catch(() => {});
            return;
          }
          next();
        }}
      />
      {/* Mobile mini player */}
      <div className="lg:hidden relative">
        <div
          className="absolute inset-x-0 top-0 h-0.5 bg-black/10 dark:bg-white/10"
          aria-hidden
        >
          <div
            className="h-full bg-emerald-500 transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="h-[var(--wf-mobile-player-height)] px-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setNowPlayingOpen(true)}
            className="flex items-center gap-3 min-w-0 flex-1 text-left touch-manipulation"
            aria-label="Open now playing"
          >
            <CoverImage
              src={currentSong.imageUrl || "/apple-icon.png"}
              alt="cover"
              width={48}
              height={48}
              className="w-12 h-12 rounded-md object-cover shrink-0"
              sizes="48px"
            />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{currentSong.title}</div>
              <div className="text-xs opacity-70 truncate">{currentSong.artist}</div>
            </div>
          </button>
          <button
            type="button"
            aria-label={songIsLiked ? "Remove from liked songs" : "Save to liked songs"}
            onClick={handleToggleLike}
            disabled={!likesHydrated || likePending || !currentSongId}
            className={cn(
              "h-11 w-11 rounded-full grid place-items-center touch-manipulation shrink-0",
              likePending ? "opacity-60" : "",
              songIsLiked ? "text-emerald-500" : "text-foreground/70",
            )}
          >
            <Heart size={20} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
          </button>
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={toggle}
            className="h-11 w-11 rounded-full grid place-items-center bg-foreground text-background touch-manipulation shrink-0"
          >
            {isPlaying ? <Pause size={20} /> : <Play size={20} className="translate-x-[1px]" />}
          </button>
        </div>
      </div>

      {/* Desktop player */}
      <div className="hidden lg:block max-w-7xl mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className="hidden sm:block">
              <CoverImage
                src={currentSong.imageUrl || "/apple-icon.png"}
                alt="cover"
                width={48}
                height={48}
                className="w-12 h-12 rounded object-cover"
                sizes="48px"
              />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{currentSong.title}</div>
              <div className="text-xs opacity-70 truncate">{currentSong.artist}</div>
            </div>
            <button
              type="button"
              aria-label={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
              title={nowPlayingOpen ? "Collapse now playing" : "Open now playing"}
              onClick={() => setNowPlayingOpen((open) => !open)}
              className={cn(
                "flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                nowPlayingOpen
                  ? "text-emerald-500 bg-black/10 dark:bg-white/10"
                  : "text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10",
              )}
            >
              {nowPlayingOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </button>
            <button
              type="button"
              aria-label={songIsLiked ? "Remove from liked songs" : "Save to liked songs"}
              title={songIsLiked ? "Remove from liked songs" : "Save to liked songs"}
              onClick={handleToggleLike}
              disabled={!likesHydrated || likePending || !currentSongId}
              className={cn(
                "flex-shrink-0 h-9 w-9 rounded-full grid place-items-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                likePending ? "opacity-60 cursor-wait" : "hover:bg-black/10 hover:dark:bg-white/10",
                songIsLiked ? "text-emerald-500" : "text-foreground/70",
              )}
            >
              <Heart size={18} className={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
            </button>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums opacity-70 w-10 text-right">{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, duration)}
                step={0.1}
                value={currentTime}
                onChange={(e) => onSeek(Number(e.target.value))}
                tabIndex={-1}
                onFocus={(e) => e.currentTarget.blur()}
                className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500 focus:outline-none focus-visible:outline-none"
                style={{
                  background: `linear-gradient(to right, rgb(16 185 129) 0%, rgb(16 185 129) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
                }}
              />
              <span className="text-xs tabular-nums opacity-70 w-10">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <button aria-label="Shuffle" onClick={toggleShuffle} className={cn("p-2 rounded-full", shuffle && "text-emerald-500")}>
              <Shuffle size={18} />
            </button>
            <button aria-label="Previous" onClick={previous} className="p-2 rounded-full">
              <SkipBack size={18} />
            </button>
            <button aria-label={isPlaying ? "Pause" : "Play"} onClick={toggle} className="h-9 w-9 rounded-full grid place-items-center bg-foreground text-background">
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button aria-label="Next" onClick={next} className="p-2 rounded-full">
              <SkipForward size={18} />
            </button>
            <button aria-label="Repeat" onClick={cycleRepeatMode} className={cn("p-2 rounded-full", repeatMode !== "off" && "text-emerald-500")}>
              <Repeat size={18} />
            </button>

            <div className="hidden sm:flex items-center gap-2 ml-2">
              <button aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute} className="p-2 rounded-full">
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
                className="w-28 h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500 focus:outline-none focus-visible:outline-none"
              />
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export { PlayerBar };
export default PlayerBar;
