import { Heart } from "lucide-react-native";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";
import { useSongLike } from "@/components/song/useSongLike";
import type { PlayerSong } from "@/types/player";

// Likes use the emerald accent (rgb 16,185,129), per §4.
export function HeartButton({
  song,
  size = 20,
  hitSlop = 8,
  style,
}: {
  song: PlayerSong;
  size?: number;
  hitSlop?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { liked, pending, canLike, toggle } = useSongLike(song);
  if (!canLike) return null;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={liked ? `Remove ${song.title} from Liked Songs` : `Save ${song.title} to Liked Songs`}
      hitSlop={hitSlop}
      disabled={pending}
      onPress={toggle}
      style={style}
    >
      <View style={{ opacity: pending ? 0.6 : 1 }}>
        <Heart
          size={size}
          color={liked ? colors.emerald : colors.iconIdle}
          fill={liked ? colors.emerald : "transparent"}
        />
      </View>
    </PressableScale>
  );
}
