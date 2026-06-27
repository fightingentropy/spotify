import { MoreHorizontal } from "lucide-react-native";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";
import { isRadioSong } from "@/lib/player-song";
import { useUiStore } from "@/store/ui";
import { useSongLike } from "@/components/song/useSongLike";
import type { PlayerSong } from "@/types/player";

// The ••• trigger present on every SongCard / SongListItem; opens the global
// TrackActionsMenu sheet (Play next / Add to queue / Save-Remove from Liked).
export function TrackActionsButton({
  song,
  size = 20,
  showLike = true,
  style,
  playlist,
}: {
  song: PlayerSong;
  size?: number;
  showLike?: boolean;
  style?: StyleProp<ViewStyle>;
  // When set (an editable playlist this row belongs to), the menu offers
  // "Remove from this playlist".
  playlist?: { id: string; name: string };
}) {
  const openTrackActions = useUiStore((s) => s.openTrackActions);
  const { canLike } = useSongLike(song);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`More options for ${song.title}`}
      hitSlop={8}
      onPress={() => openTrackActions({ song, canLike, showLike: showLike && !isRadioSong(song), playlist })}
      style={style}
    >
      <View>
        <MoreHorizontal size={size} color={colors.iconIdle} />
      </View>
    </PressableScale>
  );
}
