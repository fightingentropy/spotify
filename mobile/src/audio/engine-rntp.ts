import TrackPlayer, { Event, State } from "react-native-track-player";
import { toAbsoluteApiUrl } from "@/lib/config";
import { isPodcastSong } from "@/lib/player-song";
import {
  createPlayListen,
  flushPlayListen,
  type PlayListenEntry,
} from "@/lib/play-events";
import {
  isEpisodeFinished,
  markEpisodeFinished,
  PODCAST_PROGRESS_WRITE_INTERVAL_MS,
  PODCAST_RESUME_MIN_SECONDS,
  readEpisodeProgress,
  writeEpisodeProgressGuarded,
} from "@/lib/podcast-progress";
import { resolveOfflinePlaybackSong } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { buildTrack } from "@/audio/track";
import { setupTrackPlayer } from "@/audio/setup";
import {
  isOwnHandledSong,
  MAX_CONSECUTIVE_AUDIO_ERRORS,
  refreshCurrentSong,
} from "@/audio/refresh";
import { enforceSleepTimer } from "@/audio/sleep";
import {
  PLAYBACK_STATE_PUBLISH_INTERVAL_MS,
  publishPlaybackState,
  setLastPosition,
  takePendingResumeSeek,
} from "@/audio/playback-sync";
import { resetAudioProgress, setAudioProgress } from "@/audio/progress";
import type { PlayerSong } from "@/types/player";

// The RNTP single-player audio backend (Android + non-iOS fallback). On iOS the
// app uses engine-native.ts (dual-deck native crossfade) instead. Ported verbatim
// from the original engine.ts; cross-device resume, signed-URL refresh, sleep
// timer, and play-event tracking now live in shared modules.

let started = false;
let loadSeq = 0;
let lastLoadedKey: string | null = null;
let currentListen: PlayListenEntry | null = null;

// error circuit-breaker
let consecutiveErrors = 0;
let erroredSrcRetry: string | null = null;
// throttles
let lastPodcastWriteMs = 0;
let lastStatePublishMs = 0;

function trackKey(song: PlayerSong): string {
  return `${song.id}|${toAbsoluteApiUrl(song.audioUrl)}`;
}

// --- track loading ----------------------------------------------------------
async function loadCurrentSong(song: PlayerSong | null, isPlaying: boolean): Promise<void> {
  // Swap in the downloaded file:// copy if this song is available offline.
  const resolved = song ? resolveOfflinePlaybackSong(song) : null;
  const key = resolved ? trackKey(resolved) : null;
  if (key === lastLoadedKey) {
    await syncPlayState(isPlaying);
    return;
  }

  // Track boundary: flush the previous play-listen, arm a new one.
  flushPlayListen(currentListen);
  currentListen = song ? createPlayListen(song) : null;
  lastLoadedKey = key;
  erroredSrcRetry = null;

  const seq = ++loadSeq;
  if (!song || !resolved) {
    await TrackPlayer.reset();
    resetAudioProgress(0);
    return;
  }

  resetAudioProgress(song.duration ?? 0);
  await TrackPlayer.reset();
  if (seq !== loadSeq) return;
  await TrackPlayer.add(buildTrack(resolved));
  if (seq !== loadSeq) return;

  // Resume-seek injection (cross-device resume or podcast resume ≥10s).
  const resumeSeek = takePendingResumeSeek(song.id);
  if (resumeSeek != null) {
    await TrackPlayer.seekTo(resumeSeek);
  } else if (isPodcastSong(song)) {
    const progress = readEpisodeProgress(song.id);
    if (progress && progress.time >= PODCAST_RESUME_MIN_SECONDS && !isEpisodeFinished(progress)) {
      await TrackPlayer.seekTo(progress.time);
    }
  }
  if (seq !== loadSeq) return;

  await applyRate(song);
  if (isPlaying) await TrackPlayer.play();

  // double-404 / metadata refresh (fire-and-forget) — guards expired signed URLs.
  void refreshCurrentSong(song);
  void publishPlaybackState(true);
}

async function syncPlayState(isPlaying: boolean): Promise<void> {
  if (isPlaying) await TrackPlayer.play();
  else await TrackPlayer.pause();
}

async function applyVolume(): Promise<void> {
  const { volume, isMuted } = usePlayerStore.getState();
  await TrackPlayer.setVolume(isMuted ? 0 : volume);
}

async function applyRate(song: PlayerSong | null): Promise<void> {
  const rate = song && isPodcastSong(song) ? usePlayerStore.getState().playbackRate : 1;
  await TrackPlayer.setRate(rate);
}

