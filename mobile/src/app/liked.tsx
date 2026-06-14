import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowDownCircle, Heart, Play, Shuffle } from "lucide-react-native";
import { SongGrid } from "@/components/song/SongGrid";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { type LikedPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playSongs } from "@/audio/actions";
import { useLikesStore } from "@/store/likes";
import { useOfflineStore } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

export default function LikedScreen() {
  const insets = useSafeAreaInsets();
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<LikedPayload>(
    withAccountScope("/api/liked", user?.id ?? status),
    { songs: [], likedSongIds: [] },
    { enabled: status === "authenticated", keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    mergeInitialLikes(data.likedSongIds);
  }, [mergeInitialLikes, data.likedSongIds]);

  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const isDownloaded = useOfflineStore((s) => s.isDownloaded);
  const records = useOfflineStore((s) => s.records); // subscribe so the download icon re-renders as files land
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const songs = data.songs;
  const count = songs.length;
  const allDownloaded = useMemo(
    () => count > 0 && songs.every((s) => isDownloaded(s.id)),
    [songs, count, isDownloaded, records],
  );

  if (status === "unauthenticated") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <SignedOutPrompt message="Sign in to see your Liked Songs." />
      </View>
    );
  }

  // Spotify-style hero: purple gradient, gradient heart "cover", big title, play +
  // download. Rendered as the list header so it scrolls with the songs.
  const header = (
    <View>
      <LinearGradient
        colors={["#5b3aa6", "#2a1c4d", colors.background]}
        style={{ paddingTop: insets.top + 52, paddingBottom: 18, paddingHorizontal: 20, alignItems: "center" }}
      >
        <LinearGradient
          colors={["#c4b5fd", "#6d28d9"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            width: 132,
            height: 132,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            shadowColor: "#000",
            shadowOpacity: 0.45,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 8 },
          }}
        >
          <Heart size={58} color="#fff" fill="#fff" />
        </LinearGradient>
        <Text className="mt-5 text-3xl font-extrabold" style={{ color: "#fff" }}>
          Liked Songs
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
          {count > 0 ? (
            <PressableScale
              onPress={() => void queueDownloads(songs, "liked")}
              hitSlop={8}
              accessibilityLabel={allDownloaded ? "Downloaded" : "Download all"}
            >
              <View>
                <ArrowDownCircle
                  size={30}
                  color={allDownloaded ? "#000" : colors.iconIdle}
                  fill={allDownloaded ? colors.emerald : "transparent"}
                />
              </View>
            </PressableScale>
          ) : null}
          <PressableScale onPress={toggleShuffle} hitSlop={8} accessibilityLabel="Toggle shuffle">
            <View>
              <Shuffle size={26} color={shuffle ? colors.emerald : colors.iconIdle} />
            </View>
          </PressableScale>
        </View>
        {count > 0 ? (
          <PressableScale
            onPress={() => playSongs(songs, 0, { respectShuffle: true })}
            accessibilityLabel="Play"
            className="h-14 w-14 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.emerald }}
          >
            <View>
              <Play size={28} color="#000" fill="#000" style={{ marginLeft: 3 }} />
            </View>
          </PressableScale>
        ) : null}
      </View>
      {error ? (
        <View className="px-5 pb-2">
          <ErrorText>{error}</ErrorText>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        header={header}
        initialMode="list"
        showToggle={false}
        emptyComponent={
          loading ? null : (
            <EmptyState title="No liked songs yet" subtitle="Tap the heart on any track to save it here." />
          )
        }
      />
    </View>
  );
}
