import { discoverTrackToPlayerSong } from "@/lib/discover-queue";
import { apiFetch } from "@/lib/http";
import type { DiscoverTrack } from "@/lib/api";
import type { PlayerSong } from "@/types/player";

// Smart Shuffle client glue. A recommendation is just a Discover track (same
// shape, same staging pipeline), so it becomes a queue entry via the existing
// discoverTrackToPlayerSong placeholder path; the only extra is the `recommended`
// flag (see player.ts — authoritative membership is the store's recommendedIds
// Set, this is initial-insert sugar). fetchRecommendations is the stateless
// POST contract the Worker implements; the client sends seeds + exclude sets.

export function recommendationToPlayerSong(track: DiscoverTrack): PlayerSong {
  return { ...discoverTrackToPlayerSong(track), recommended: true };
}

export async function fetchRecommendations(input: {
  contextKey?: string;
  seeds: { title: string; artist: string }[];
  exclude?: { title: string; artist: string }[];
  excludeIds?: string[];
  limit?: number;
}): Promise<DiscoverTrack[]> {
  const res = await apiFetch("/api/smart-shuffle/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as { tracks?: DiscoverTrack[] } | null;
  return json?.tracks ?? [];
}
