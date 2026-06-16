import { useCallback, useState } from "react";
import type { DiscoverTrack } from "@/client/api";
import { resolveOfflinePlaybackSong, useOfflineStore } from "@/client/offline";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

type DiscoverPlaybackSong = PlayerSong & {
  album?: string | null;
  duration?: number | null;
  durationMs?: number | null;
};

export type UseDiscoverPlayback = {
  importingId: string | null;
  importError: string | null;
  isPlaying: boolean;
  isActive: (track: DiscoverTrack) => boolean;
  // Active track → toggle play/pause; otherwise play it. Staged tracks play
  // instantly; unstaged ones are materialized on demand via /api/discover/stage.
  toggle: (track: DiscoverTrack) => void;
};

// Shared play behavior for Discover-shaped tracks (the Home "Discover" row and
// curated playlists). Tracks play WITHOUT being added to the library — exactly
// like tapping a Discover tile. Extracted so both surfaces stay in lockstep.
export function useDiscoverPlayback(): UseDiscoverPlayback {
  const setQueue = usePlayerStore((state) => state.setQueue);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const currentDiscoverTrackId = usePlayerStore((state) => state.currentSong?.discoverTrackId ?? null);

  // Subscribe to a stable signature of only the downloaded record ids so
  // per-tick progress updates on an active download don't churn resolveSong.
  const offlineRecordsSignature = useOfflineStore((state) => {
    const ids: string[] = [];
    for (const id of Object.keys(state.records)) {
      if (state.records[id]?.status === "downloaded") ids.push(id);
    }
    return ids.sort().join("|");
  });
  const resolveSong = useCallback(
    (song: DiscoverPlaybackSong): DiscoverPlaybackSong => resolveOfflinePlaybackSong(song) as DiscoverPlaybackSong,
    [offlineRecordsSignature],
  );

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const playTrack = useCallback(
    async (track: DiscoverTrack) => {
      // Instant path: already pre-downloaded — play straight from staging.
      if (track.staged && track.audioUrl && track.audioId) {
        const song = resolveSong({
          id: track.audioId,
          title: track.title,
          artist: track.artist,
          album: track.album || undefined,
          imageUrl: track.imageUrl,
          audioUrl: track.audioUrl,
          duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
          source: "server",
          staged: true,
          discoverTrackId: track.id,
        } as DiscoverPlaybackSong);
        requestImmediatePlayback(song);
        setQueue([song], 0);
        return;
      }

      // Not staged yet: materialize this one track on demand, then play it.
      if (importingId) return;
      setImportingId(track.id);
      setImportError(null);
      try {
        const res = await fetch("/api/discover/stage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            spotifyUrl: track.spotifyUrl,
            region: "US",
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationMs: track.durationMs ?? undefined,
            imageUrl: track.imageUrl,
            qualityProfile: "max",
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Couldn't load this track (${res.status})`);
        }
        const song = resolveSong((await res.json()) as DiscoverPlaybackSong);
        requestImmediatePlayback(song);
        setQueue([song], 0);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Couldn't load this track");
      } finally {
        setImportingId(null);
      }
    },
    [importingId, resolveSong, setQueue],
  );

  const isActive = useCallback(
    (track: DiscoverTrack) => currentDiscoverTrackId != null && currentDiscoverTrackId === track.id,
    [currentDiscoverTrackId],
  );

  const toggle = useCallback(
    (track: DiscoverTrack) => {
      if (isActive(track)) {
        if (isPlaying) pause();
        else play();
        return;
      }
      void playTrack(track);
    },
    [isActive, isPlaying, pause, play, playTrack],
  );

  return { importingId, importError, isPlaying, isActive, toggle };
}
