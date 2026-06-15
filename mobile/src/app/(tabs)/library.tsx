import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowDownToLine, Heart, Music, Podcast, RadioTower, Settings, Upload, User } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { type LibraryPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

function IconSquare({ children, gradient }: { children: React.ReactNode; gradient: readonly [string, string] }) {
  return (
    <LinearGradient colors={gradient} style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center", borderRadius: 4 }}>
      {children}
    </LinearGradient>
  );
}

function Row({ left, title, subtitle, onPress }: { left: React.ReactNode; title: string; subtitle: string; onPress: () => void }) {
  return (
    <PressableScale scaleTo={1} onPress={onPress} className="flex-row items-center gap-3 px-4 py-2">
      {left}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-medium" style={{ color: colors.foreground }}>
          {title}
        </Text>
        <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
          {subtitle}
        </Text>
      </View>
    </PressableScale>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const { user, status } = useAuth();
  const { data, loading } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    { playlists: [], userId: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingTop: 12 }}>
        <View className="mb-2 flex-row items-center justify-between px-4">
          <Text className="text-3xl font-bold" style={{ color: colors.foreground }}>
            Your Library
          </Text>
          <View className="flex-row items-center gap-4">
            <PressableScale onPress={() => router.push("/settings")} hitSlop={8}>
              <View>
                <Settings size={24} color={colors.iconIdle} />
              </View>
            </PressableScale>
            <PressableScale onPress={() => router.push("/profile")} hitSlop={8}>
              <View className="h-8 w-8 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
                {user?.image ? (
                  <CoverImage src={user.image} style={{ width: "100%", height: "100%" }} />
                ) : (
                  <View className="h-full w-full items-center justify-center">
                    <User size={18} color={colors.iconIdle} />
                  </View>
                )}
              </View>
            </PressableScale>
          </View>
        </View>

        <Row
          left={
            <IconSquare gradient={["#4c1d95", colors.emerald]}>
              <Heart size={26} color="#fff" fill="#fff" />
            </IconSquare>
          }
          title="Liked Songs"
          subtitle="Playlist"
          onPress={() => router.push("/liked")}
        />
        <Row
          left={<IconSquare gradient={["#1e3a8a", "#3b82f6"]}><ArrowDownToLine size={24} color="#fff" /></IconSquare>}
          title="Downloads"
          subtitle="Available offline"
          onPress={() => router.push("/downloads")}
        />
        <Row
          left={<IconSquare gradient={["#0e7490", "#22d3ee"]}><RadioTower size={24} color="#fff" /></IconSquare>}
          title="Radio Stations"
          subtitle="Live streams"
          onPress={() => router.push("/radio")}
        />
        <Row
          left={<IconSquare gradient={["#86198f", "#d946ef"]}><Podcast size={24} color="#fff" /></IconSquare>}
          title="Podcasts"
          subtitle="Shows & episodes"
          onPress={() => router.push("/podcasts")}
        />
        <Row
          left={<IconSquare gradient={["#374151", "#6b7280"]}><Upload size={24} color="#fff" /></IconSquare>}
          title="Upload"
          subtitle="Add music from Spotify or a file"
          onPress={() => router.push("/upload")}
        />

        <View className="mt-4 mb-2 px-4">
          <Text className="text-xs font-semibold uppercase tracking-wide" style={{ color: colors.muted }}>
            Playlists
          </Text>
        </View>

        {loading && data.playlists.length === 0 ? (
          <View className="px-4" style={{ gap: 12 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} className="flex-row items-center gap-3">
                <Skeleton width={56} height={56} radius={4} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton width={"60%"} height={14} />
                  <Skeleton width={"30%"} height={12} />
                </View>
              </View>
            ))}
          </View>
        ) : data.playlists.length === 0 ? (
          <Text className="px-4 py-4 text-sm" style={{ color: colors.muted }}>
            No playlists yet.
          </Text>
        ) : (
          data.playlists.map((pl) => (
            <Row
              key={pl.id}
              left={
                <View className="h-14 w-14 overflow-hidden rounded" style={{ backgroundColor: colors.card }}>
                  {pl.imageUrl ? (
                    <CoverImage src={pl.imageUrl} style={{ width: "100%", height: "100%" }} />
                  ) : (
                    <View className="h-full w-full items-center justify-center">
                      <Music size={22} color={colors.muted} />
                    </View>
                  )}
                </View>
              }
              title={pl.name}
              subtitle={`${pl.songsCount} ${pl.songsCount === 1 ? "song" : "songs"}`}
              onPress={() => router.push(`/playlist/${pl.id}`)}
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
