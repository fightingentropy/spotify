import { Alert, ScrollView, Text, View } from "react-native";
import { Music, Plus } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { type LibraryPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { addSongToPlaylist, createPlaylist } from "@/lib/playlist-actions";
import { promoteStagedSong } from "@/lib/discover-keep";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

// Opened from the track-actions "Add to playlist" row (ui.addToPlaylistSong).
// Lists the user's editable (D1-backed) playlists + a "New playlist" shortcut.
// Read-only mini folders are excluded — they can't take adds until converted.
export function AddToPlaylistSheet() {
  const song = useUiStore((s) => s.addToPlaylistSong);
  const close = useUiStore((s) => s.closeAddToPlaylist);
  const openNamePrompt = useUiStore((s) => s.openNamePrompt);
  const { user, status } = useAuth();

  const { data } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    { playlists: [], userId: null },
    { enabled: !!song && status !== "loading", keepPreviousData: true },
  );
  const editable = data.playlists.filter((p) => p.editable);

  // A Discover track (Top 50 / YouTube Discover Mix) isn't in the library yet — it
  // plays from the hidden .discover staging cache. Promote it FIRST (exactly like
  // the like path), so we add the real, scanned library song. A lossless chart
  // track promotes cleanly; a stream-only YouTube-mix track is rejected by the mini
  // (409 preview_not_lossless), so adding it would otherwise write a lossy /
  // soon-to-be-pruned .discover reference into the library — abort with a message
  // instead. Keeps the library FLAC-only.
  const resolveAddable = async (current: PlayerSong): Promise<PlayerSong> => {
    if (!current.discoverTrackId) return current;
    const promoted = await promoteStagedSong(current);
    if (!promoted) {
      throw new Error("This track streams from a mix and can't be saved to a playlist.");
    }
    return promoted;
  };

  const add = async (playlistId: string) => {
    const current = song;
    close();
    if (!current) return;
    try {
      await addSongToPlaylist(playlistId, await resolveAddable(current));
    } catch (error) {
      Alert.alert("Couldn't add to playlist", error instanceof Error ? error.message : "Please try again.");
    }
  };

  const createAndAdd = () => {
    const current = song;
    close();
    openNamePrompt({
      title: "New playlist",
      initialValue: "",
      confirmLabel: "Create",
      placeholder: "Playlist name",
      onSubmit: async (name) => {
        try {
          const addable = current ? await resolveAddable(current) : null;
          const created = await createPlaylist(name);
          if (addable) await addSongToPlaylist(created.id, addable);
        } catch (error) {
          Alert.alert("Couldn't create playlist", error instanceof Error ? error.message : "Please try again.");
        }
      },
    });
  };

  return (
    <Sheet visible={!!song} onClose={close} heightPct={0.7} zIndex={210}>
      <View className="border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
        <Text className="text-lg font-bold" style={{ color: colors.foreground }}>
          Add to playlist
        </Text>
        {song ? (
          <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
            {song.title} · {song.artist}
          </Text>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        <PressableScale scaleTo={1} onPress={createAndAdd} className="flex-row items-center gap-3 px-5 py-3">
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 6,
              backgroundColor: colors.card,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Plus size={22} color={colors.foreground} />
          </View>
          <Text className="text-base font-semibold" style={{ color: colors.foreground }}>
            New playlist
          </Text>
        </PressableScale>

        {editable.map((pl) => (
          <PressableScale
            key={pl.id}
            scaleTo={1}
            onPress={() => void add(pl.id)}
            className="flex-row items-center gap-3 px-5 py-2"
          >
            <View style={{ width: 48, height: 48, borderRadius: 6, overflow: "hidden", backgroundColor: colors.card }}>
              {pl.imageUrl ? (
                <CoverImage src={pl.imageUrl} style={{ width: "100%", height: "100%" }} />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <Music size={20} color={colors.muted} />
                </View>
              )}
            </View>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-base font-medium" style={{ color: colors.foreground }}>
                {pl.name}
              </Text>
              <Text className="text-xs" style={{ color: colors.muted }}>
                {pl.songsCount} {pl.songsCount === 1 ? "song" : "songs"}
              </Text>
            </View>
          </PressableScale>
        ))}

        {editable.length === 0 ? (
          <Text className="px-5 py-6 text-sm" style={{ color: colors.muted }}>
            No editable playlists yet. Tap “New playlist” to make one.
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
