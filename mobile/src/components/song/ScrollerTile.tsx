import { ActivityIndicator, Text, View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

// Home horizontal-scroller tile. Uses Spotify-green #1ed760 (play button + active
// title) — NOT emerald — per the two-greens rule (§4). Play button is only shown
// for the active tile; tapping anywhere on the tile plays/toggles it.
export function ScrollerTile({
  title,
  artist,
  imageUrl,
  networkImageUrl,
  subtitle,
  active,
  isPlaying,
  loading,
  onPress,
}: {
  title: string;
  artist: string;
  imageUrl?: string | null;
  networkImageUrl?: string | null;
  subtitle?: string;
  active: boolean;
  isPlaying: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active && isPlaying ? `Pause ${title}` : `Play ${title}`}
      className="w-36 rounded-md p-3"
      style={{ width: 152, backgroundColor: active ? "rgba(255,255,255,0.12)" : "transparent" }}
    >
      <View
        className="relative overflow-hidden rounded-[5px]"
        style={{
          aspectRatio: 1,
          backgroundColor: colors.card,
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 10 },
        }}
      >
        <CoverImage src={imageUrl} networkSrc={networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={imageUrl ?? title} />
        {loading ? (
          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.55)" }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
        {active ? (
          <View
            className="absolute bottom-3 right-3 h-11 w-11 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.green }}
          >
            {isPlaying ? (
              <Pause size={20} color="#000" fill="#000" />
            ) : (
              <Play size={20} color="#000" fill="#000" style={{ marginLeft: 2 }} />
            )}
          </View>
        ) : null}
      </View>
      <View className="mt-3">
        <Text numberOfLines={1} className="text-[16px] font-medium leading-6" style={{ color: active ? colors.green : "#fff" }}>
          {title}
        </Text>
        <Text numberOfLines={1} className="text-[14px] leading-5" style={{ color: "rgba(255,255,255,0.62)" }}>
          {artist || "Unknown Artist"}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} className="mt-0.5 text-[13px]" style={{ color: "rgba(255,255,255,0.46)" }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}
