import { useEffect } from "react";
import { Text, View } from "react-native";
import { ArrowDownToLine } from "lucide-react-native";
import { SongGrid } from "@/components/song/SongGrid";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { type LikedPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLikesStore } from "@/store/likes";
import { useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";

export default function LikedScreen() {
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

  if (status === "unauthenticated") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <SignedOutPrompt message="Sign in to see your Liked Songs." />
      </View>
    );
  }

  const header = (
    <View className="px-4 pb-3 pt-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm" style={{ color: colors.muted }}>
          {data.songs.length} {data.songs.length === 1 ? "song" : "songs"}
        </Text>
        {data.songs.length > 0 ? (
          <PressableScale onPress={() => void queueDownloads(data.songs, "liked")} className="flex-row items-center gap-1.5 rounded-full px-3 py-1.5" style={{ borderWidth: 1, borderColor: colors.line }}>
            <ArrowDownToLine size={16} color={colors.emerald} />
            <Text className="text-sm font-medium" style={{ color: colors.emerald }}>Download all</Text>
          </PressableScale>
        ) : null}
      </View>
      {error ? <View className="mt-2"><ErrorText>{error}</ErrorText></View> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={data.songs}
        header={header}
        emptyComponent={loading ? null : <EmptyState title="No liked songs yet" subtitle="Tap the heart on any track to save it here." />}
      />
    </View>
  );
}
