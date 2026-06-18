import { ArrowDownCircle } from "lucide-react-native";
import { View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { colors } from "@/theme";
import { type DownloadScope, useBatchDownload, useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

// "Download all" affordance for a playlist / Liked Songs. Outline arrow when
// nothing's downloaded, a determinate fill ring (tap to cancel) while the batch
// streams in, and a filled arrow once every track is offline.
export function BatchDownloadButton({
  songs,
  scope,
  size = 30,
}: {
  songs: PlayerSong[];
  scope: DownloadScope;
  size?: number;
}) {
  const agg = useBatchDownload(songs);
  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const unpinScope = useOfflineStore((s) => s.unpinScope);

  const onPress = () => {
    if (agg.status === "downloading") {
      for (const s of songs) void unpinScope(s.id, scope);
    } else if (agg.status !== "ready") {
      void queueDownloads(songs, scope);
    }
  };

  return (
    <PressableScale
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        agg.status === "ready" ? "Downloaded" : agg.status === "downloading" ? "Cancel download" : "Download all"
      }
    >
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        {agg.status === "downloading" ? (
          <DownloadProgressRing size={size} strokeWidth={2.5} progress={agg.progress}>
            <View
              style={{ width: size * 0.24, height: size * 0.24, borderRadius: 2, backgroundColor: colors.emerald }}
            />
          </DownloadProgressRing>
        ) : (
          <ArrowDownCircle
            size={size}
            color={agg.status === "ready" ? "#000" : colors.iconIdle}
            fill={agg.status === "ready" ? colors.emerald : "transparent"}
          />
        )}
      </View>
    </PressableScale>
  );
}
