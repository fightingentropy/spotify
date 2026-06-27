import { Alert } from "react-native";
import { promoteStagedSong } from "@/lib/discover-keep";
import { isUnstagedDiscoverSong, stageDiscoverSong } from "@/lib/discover-queue";
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

// Promotion needs a .discover copy on the mini, which only exists once a rec has
// been staged — true for the playing/near-top recs the stager has reached, but
// NOT for one several slots down (still an empty-audioUrl placeholder). Guard
// concurrent Adds for the same track (keyed on the stable discoverTrackId, which
// survives the placeholder→staged id swap) so a double-tap during the staging
// wait can't double-add (e.g. a duplicate playlist row).
const addInFlight = new Set<string>();

export async function addRecommendationToContext(song: PlayerSong, _index?: number): Promise<void> {
  const guardKey = song.discoverTrackId ?? song.id;
  if (addInFlight.has(guardKey)) return;
  addInFlight.add(guardKey);
  try {
    // Stage-on-demand: an unplayed rec is a placeholder, so materialize it first
    // (same endpoint the stager / a tile tap uses), swap the real source into the
    // queue, then promote — so Add works ahead of playback, like Spotify.
    let target = song;
    if (isUnstagedDiscoverSong(song)) {
      target = await stageDiscoverSong(song);
      usePlayerStore.getState().replaceStagedSong(song.id, target);
    }

    const promoted = await promoteStagedSong(target);
    if (!promoted) {
      Alert.alert("Couldn't add song", "This recommendation couldn't be added. Please try again.");
      return;
    }

    const context = usePlayerStore.getState().queueContext;
    if (context?.kind === "liked") {
      await useLikesStore.getState().toggleLike(promoted.id, true, promoted);
    } else if (context?.playlistId && context.editable) {
      await addSongToPlaylist(context.playlistId, promoted);
    }

    // Clear the sparkle for every id this rec may have worn: the original
    // placeholder, the staged copy, and the promoted library song (which of them
    // is in recommendedIds depends on how far the swaps have landed).
    usePlayerStore.setState((s) => {
      const ids = [song.id, target.id, promoted.id];
      if (!ids.some((id) => s.recommendedIds.has(id))) return s;
      const recommendedIds = new Set(s.recommendedIds);
      for (const id of ids) recommendedIds.delete(id);
      return { recommendedIds };
    });
  } catch (error) {
    Alert.alert("Couldn't add song", error instanceof Error ? error.message : "Please try again.");
  } finally {
    addInFlight.delete(guardKey);
  }
}

export function skipRecommendation(song: PlayerSong, index: number): void {
  usePlayerStore.getState().removeFromQueue(index);
  addBlocked(song);
}
