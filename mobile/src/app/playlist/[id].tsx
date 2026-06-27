import { useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { MoreHorizontal, Music, Pause, Pencil, Play, Shuffle, Sparkles, Trash2 } from "lucide-react-native";
import { BatchDownloadButton } from "@/components/song/BatchDownloadButton";
import { SongGrid } from "@/components/song/SongGrid";
import { SongSortBar } from "@/components/song/SongSortBar";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { type PlaylistPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { deletePlaylist, renamePlaylist } from "@/lib/playlist-actions";
import { useArtworkColor } from "@/lib/useArtworkColor";
import { playSongs } from "@/audio/actions";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import { sortSongs, useSongSort } from "@/store/song-sort";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

export default function PlaylistScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<PlaylistPayload>(
    withAccountScope(`/api/playlist/${id}`, user?.id ?? status),
    { playlist: null, songs: [], likedSongIds: [] },
    { enabled: status !== "loading" && !!id, keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    // Only merge when the server actually sent a like set. A converted folder
    // returns likedSongIds=null when the mini's like set is unreachable; merging
    // (non-additive) on null/non-array would wipe every local-server heart, so
    // skip it and keep the current hearts until a successful liked/library load.
    if (Array.isArray(data.likedSongIds)) mergeInitialLikes(data.likedSongIds);
  }, [mergeInitialLikes, data.likedSongIds]);

  // Tag the queue with this playlist so the big Play button mirrors the player
  // (Pause/resume vs. starting over), exactly like the Liked Songs screen.
  const contextKey = `playlist:${id}` as const;
  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffleEnabled = usePlayerStore((s) => s.smartShuffleEnabled);
  const openListeningModes = useUiStore((s) => s.openListeningModes);
  const isThisContext = usePlayerStore((s) => s.queueContextKey === contextKey);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.toggle);

  // Apply the user's chosen sort for this playlist (Date added / Title / …); the
  // sorted list drives Play, batch download, and the rows so taps stay in sync.
  const sort = useSongSort(contextKey);
  const songs = useMemo(() => sortSongs(data.songs, sort), [data.songs, sort]);
  const count = songs.length;
  const name = data.playlist?.name ?? "Playlist";
  const cover = data.playlist?.imageUrl ?? songs[0]?.imageUrl ?? null;
  const tint = useArtworkColor(cover);
  const heroColor = tint ?? "#3f3f46";
  const showPause = isThisContext && isPlaying;

  // Editable = D1-backed (a converted folder or a native playlist). Folder-backed
  // playlists (local-folder-*) can be renamed + edited but NOT deleted in-app
  // (that would mean deleting files on the server), so the worker rejects it.
  const router = useRouter();
  const openNamePrompt = useUiStore((s) => s.openNamePrompt);
  const [menuOpen, setMenuOpen] = useState(false);
  const editable = !!data.playlist?.editable;
  const canDelete = editable && !(typeof id === "string" && id.startsWith("local-folder-"));
  // Stable so memoized song rows don't re-render every frame.
  const playlistContext = useMemo(
    () => (editable && typeof id === "string" ? { id, name } : undefined),
    [editable, id, name],
  );

  const handleRename = () => {
    if (typeof id !== "string") return;
    openNamePrompt({
      title: "Rename playlist",
      initialValue: name,
      confirmLabel: "Save",
      onSubmit: (next) =>
        void renamePlaylist(id, next).catch((err) =>
          Alert.alert("Couldn't rename", err instanceof Error ? err.message : "Please try again."),
        ),
    });
  };

  const handleDelete = () => {
    if (typeof id !== "string") return;
    Alert.alert("Delete playlist?", `“${name}” will be removed from your library.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void deletePlaylist(id)
            .then(() => router.back())
            .catch((err) => Alert.alert("Couldn't delete", err instanceof Error ? err.message : "Please try again.")),
      },
    ]);
  };

  // Spotify-style hero: a gradient tinted by the cover art, the large artwork, the
  // title + count, then the download · shuffle · play action row. Rendered as the
  // list header so it scrolls with the songs.
  const header = (
    <View>
      <LinearGradient
        colors={[heroColor, heroColor, colors.background]}
        style={{ paddingTop: insets.top + 52, paddingBottom: 18, paddingHorizontal: 20, alignItems: "center" }}
      >
        <View
          style={{
            borderRadius: 6,
            shadowColor: "#000",
            shadowOpacity: 0.45,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 8 },
          }}
        >
          <View
            style={{
              width: 132,
              height: 132,
              borderRadius: 6,
              overflow: "hidden",
              backgroundColor: colors.card,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {cover ? (
              <CoverImage src={cover} style={{ width: "100%", height: "100%" }} />
            ) : (
              <Music size={52} color={colors.muted} />
            )}
          </View>
        </View>
        <Text numberOfLines={2} className="mt-5 text-center text-3xl font-extrabold" style={{ color: "#fff" }}>
          {name}
        </Text>
        <Text className="mt-1.5 text-sm font-medium" style={{ color: colors.muted }}>
          {count} {count === 1 ? "song" : "songs"}
        </Text>
      </LinearGradient>

      {/* action row: download · shuffle · play (Spotify layout) */}
      <View
        className="flex-row items-center justify-between px-5 pb-3 pt-1"
        style={{ backgroundColor: colors.background }}
      >
        <View className="flex-row items-center" style={{ gap: 22 }}>
          {count > 0 ? <BatchDownloadButton songs={songs} scope={contextKey} size={30} /> : null}
          {editable ? (
            <PressableScale onPress={() => setMenuOpen(true)} hitSlop={8} accessibilityLabel="Playlist options">
              <View>
                <MoreHorizontal size={26} color={colors.iconIdle} />
              </View>
            </PressableScale>
          ) : null}
          {/* Listening mode: mirrors the Now Playing control — emerald Sparkles
              when Smart Shuffle is on, an emerald/idle Shuffle glyph otherwise.
              Tap opens the modes popup, scoped to this playlist. */}
          <PressableScale
            onPress={() => openListeningModes({ kind: "playlist", playlistId: id, editable })}
            hitSlop={8}
            accessibilityLabel="Listening modes"
          >
            <View>
              {smartShuffleEnabled ? (
                <Sparkles size={26} color={colors.emerald} />
              ) : (
                <Shuffle size={26} color={shuffle ? colors.emerald : colors.iconIdle} />
              )}
            </View>
          </PressableScale>
        </View>
        {count > 0 ? (
          <PressableScale
            onPress={() =>
              isThisContext
                ? togglePlay()
                : playSongs(songs, 0, {
                    respectShuffle: true,
                    contextKey,
                    contextMeta: { kind: "playlist", playlistId: id, editable },
                  })
            }
            accessibilityLabel={showPause ? "Pause" : "Play"}
            className="h-14 w-14 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.emerald }}
          >
            <View>
              {showPause ? (
                <Pause size={28} color="#000" fill="#000" />
              ) : (
                <Play size={28} color="#000" fill="#000" style={{ marginLeft: 3 }} />
              )}
            </View>
          </PressableScale>
        ) : null}
      </View>
      {error ? (
        <View className="px-5 pb-2">
          <ErrorText>{error}</ErrorText>
        </View>
      ) : null}
      {count > 0 ? <SongSortBar context={contextKey} /> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        header={header}
        initialMode="list"
        showToggle={false}
        contextKey={contextKey}
        playlistContext={playlistContext}
        emptyComponent={loading ? null : <EmptyState title="This playlist is empty" />}
      />
      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} heightPct={0.4} zIndex={200}>
        <View className="border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
          <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
            {name}
          </Text>
          <Text className="text-sm" style={{ color: colors.muted }}>
            {count} {count === 1 ? "song" : "songs"}
          </Text>
        </View>
        <PressableScale
          scaleTo={1}
          onPress={() => {
            setMenuOpen(false);
            handleRename();
          }}
          className="flex-row items-center gap-4 px-5 py-4"
        >
          <Pencil size={22} color={colors.foreground} />
          <Text className="text-base" style={{ color: colors.foreground }}>
            Rename
          </Text>
        </PressableScale>
        {canDelete ? (
          <PressableScale
            scaleTo={1}
            onPress={() => {
              setMenuOpen(false);
              handleDelete();
            }}
            className="flex-row items-center gap-4 px-5 py-4"
          >
            <Trash2 size={22} color="#ef4444" />
            <Text className="text-base" style={{ color: "#ef4444" }}>
              Delete playlist
            </Text>
          </PressableScale>
        ) : null}
      </Sheet>
    </View>
  );
}
