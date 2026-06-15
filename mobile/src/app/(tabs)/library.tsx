import { type ReactNode, useMemo, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowDownToLine, ArrowDownUp, Heart, LayoutGrid, List as ListIcon, Music, Pin, Plus, Podcast, RadioTower, Search, Ticket, Upload } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { type LibraryPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PODCAST_SHOWS } from "@/lib/podcasts";
import { colors } from "@/theme";

type Filter = "all" | "playlists" | "podcasts";
type ViewMode = "list" | "grid";

// `cover` is size-aware so the same item renders small (56) in the list and large
// (a grid cell) in the grid — Spotify shows both layouts.
type LibItem = {
  key: string;
  cover: (size: number) => ReactNode;
  title: string;
  subtitle: string;
  pinned?: boolean;
  onPress: () => void;
};

const GRID_GAP = 12;

function gradientCover(gradient: readonly [string, string], renderIcon: (size: number) => ReactNode) {
  return (size: number): ReactNode => (
    <LinearGradient
      colors={gradient}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center", borderRadius: size >= 90 ? 6 : 4 }}
    >
      {renderIcon(Math.round(size * 0.45))}
    </LinearGradient>
  );
}

function imageCover(src?: string | null) {
  return (size: number): ReactNode => (
    <View style={{ width: size, height: size, borderRadius: size >= 90 ? 6 : 4, overflow: "hidden", backgroundColor: colors.card }}>
      {src ? (
        <CoverImage src={src} style={{ width: "100%", height: "100%" }} />
      ) : (
        <View className="h-full w-full items-center justify-center">
          <Music size={Math.round(size * 0.4)} color={colors.muted} />
        </View>
      )}
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} className="rounded-full px-4 py-1.5" style={{ backgroundColor: active ? "#fff" : colors.card }}>
      <Text className="text-sm font-medium" style={{ color: active ? "#000" : colors.foreground }}>
        {label}
      </Text>
    </PressableScale>
  );
}

function SubtitleLine({ pinned, subtitle, small }: { pinned?: boolean; subtitle: string; small?: boolean }) {
  return (
    <View className="mt-0.5 flex-row items-center gap-1">
      {pinned ? <Pin size={small ? 11 : 13} color={colors.green} fill={colors.green} /> : null}
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: small ? 12 : 14, color: pinned ? colors.green : colors.muted }}
      >
        {subtitle}
      </Text>
    </View>
  );
}

function ListRow({ item }: { item: LibItem }) {
  return (
    <PressableScale scaleTo={1} onPress={item.onPress} className="flex-row items-center gap-3 px-4 py-2">
      {item.cover(56)}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-medium" style={{ color: colors.foreground }}>
          {item.title}
        </Text>
        <SubtitleLine pinned={item.pinned} subtitle={item.subtitle} />
      </View>
    </PressableScale>
  );
}

