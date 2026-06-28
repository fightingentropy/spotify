import { Text, View } from "react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

// Home horizontal-scroller card for an auto-updating playlist (the Discover first
// row). Tapping opens the playlist detail (it navigates, never toggles audio), so —
// unlike ScrollerTile — there's no play overlay or active/playing state. Matches
// ScrollerTile's 152px footprint + cover styling so the rows line up.
export function PlaylistScrollerTile({
  name,
  subtitle,
  imageUrl,
  onPress,
}: {
  name: string;
  subtitle?: string;
  imageUrl?: string | null;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      className="rounded-md p-3"
      style={{ width: 152 }}
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
        <CoverImage src={imageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={imageUrl ?? name} />
      </View>
      <View className="mt-3">
        <Text numberOfLines={1} className="text-[16px] font-medium leading-6" style={{ color: "#fff" }}>
          {name}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} className="text-[14px] leading-5" style={{ color: "rgba(255,255,255,0.62)" }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}
