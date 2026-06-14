import { CheckCircle2, CircleArrowDown, RefreshCw } from "lucide-react-native";
import { ActivityIndicator, type StyleProp, View, type ViewStyle } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";
import { isRadioSong } from "@/lib/player-song";
import { type DownloadScope, useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

// The download affordance is deliberately NOT lucide `Download` (that glyph is
// only the Library "Downloads" row). Idle = CircleArrowDown, in-flight =
// spinner, ready = filled emerald check, error = RefreshCw. The actual download
// pump is built in task 5; this drives the offline store's scope pin/unpin.
export function DownloadButton({
  song,
  scope,
  size = 20,
  style,
}: {
  song: PlayerSong;
  scope?: DownloadScope;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const record = useOfflineStore((s) => s.records[song.id]);
  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const unpinScope = useOfflineStore((s) => s.unpinScope);
  if (isRadioSong(song)) return null;

  const status = record?.status;
  const songScope: DownloadScope = scope ?? `song:${song.id}`;

  const onPress = () => {
    if (status === "ready") void unpinScope(song.id, songScope);
    else void queueDownloads([song], songScope);
  };

  return (
    <PressableScale accessibilityRole="button" accessibilityLabel="Download" hitSlop={8} onPress={onPress} style={style}>
      <View style={{ width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" }}>
        {status === "downloading" || status === "queued" ? (
          <ActivityIndicator size="small" color={colors.emerald} />
        ) : status === "ready" ? (
          // dark check inside the filled emerald badge (emeraldDarkCheck)
          <CheckCircle2 size={size} color={colors.emeraldDarkCheck} fill={colors.emerald} />
        ) : status === "error" ? (
          <RefreshCw size={size} color={colors.muted} />
        ) : (
          <CircleArrowDown size={size} color={colors.iconIdle} />
        )}
      </View>
    </PressableScale>
  );
}
