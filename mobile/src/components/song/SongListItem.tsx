import { memo, useCallback } from "react";
import { View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Text } from "react-native";
import { DownloadButton } from "@/components/song/DownloadButton";
import { TrackActionsButton } from "@/components/song/TrackActionsButton";
import { cn } from "@/lib/format";
import { colors } from "@/theme";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// List row (emerald accent). Active row gets a faint emerald wash + emerald title;
// list rows change background on press but do NOT scale (scaleTo=1) — §5.
function SongListItemComponent({
  song,
  onPress,
  showDownload = true,
  showActions = true,
}: {
  song: PlayerSong;
  onPress: () => void;
  showDownload?: boolean;
  showActions?: boolean;
}) {
  const isActive = usePlayerStore(useCallback((s) => s.currentSong?.id === song.id, [song.id]));
  const isActiveAndPlaying = usePlayerStore(useCallback((s) => s.currentSong?.id === song.id && s.isPlaying, [song.id]));

  return (
    <View
      className={cn("flex-row items-center gap-3 rounded-row px-3 py-2", isActive && "bg-emerald/10")}
      style={isActive ? { backgroundColor: "rgba(16,185,129,0.10)" } : undefined}
    >
      <PressableScale scaleTo={1} onPress={onPress} className="min-w-0 flex-1 flex-row items-center gap-3">
        <View className="h-12 w-12 overflow-hidden rounded">
          <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={song.id} />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-[15px] font-medium" style={{ color: isActive ? colors.emerald : colors.foreground }}>
            {song.title}
          </Text>
          <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
            {song.artist || "Unknown Artist"}
          </Text>
        </View>
      </PressableScale>

      {showDownload ? <DownloadButton song={song} size={20} /> : null}

      {isActive ? (
        <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: colors.emerald }}>
          {isActiveAndPlaying ? <Pause size={16} color="#fff" fill="#fff" /> : <Play size={16} color="#fff" fill="#fff" style={{ marginLeft: 1 }} />}
        </View>
      ) : null}

      {showActions ? <TrackActionsButton song={song} size={20} /> : null}
    </View>
  );
}

export const SongListItem = memo(SongListItemComponent);
