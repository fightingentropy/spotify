import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { PODCAST_SHOWS } from "@/lib/podcasts";
import { colors } from "@/theme";

export default function PodcastsScreen() {
  const router = useRouter();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
      {PODCAST_SHOWS.map((show) => (
        <PressableScale key={show.id} scaleTo={0.985} onPress={() => router.push(`/podcasts/${show.id}`)} className="flex-row items-center gap-4">
          <View className="h-16 w-16 overflow-hidden rounded-lg" style={{ backgroundColor: colors.card }}>
            <CoverImage src={show.imageUrl} style={{ width: "100%", height: "100%" }} />
          </View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
              {show.title}
            </Text>
            <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
              {show.author}
            </Text>
            <Text numberOfLines={1} className="text-xs" style={{ color: colors.dim }}>
              {show.subtitle}
            </Text>
          </View>
        </PressableScale>
      ))}
    </ScrollView>
  );
}
