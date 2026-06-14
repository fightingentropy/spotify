import { Text, View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { HeartButton } from "@/components/song/HeartButton";
import { colors, layout } from "@/theme";
import { usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";

// The persistent mini-player bar above the tab bar: cover + title/artist + heart
// + play/pause; tapping it (anywhere but the controls) opens the Now Playing sheet.
export function MiniPlayer() {
  const song = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);
  const openNowPlaying = useUiStore((s) => s.openNowPlaying);

  if (!song) return null;

  return (
    <PressableScale
      scaleTo={1}
      onPress={openNowPlaying}
      accessibilityRole="button"
      accessibilityLabel={`Open now playing: ${song.title}`}
      className="flex-row items-center gap-3 px-3"
      style={{ height: layout.mobilePlayerHeight, backgroundColor: colors.surface }}
    >
      <View className="h-11 w-11 overflow-hidden rounded">
        <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={song.id} />
      </View>
      <View className="min-w-0 flex-1">
        <MarqueeText className="text-sm font-medium text-foreground">{song.title}</MarqueeText>
        <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
          {song.artist || "Unknown Artist"}
        </Text>
      </View>
      <HeartButton song={song} size={22} />
      <PressableScale
        onPress={toggle}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? "Pause" : "Play"}
        className="h-10 w-10 items-center justify-center"
      >
        <View>
          {isPlaying ? (
            <Pause size={26} color={colors.foreground} fill={colors.foreground} />
          ) : (
            <Play size={26} color={colors.foreground} fill={colors.foreground} />
          )}
        </View>
      </PressableScale>
    </PressableScale>
  );
}