// --- RNTP event handlers ----------------------------------------------------
async function onEnded(): Promise<void> {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (song && isPodcastSong(song)) markEpisodeFinished(song.id);

  if (s.repeatMode === "one") {
    // Replay in place; flush + rearm the play-listen.
    flushPlayListen(currentListen);
    currentListen = song ? createPlayListen(song) : null;
    await TrackPlayer.seekTo(0);
    await TrackPlayer.play();
    return;
  }
  if (s.sleepAtEndOfTrack) {
    s.pause();
    s.cancelSleepTimer();
    return;
  }
  flushPlayListen(currentListen);
  s.next(); // store advances → subscription loads the next track
}

async function onError(): Promise<void> {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song) return;
  // radio / offline / local handle their own failures; don't wedge on one of them.
  if (isOwnHandledSong(song)) return;

  const baseUrl = toAbsoluteApiUrl(song.audioUrl);
  const isHls = /\.m3u8(\?|$)/i.test(baseUrl);

  // Retry the same track ONCE with a cache-busted URL.
  if (!isHls && erroredSrcRetry !== baseUrl) {
    erroredSrcRetry = baseUrl;
    const busted = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}__retry=${Date.now()}`;
    const seq = ++loadSeq;
    await TrackPlayer.reset();
    if (seq !== loadSeq) return;
    await TrackPlayer.add({ ...buildTrack(song), url: busted });
    if (s.isPlaying) await TrackPlayer.play();
    return;
  }

  consecutiveErrors += 1;
  if (consecutiveErrors >= MAX_CONSECUTIVE_AUDIO_ERRORS) {
    consecutiveErrors = 0;
    erroredSrcRetry = null;
    s.pause(); // stop — don't loop a dead queue forever
    return;
  }
  erroredSrcRetry = null;
  s.next(); // skip
}

function onProgress(position: number, duration: number): void {
  setLastPosition(position);
  setAudioProgress(position, duration);
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song) return;

  // play-listen tracking → fire play-event at 30s OR ≥50%.
  if (currentListen) {
    if (position > currentListen.maxPositionSeconds) currentListen.maxPositionSeconds = position;
    if (Number.isFinite(duration) && duration > 0) currentListen.durationSeconds = duration;
    flushPlayListen(currentListen); // no-op until the threshold is crossed
  }

  // podcast progress write (~5s).
  if (isPodcastSong(song)) {
    const now = Date.now();
    if (now - lastPodcastWriteMs >= PODCAST_PROGRESS_WRITE_INTERVAL_MS) {
      lastPodcastWriteMs = now;
      writeEpisodeProgressGuarded(song.id, position, duration);
    }
  }

  enforceSleepTimer();

  // cross-device resume publish (~8s while playing).
  if (s.isPlaying && Date.now() - lastStatePublishMs >= PLAYBACK_STATE_PUBLISH_INTERVAL_MS) {
    lastStatePublishMs = Date.now();
    void publishPlaybackState(false);
  }
}

// --- store subscription -----------------------------------------------------
function subscribeToStore(): void {
  let prev = usePlayerStore.getState();
  usePlayerStore.subscribe((state) => {
    const songChanged = state.currentSong?.id !== prev.currentSong?.id ||
      state.currentSong?.audioUrl !== prev.currentSong?.audioUrl;
    if (songChanged) {
      void loadCurrentSong(state.currentSong, state.isPlaying);
    } else if (state.isPlaying !== prev.isPlaying) {
      void syncPlayState(state.isPlaying);
      void publishPlaybackState(true);
    }
    if (state.volume !== prev.volume || state.isMuted !== prev.isMuted) void applyVolume();
    if (state.playbackRate !== prev.playbackRate) void applyRate(state.currentSong);
    prev = state;
  });
}

// UI seek (Scrubber / remote) on the RNTP backend.
export async function seekRntp(seconds: number): Promise<void> {
  const position = Math.max(0, seconds);
  setLastPosition(position);
  await TrackPlayer.seekTo(position);
}

export async function initRntpAudio(): Promise<void> {
  if (started) return;
  started = true;

  await setupTrackPlayer();

  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
    void onEnded();
  });
  TrackPlayer.addEventListener(Event.PlaybackError, () => {
    void onError();
  });
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
    onProgress(position, duration);
  });
  TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
    // reset the error breaker once the track is actually playing.
    if (state === State.Playing) {
      consecutiveErrors = 0;
      erroredSrcRetry = null;
    }
  });

  subscribeToStore();
  await applyVolume();

  // If a song was already current (e.g. restored before init), load it.
  const { currentSong, isPlaying } = usePlayerStore.getState();
  if (currentSong) await loadCurrentSong(currentSong, isPlaying);
}
