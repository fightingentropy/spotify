"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { parseCredits } from "@/lib/credits";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Heart,
  ListMusic,
  MicVocal,
  Moon,
  Pause,
  Play,
  Podcast,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useNavigate } from "react-router";
import { formatPlaybackRate, nextPlaybackRate, SLEEP_TIMER_MINUTE_OPTIONS, sleepTimerRemainingMinutes, usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { songLikeId } from "@spotify/shared/catalog-like";
import type { PlayerSong } from "@/types/player";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn, formatTime } from "@/lib/utils";
import { CoverImage } from "@/components/CoverImage";
import { useLyricsNavigation } from "@/lib/use-lyrics-navigation";
import { MarqueeText } from "@/components/MarqueeText";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";

// Horizontal artwork-swipe distance (px) that commits to a track change.
const COVER_SWIPE_COMMIT_PX = 64;

type NowPlayingSheetProps = {
  open: boolean;
  // Suspends the Escape-to-close handler while a sheet stacked on top (the
  // queue sheet) is open, so one press closes only the topmost sheet.
  escapeDisabled?: boolean;
  onClose: () => void;
  onOpenQueue: () => void;
  song: PlayerSong;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onSeek: (value: number) => void;
};

export default function NowPlayingSheet({
  open,
  escapeDisabled = false,
  onClose,
  onOpenQueue,
  song,
  isPlaying,
  currentTime,
  duration,
  onSeek,
}: NowPlayingSheetProps) {
  const navigate = useNavigate();
  const { openLyrics } = useLyricsNavigation();
  const play = usePlayerStore((s) => s.play);
  const pause = usePlayerStore((s) => s.pause);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtEndOfTrack = usePlayerStore((s) => s.sleepAtEndOfTrack);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const startSleepTimer = usePlayerStore((s) => s.startSleepTimer);
  const setSleepAtEndOfTrack = usePlayerStore((s) => s.setSleepAtEndOfTrack);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const likesHydrated = useLikesStore((state) => state.hydrated);

  const liveStream = isRadioSong(song);
  const podcastEpisode = isPodcastSong(song);
  const showLibraryActions = !liveStream && !podcastEpisode;
  const songIsLiked = !!likedLookup[songLikeId(song, likedLookup)];
  const likePending = !!pendingLookup[songLikeId(song, pendingLookup)];
  const podcastDescription = song.description?.trim() ?? "";

  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  // UI nicety only (refreshes the remaining-minutes label); expiry enforcement
  // lives in PlayerBar's timeupdate handler and 8s sync interval.
  const [, setSleepTimerTick] = useState(0);
  const sleepTimerActive = sleepTimerEndsAt != null || sleepAtEndOfTrack;
  const sleepTimerRemaining = sleepTimerEndsAt != null ? sleepTimerRemainingMinutes(sleepTimerEndsAt) : null;
  const sleepTimerTitle =
    sleepTimerRemaining != null
      ? `Sleep timer: ${sleepTimerRemaining} min left`
      : sleepAtEndOfTrack
        ? "Sleep timer: end of track"
        : "Sleep timer";
  const touchStartYRef = useRef<number | null>(null);
  const swipeDismissAllowedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Trap focus inside the sheet while it's the topmost surface; defer to the
  // queue sheet (escapeDisabled) when it's stacked on top.
  useModalDialogFocus(open, panelRef, { enabled: !escapeDisabled });
  // Horizontal swipe on the artwork to skip tracks (mobile). The axis is locked
  // on the first move so it never fights the vertical swipe-to-dismiss or scroll.
  const coverSwipeRef = useRef<{ startX: number; startY: number; axis: "x" | "y" | null; dx: number } | null>(null);
  const [coverDragX, setCoverDragX] = useState(0);
  const [coverSwiping, setCoverSwiping] = useState(false);

  const credits = useMemo(() => parseCredits(song.artist), [song.artist]);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const lyricsAvailable = showLibraryActions && !!song.lyricsUrl;

  useEffect(() => {
    if (!open || escapeDisabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (sleepMenuOpen) {
          setSleepMenuOpen(false);
          return;
        }
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [escapeDisabled, onClose, open, sleepMenuOpen]);

  useEffect(() => {
    if (!open || sleepTimerEndsAt == null) return;
    const intervalId = window.setInterval(() => setSleepTimerTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(intervalId);
  }, [open, sleepTimerEndsAt]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("wf-now-playing-open");
    return () => {
      // The queue sheet may still be open on top; keep the body scroll lock
      // until every sheet has closed.
      if (document.querySelector('.wf-now-playing-panel[data-open="true"]')) return;
      document.body.classList.remove("wf-now-playing-open");
    };
  }, [open]);

  async function handleToggleLike() {
    if (!showLibraryActions || !likesHydrated || likePending) return;
    const result = await toggleLike(song.id, !songIsLiked, song);
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }

  function handleTogglePlayback() {
    if (isPlaying) {
      pause();
      return;
    }
    requestImmediatePlayback(song);
    play();
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
    // Only allow swipe-to-dismiss when the scroll container is already at the
    // top (so a downward drag isn't actually scrolling content) and the touch
    // didn't start on the seek/range input (so dragging the scrubber down can't
    // close the sheet).
    const target = event.target;
    const startedOnRange =
      target instanceof HTMLInputElement && target.type.toLowerCase() === "range";
    const atTop = (scrollContainerRef.current?.scrollTop ?? 0) <= 0;
    swipeDismissAllowedRef.current = atTop && !startedOnRange;
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY;
    const dismissAllowed = swipeDismissAllowedRef.current;
    touchStartYRef.current = null;
    swipeDismissAllowedRef.current = false;
    if (!dismissAllowed || startY == null || endY == null) return;
    if (endY - startY > 80) {
      onClose();
    }
  }

  function handleCoverTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    coverSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, axis: null, dx: 0 };
    setCoverSwiping(true);
  }

  function handleCoverTouchMove(event: TouchEvent<HTMLDivElement>) {
    const swipe = coverSwipeRef.current;
    const touch = event.touches[0];
    if (!swipe || !touch) return;
    const dx = touch.clientX - swipe.startX;
    const dy = touch.clientY - swipe.startY;
    if (swipe.axis === null) {
      // Wait until there's enough movement to tell intent apart, then lock.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (swipe.axis !== "x") return;
    // Horizontal: take over. Cancel the sheet's vertical swipe-to-dismiss and
    // follow the finger so the artwork tracks the gesture.
    swipeDismissAllowedRef.current = false;
    swipe.dx = dx;
    setCoverDragX(dx);
  }

  function handleCoverTouchEnd() {
    const swipe = coverSwipeRef.current;
    coverSwipeRef.current = null;
    setCoverSwiping(false);
    setCoverDragX(0);
    if (!swipe || swipe.axis !== "x") return;
    if (swipe.dx <= -COVER_SWIPE_COMMIT_PX) {
      next();
    } else if (swipe.dx >= COVER_SWIPE_COMMIT_PX) {
      previous();
    }
  }

  return (
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
      <button
        type="button"
        className={cn(
          "wf-sheet-backdrop absolute inset-0 bg-black/[0.76] transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        disabled={!open}
        data-open={open ? "true" : "false"}
        data-preserve-playback-keys
        aria-label="Close now playing view"
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Now playing: ${song.title}`}
        tabIndex={-1}
        inert={!open}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          "wf-now-playing-panel absolute inset-x-0 bottom-0 top-[6dvh] overflow-hidden rounded-t-2xl border-t border-white/[0.08] bg-[#1a1a1a]",
          "lg:inset-auto lg:left-0 lg:right-0 lg:top-14 lg:bottom-[84px] lg:mx-auto lg:max-w-3xl lg:rounded-lg lg:border lg:border-white/[0.08]",
          open
            ? "translate-y-0 opacity-100"
            : "translate-y-full opacity-0 lg:translate-y-8 lg:opacity-0",
        )}
        data-open={open ? "true" : "false"}
      >
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] lg:pb-0"
        >
          <div className="flex min-h-full flex-col px-6 pb-5">
            <div className="flex items-center justify-between py-2">
              <button
                type="button"
                onClick={onClose}
                data-preserve-playback-keys
                className="wf-control-button -ml-2 grid h-11 w-11 place-items-center rounded-full text-white/60 touch-manipulation active:bg-white/[0.06]"
                aria-label="Collapse now playing"
              >
                <ChevronDown size={24} />
              </button>
              <div className="text-sm font-medium text-white/[0.58]">
                {liveStream ? "Radio" : podcastEpisode ? "Podcast" : "Now Playing"}
              </div>
              <div className="h-11 w-11" />
            </div>

            <div className="mx-auto flex h-12 w-full max-w-[356px] items-center justify-around px-2.5">
                {showLibraryActions ? (
                  <>
                    <button
                      type="button"
                      aria-label={likePending ? "Updating liked songs" : songIsLiked ? "In liked songs" : "Save to liked songs"}
                      aria-busy={likePending}
                      onClick={handleToggleLike}
                      disabled={!likesHydrated || likePending}
                      className={cn(
                        "h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                        "wf-control-button",
                        likePending ? "animate-pulse opacity-60" : "active:bg-white/[0.06]",
                        songIsLiked ? "text-white/[0.94]" : "text-white/50",
                      )}
                    >
                      <Heart size={22} className={cn(songIsLiked && "fill-white text-white/[0.94]")} />
                    </button>
                  </>
                ) : null}
                {lyricsAvailable ? (
                  <button
                    type="button"
                    aria-label="Open lyrics"
                    data-preserve-playback-keys
                    title="Open lyrics"
                    onClick={() => { onClose(); openLyrics(); }}
                    className="wf-control-button h-11 w-11 rounded-full grid place-items-center text-white/50 active:bg-white/[0.06] touch-manipulation"
                  >
                    <MicVocal size={22} />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={sleepTimerTitle}
                  aria-expanded={sleepMenuOpen}
                  title={sleepTimerTitle}
                  onClick={() => setSleepMenuOpen((value) => !value)}
                  className={cn(
                    "wf-control-button relative h-11 w-11 rounded-full grid place-items-center active:bg-white/[0.06] touch-manipulation",
                    sleepTimerActive ? "text-white/[0.94]" : "text-white/50",
                  )}
                >
                  <Moon size={20} />
                  <span
                    className={cn(
                      "absolute bottom-1.5 h-1 w-1 rounded-full bg-white transition-opacity",
                      sleepTimerActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Open queue"
                  title="Open queue"
                  onClick={onOpenQueue}
                  className="wf-control-button grid h-11 w-11 place-items-center rounded-full text-white/50 touch-manipulation active:bg-white/[0.06]"
                >
                  <ListMusic size={22} />
                </button>
            </div>

            <div className="mx-auto flex w-full max-w-[356px] flex-1 flex-col justify-center gap-5 lg:max-w-md">
                <div
                  className="mx-auto w-[min(100%,39dvh)] lg:w-full"
                  onTouchStart={handleCoverTouchStart}
                  onTouchMove={handleCoverTouchMove}
                  onTouchEnd={handleCoverTouchEnd}
                  onTouchCancel={handleCoverTouchEnd}
                  style={{
                    transform: coverDragX ? `translateX(${coverDragX}px)` : undefined,
                    transition: coverSwiping ? "none" : "transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)",
                    touchAction: "pan-y",
                  }}
                >
                  <div className="wf-now-playing-art w-full overflow-hidden rounded bg-[#1a1a1a]">
                    <CoverImage
                      src={song.imageUrl || "/apple-icon.png"}
                      networkSrc={song.networkImageUrl}
                      alt={song.title}
                      width={1200}
                      height={1200}
                      loading="eager"
                      className="w-full aspect-square object-cover"
                      sizes="(max-width: 768px) 100vw, 448px"
                    />
                  </div>
                </div>
              <div className="mt-[-1px] text-left">
                <MarqueeText text={song.title} className="text-[23px] font-semibold leading-7 text-white/[0.94]" />
                <MarqueeText text={song.artist} className="mt-0.5 text-[15px] text-white/[0.58]" />
              </div>

              {liveStream ? (
                <div className="space-y-2">
                  <div className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div className={cn("h-full w-full bg-white/[0.82]", isPlaying && "animate-pulse")} />
                  </div>
                  <div className="flex justify-between text-xs font-semibold text-white/[0.72]">
                    <span>LIVE</span>
                    <span>Radio</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, duration)}
                    step={0.1}
                    value={currentTime}
                    aria-label="Playback position"
                    onChange={(event) => onSeek(Number(event.target.value))}
                    className="h-0.5 w-full appearance-none rounded-full bg-white/[0.18] accent-white touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    style={{
                      background: `linear-gradient(to right, rgba(242,242,242,0.94) 0%, rgba(242,242,242,0.94) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
                    }}
                  />
                  <div className="flex justify-between text-xs tabular-nums opacity-70">
                    <span>{formatTime(currentTime)}</span>
                    <span>-{formatTime(Math.max(0, duration - currentTime))}</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between px-2">
                <button
                  type="button"
                  aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  title={shuffle ? "Disable shuffle" : "Enable shuffle"}
                  onClick={toggleShuffle}
                  className={cn(
                    "wf-control-button relative h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    shuffle ? "text-white/[0.94]" : "text-white/50",
                  )}
                >
                  <Shuffle size={20} />
                  <span
                    className={cn(
                      "absolute bottom-1.5 h-1 w-1 rounded-full bg-white transition-opacity",
                      shuffle ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
                {/* prev / play / next grouped with a real gap so a Next tap that
                    drifts left can't land on the big play/pause button. */}
                <div className="flex items-center gap-[18px]">
                  <button
                    type="button"
                    aria-label="Previous"
                    onClick={previous}
                    className="wf-control-button grid h-12 w-12 place-items-center rounded-full touch-manipulation"
                  >
                    <SkipBack size={27} fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    aria-label={isPlaying ? "Pause" : "Play"}
                    onClick={handleTogglePlayback}
                    className="wf-control-button grid h-16 w-16 place-items-center rounded-full bg-white text-black touch-manipulation"
                  >
                    {isPlaying ? (
                      <Pause size={26} fill="currentColor" />
                    ) : (
                      <Play size={27} fill="currentColor" className="translate-x-[2px]" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Next"
                    onClick={next}
                    className="wf-control-button grid h-12 w-12 place-items-center rounded-full touch-manipulation"
                  >
                    <SkipForward size={27} fill="currentColor" />
                  </button>
                </div>
                <button
                  type="button"
                  aria-label="Repeat"
                  onClick={cycleRepeatMode}
                  className={cn(
                    "wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation",
                    repeatMode !== "off" ? "text-white/[0.94]" : "text-white/50",
                  )}
                >
                  <Repeat size={20} />
                </button>
              </div>

            </div>

            {showLibraryActions ? (
              // Credits card is desktop-only; hide the wrapper on mobile so
              // its margin doesn't add dead space under the controls.
              <div className="hidden lg:block lg:mt-5 space-y-4">
                <div className="rounded-md border border-black/10 dark:border-white/10 p-4 hidden lg:block">
                  <div className="font-medium mb-3">Credits</div>
                  <div className="space-y-3">
                    {credits.map((credit) => (
                      <div key={`${credit.name}-${credit.role}`} className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{credit.name}</div>
                          <div className="text-sm opacity-70">{credit.role}</div>
                        </div>
                        <CheckCircle2 size={16} className="opacity-50 mt-1" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : podcastEpisode ? (
              <div className="mt-6 rounded-md border border-white/[0.08] p-4 lg:mt-5">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white/60">
                    <Podcast size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Podcast Episode</div>
                    <div className="text-sm opacity-70">{song.artist}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Playback speed: ${formatPlaybackRate(playbackRate)}`}
                    title="Playback speed"
                    onClick={() => setPlaybackRate(nextPlaybackRate(playbackRate))}
                    className="wf-control-button h-9 shrink-0 rounded-full border border-white/[0.12] px-3 text-sm font-semibold tabular-nums touch-manipulation active:bg-white/[0.06]"
                  >
                    {formatPlaybackRate(playbackRate)}
                  </button>
                </div>
                {podcastDescription ? (
                  <p className="mt-3 line-clamp-4 text-sm leading-6 opacity-75">{podcastDescription}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Sleep timer bottom sheet (stacks inside this section; the section
            is the containing block, so it hugs the sheet's bottom edge). */}
        <button
          type="button"
          aria-label="Close sleep timer menu"
          onClick={() => setSleepMenuOpen(false)}
          className={cn(
            "absolute inset-0 z-30 cursor-default bg-black/60 transition-opacity",
            sleepMenuOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          tabIndex={sleepMenuOpen ? 0 : -1}
        />
        <div
          role="dialog"
          aria-label="Sleep timer"
          aria-hidden={!sleepMenuOpen}
          className={cn(
            "absolute inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-white/[0.08] bg-[#1a1a1a] pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-2xl transition-transform duration-300",
            sleepMenuOpen ? "translate-y-0" : "pointer-events-none translate-y-full",
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-black/20 dark:bg-white/20" />
          <div className="px-6 pb-1 pt-3 text-center">
            <div className="text-sm font-semibold">Sleep timer</div>
            <div className={cn("mt-0.5 text-xs", sleepTimerActive ? "text-white" : "opacity-60")}>
              {sleepTimerRemaining != null
                ? `Music stops in ${sleepTimerRemaining} min`
                : sleepAtEndOfTrack
                  ? "Music stops at the end of this track"
                  : "Stop the music after a while"}
            </div>
          </div>
          <div className="px-3 pt-1">
            {SLEEP_TIMER_MINUTE_OPTIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => {
                  startSleepTimer(minutes);
                  setSleepMenuOpen(false);
                }}
                tabIndex={sleepMenuOpen ? 0 : -1}
                className="wf-control-button flex h-12 w-full items-center rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
              >
                {minutes} minutes
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setSleepAtEndOfTrack();
                setSleepMenuOpen(false);
              }}
              tabIndex={sleepMenuOpen ? 0 : -1}
              className={cn(
                "wf-control-button flex h-12 w-full items-center justify-between rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation",
                sleepAtEndOfTrack && "text-white",
              )}
            >
              End of track
              {sleepAtEndOfTrack ? <Check size={18} /> : null}
            </button>
          </div>
          {sleepTimerActive ? (
            <div className="mt-1 border-t border-black/10 px-3 pt-1 dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  cancelSleepTimer();
                  setSleepMenuOpen(false);
                }}
                tabIndex={sleepMenuOpen ? 0 : -1}
                className="wf-control-button flex h-12 w-full items-center justify-center rounded-lg px-3 text-[15px] font-semibold text-white touch-manipulation active:bg-white/[0.06]"
              >
                Turn off timer
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
