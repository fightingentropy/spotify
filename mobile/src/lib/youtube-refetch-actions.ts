import { Alert } from "react-native";
import { apiFetch } from "@/lib/http";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Refetch the CORRECT (studio) version of a library song from YouTube as Opus and
// replace its file. The song keeps its id server-side (pinned sidecar), so the
// like + playlist memberships survive untouched; we only swap the new audio into
// the live queue. Guarded against double-taps. Owner-only (the mini enforces it).
const refetchInFlight = new Set<string>();

export async function refetchSongFromYouTube(song: PlayerSong): Promise<void> {
  if (refetchInFlight.has(song.id)) return;
  refetchInFlight.add(song.id);
  try {
    const res = await apiFetch(`/api/songs/${encodeURIComponent(song.id)}/refetch-youtube`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: song.title, artist: song.artist }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(body?.message || body?.error || `Refetch failed (${res.status})`);
    }
    const updated = (await res.json()) as PlayerSong;
    // id is unchanged (pinned); swap the corrected audioUrl/duration into the live
    // queue so a currently-playing or queued copy uses the fixed version. A no-op
    // when the song isn't in the queue.
    if (updated?.id && updated.audioUrl) {
      usePlayerStore.getState().replaceStagedSong(song.id, updated);
    }
    Alert.alert("Fixed", "Replaced with the correct version from YouTube.");
  } catch (error) {
    Alert.alert("Couldn't refetch", error instanceof Error ? error.message : "Please try again.");
  } finally {
    refetchInFlight.delete(song.id);
  }
}
