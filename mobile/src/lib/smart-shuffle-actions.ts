import { Alert } from "react-native";
import { promoteStagedSong } from "@/lib/discover-keep";
import { addSongToPlaylist } from "@/lib/playlist-actions";
import { addBlocked } from "@/store/smart-shuffle-blocklist";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Add / Skip for a sparkled Smart Shuffle recommendation in the queue.
//
// "Add" keeps the rec: promote it out of the Mac-mini's hidden .discover cache
// into the real library (so it scans + can be owned), then commit it to the
// queue's context — Liked Songs (like it) or an editable playlist (add it). The
// song keeps playing as a now-real library track; we drop its id from
// recommendedIds so the sparkle clears. "Skip" removes it from the queue and
// blocklists it so the recommender won't surface it again.

export async function addRecommendationToContext(song: PlayerSong, _index?: number): Promise<void> {
  const promoted = await promoteStagedSong(song);
  if (!promoted) {
    Alert.alert("Couldn't add song", "This recommendation couldn't be added. Please try again.");
    return;
  }

  const context = usePlayerStore.getState().queueContext;
  try {
    if (context?.kind === "liked") {
      await useLikesStore.getState().toggleLike(promoted.id, true, promoted);
    } else if (context?.playlistId && context.editable) {
      await addSongToPlaylist(context.playlistId, promoted);
    }
  } catch (error) {
    Alert.alert("Couldn't add song", error instanceof Error ? error.message : "Please try again.");
    return;
  }

  // Clear the sparkle: both the original (pre-staging) id and the promoted id may
  // be in recommendedIds depending on whether the swap has landed yet.
  usePlayerStore.setState((s) => {
    if (!s.recommendedIds.has(song.id) && !s.recommendedIds.has(promoted.id)) return s;
    const recommendedIds = new Set(s.recommendedIds);
    recommendedIds.delete(song.id);
    recommendedIds.delete(promoted.id);
    return { recommendedIds };
  });
}

export function skipRecommendation(song: PlayerSong, index: number): void {
  usePlayerStore.getState().removeFromQueue(index);
  addBlocked(song);
}
