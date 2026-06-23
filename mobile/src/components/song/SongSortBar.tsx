import { Text, View } from "react-native";
import { ArrowDownUp } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";
import { songSortLabel, useSongSort } from "@/store/song-sort";
import { useUiStore } from "@/store/ui";

// The "Custom order ⇅" trigger shown above a song list (Liked, a playlist,
// Downloads). Tapping it opens the SongSortMenu scoped to this collection's
// `context`. Mirrors the library tab's sort row.
export function SongSortBar({ context }: { context: string }) {
  const sort = useSongSort(context);
  const openSongSort = useUiStore((s) => s.openSongSort);

  return (
    <View className="flex-row items-center px-5 pb-2 pt-1" style={{ backgroundColor: colors.background }}>
      <PressableScale onPress={() => openSongSort(context)} hitSlop={8} accessibilityLabel="Change sort order">
        {/* flex-row on an inner View, not the Pressable (RN/Fabric row→column quirk) */}
        <View className="flex-row items-center gap-2">
          <ArrowDownUp size={16} color={colors.foreground} />
          <Text className="text-sm font-medium" style={{ color: colors.foreground }}>
            {songSortLabel(sort)}
          </Text>
        </View>
      </PressableScale>
    </View>
  );
}
