import { useEffect } from "react";
import { Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ArrowDownToLine, CheckCircle2 } from "lucide-react-native";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { SongGrid } from "@/components/song/SongGrid";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { type PlaylistPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLikesStore } from "@/store/likes";
import { useBatchDownload, useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";

export default function PlaylistScreen() {
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
  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const unpinScope = useOfflineStore((s) => s.unpinScope);
  const agg = useBatchDownload(data.songs);

  const name = data.playlist?.name ?? "Playlist";

  const header = (
    <View className="px-4 pb-4 pt-2">
      <View className="flex-row items-center gap-4">
        <View className="h-24 w-24 overflow-hidden rounded" style={{ backgroundColor: colors.card }}>
          {data.playlist?.imageUrl ? (
            <CoverImage src={data.playlist.imageUrl} style={{ width: "100%", height: "100%" }} />
          ) : null}
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={2} className="text-2xl font-bold" style={{ color: colors.foreground }}>
            {name}
          </Text>
          <Text className="mt-1 text-sm" style={{ color: colors.muted }}>
            {data.songs.length} {data.songs.length === 1 ? "track" : "tracks"}
          </Text>
        </View>
      </View>
      {data.songs.length > 0 ? (
        <PressableScale
          onPress={() => {
            if (agg.status === "downloading") {
              for (const s of data.songs) void unpinScope(s.id, `playlist:${id}`);
            } else if (agg.status !== "ready") {
              void queueDownloads(data.songs, `playlist:${id}`);
            }
          }}
          className="mt-4 flex-row items-center gap-1.5 self-start rounded-full px-4 py-2"
          style={{ borderWidth: 1, borderColor: colors.line }}
        >
          {agg.status === "downloading" ? (
            <DownloadProgressRing size={16} strokeWidth={2} progress={agg.progress} />
          ) : agg.status === "ready" ? (
            <CheckCircle2 size={16} color={colors.emerald} />
          ) : (
            <ArrowDownToLine size={16} color={colors.emerald} />
          )}
          <Text className="text-sm font-medium" style={{ color: colors.emerald }}>
            {agg.status === "downloading"
              ? `Downloading ${Math.round(agg.progress * 100)}%`
              : agg.status === "ready"
                ? "Downloaded"
                : "Download playlist"}
          </Text>
        </PressableScale>
      ) : null}
      {error ? <View className="mt-2"><ErrorText>{error}</ErrorText></View> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: data.playlist?.name ?? "" }} />
      <SongGrid
        songs={data.songs}
        header={header}
        emptyComponent={loading ? null : <EmptyState title="This playlist is empty" />}
      />
    </View>
  );
}
