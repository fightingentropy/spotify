import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Music, Pause, Play, Shuffle } from "lucide-react-native";
import { BatchDownloadButton } from "@/components/song/BatchDownloadButton";
import { SongGrid } from "@/components/song/SongGrid";
import { SongSortBar } from "@/components/song/SongSortBar";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { type PlaylistPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useArtworkColor } from "@/lib/useArtworkColor";
import { playSongs } from "@/audio/actions";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import { sortSongs, useSongSort } from "@/store/song-sort";
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
    mergeInitialLikes(data.likedSongIds);
  }, [mergeInitialLikes, data.likedSongIds]);

  // Tag the queue with this playlist so the big Play button mirrors the player
  // (Pause/resume vs. starting over), exactly like the Liked Songs screen.
  const contextKey = `playlist:${id}` as const;
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
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
          <PressableScale onPress={toggleShuffle} hitSlop={8} accessibilityLabel="Toggle shuffle">
            <View>
              <Shuffle size={26} color={shuffle ? colors.emerald : colors.iconIdle} />
            </View>
          </PressableScale>
        </View>
        {count > 0 ? (
          <PressableScale
            onPress={() =>
              isThisContext
                ? togglePlay()
                : playSongs(songs, 0, { respectShuffle: true, contextKey })
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
        emptyComponent={loading ? null : <EmptyState title="This playlist is empty" />}
      />
    </View>
  );
}