function GridCell({ item, size }: { item: LibItem; size: number }) {
  return (
    <PressableScale scaleTo={0.97} onPress={item.onPress} style={{ width: size }}>
      {item.cover(size)}
      <Text numberOfLines={2} className="mt-1.5 text-[13px] font-semibold leading-4" style={{ color: colors.foreground }}>
        {item.title}
      </Text>
      <SubtitleLine pinned={item.pinned} subtitle={item.subtitle} small />
    </PressableScale>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { user, status } = useAuth();
  const { data, loading } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    { playlists: [], userId: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<ViewMode>("list");

  const cellWidth = Math.floor((width - 32 - GRID_GAP * 2) / 3);

  const items = useMemo<LibItem[]>(() => {
    const owner = user?.name || user?.email || "You";
    const liked: LibItem = {
      key: "liked",
      cover: gradientCover(["#4c1d95", colors.emerald], (s) => <Heart size={s} color="#fff" fill="#fff" />),
      title: "Liked Songs",
      subtitle: `Playlist • ${owner}`,
      pinned: true,
      onPress: () => router.push("/liked"),
    };
    const downloads: LibItem = {
      key: "downloads",
      cover: gradientCover(["#1e3a8a", "#3b82f6"], (s) => <ArrowDownToLine size={s} color="#fff" />),
      title: "Downloads",
      subtitle: "Available offline",
      onPress: () => router.push("/downloads"),
    };
    const radio: LibItem = {
      key: "radio",
      cover: gradientCover(["#0e7490", "#22d3ee"], (s) => <RadioTower size={s} color="#fff" />),
      title: "Radio Stations",
      subtitle: "Live streams",
      onPress: () => router.push("/radio"),
    };
    const podcastsShortcut: LibItem = {
      key: "podcasts",
      cover: gradientCover(["#86198f", "#d946ef"], (s) => <Podcast size={s} color="#fff" />),
      title: "Podcasts",
      subtitle: "Shows & episodes",
      onPress: () => router.push("/podcasts"),
    };
    const upload: LibItem = {
      key: "upload",
      cover: gradientCover(["#374151", "#6b7280"], (s) => <Upload size={s} color="#fff" />),
      title: "Upload",
      subtitle: "Add music from Spotify or a file",
      onPress: () => router.push("/upload"),
    };
    const events: LibItem = {
      key: "events",
      cover: gradientCover(["#7c3aed", "#4c1d95"], (s) => <Ticket size={s} color="#fff" />),
      title: "Live Events",
      subtitle: "Concerts & venues near you",
      onPress: () => router.push("/events"),
    };
    const playlists: LibItem[] = data.playlists.map((pl) => ({
      key: `pl-${pl.id}`,
      cover: imageCover(pl.imageUrl),
      title: pl.name,
      subtitle: `Playlist • ${owner}`,
      onPress: () => router.push(`/playlist/${pl.id}`),
    }));
    const shows: LibItem[] = PODCAST_SHOWS.map((show) => ({
      key: `pod-${show.id}`,
      cover: imageCover(show.imageUrl),
      title: show.title,
      subtitle: `Podcast • ${show.author}`,
      onPress: () => router.push(`/podcasts/${show.id}`),
    }));

    if (filter === "playlists") return [liked, ...playlists];
    if (filter === "podcasts") return shows;
    return [liked, downloads, radio, podcastsShortcut, upload, events, ...playlists];
  }, [filter, data.playlists, user, router]);

  const showPlaylistSkeleton = loading && data.playlists.length === 0 && filter !== "podcasts";

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingTop: 12 }}>
        {/* header: avatar + title + search + add */}
        <View className="mb-4 flex-row items-center px-4">
          <View className="min-w-0 flex-1 flex-row items-center gap-3">
            <ProfileButton />
            <Text className="text-3xl font-bold" style={{ color: colors.foreground }}>
              Your Library
            </Text>
          </View>
          <View className="flex-row items-center gap-5">
            <PressableScale onPress={() => router.push("/search")} hitSlop={8} accessibilityLabel="Search">
              <View>
                <Search size={24} color={colors.foreground} />
              </View>
            </PressableScale>
            <PressableScale onPress={() => router.push("/upload")} hitSlop={8} accessibilityLabel="Add music">
              <View>
                <Plus size={26} color={colors.foreground} />
              </View>
            </PressableScale>
          </View>
        </View>

        {/* filter chips */}
        <View className="mb-3 flex-row gap-2 px-4">
          <FilterChip label="Playlists" active={filter === "playlists"} onPress={() => setFilter((f) => (f === "playlists" ? "all" : "playlists"))} />
          <FilterChip label="Podcasts" active={filter === "podcasts"} onPress={() => setFilter((f) => (f === "podcasts" ? "all" : "podcasts"))} />
        </View>

        {/* recents + view toggle */}
        <View className="mb-1 flex-row items-center justify-between px-4">
          <View className="flex-row items-center gap-2">
            <ArrowDownUp size={16} color={colors.foreground} />
            <Text className="text-sm" style={{ color: colors.foreground }}>
              Recents
            </Text>
          </View>
          <PressableScale onPress={() => setView((v) => (v === "grid" ? "list" : "grid"))} hitSlop={8} accessibilityLabel="Toggle layout">
            <View>{view === "grid" ? <ListIcon size={22} color={colors.iconIdle} /> : <LayoutGrid size={20} color={colors.iconIdle} />}</View>
          </PressableScale>
        </View>

        {view === "grid" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP, paddingHorizontal: 16, paddingTop: 10 }}>
            {items.map((item) => (
              <GridCell key={item.key} item={item} size={cellWidth} />
            ))}
          </View>
        ) : (
          items.map((item) => <ListRow key={item.key} item={item} />)
        )}

        {showPlaylistSkeleton && view === "list" ? (
          <View className="px-4 pt-2" style={{ gap: 12 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <View key={i} className="flex-row items-center gap-3">
                <Skeleton width={56} height={56} radius={4} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton width={"60%"} height={14} />
                  <Skeleton width={"30%"} height={12} />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {filter === "podcasts" && PODCAST_SHOWS.length === 0 ? (
          <Text className="px-4 py-4 text-sm" style={{ color: colors.muted }}>
            No podcasts yet.
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
