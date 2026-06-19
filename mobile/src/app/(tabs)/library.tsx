import { type ReactNode, useMemo, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowDownUp, Download, Heart, LayoutGrid, List as ListIcon, type LucideIcon, Music, Pin, Plus, Podcast, RadioTower, Search, Ticket } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { type LibraryPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PODCAST_SHOWS } from "@/lib/podcasts";
import { useLibraryPinsStore } from "@/store/library-pins";
import { useLibraryViewStore } from "@/store/library-view";
import { librarySortLabel, useLibrarySortStore } from "@/store/library-sort";
import { useUserPodcastsStore } from "@/store/user-podcasts";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

type Filter = "all" | "playlists" | "podcasts";

// `cover` is size-aware so the same item renders small (56) in the list and large
// (a grid cell) in the grid — Spotify shows both layouts.
type LibItem = {
  key: string;
  cover: (size: number) => ReactNode;
  title: string;
  subtitle: string;
  pinned?: boolean;
  // Whether long-pressing the row offers Pin/Unpin (content items, not the
  // navigation shortcuts like Radio / Upload / Live Events).
  pinnable?: boolean;
  // Epoch ms used by the "Recently added" sort. Undefined for items without a
  // creation date (the nav shortcuts) — they sort as newest and stay on top.
  addedAt?: number;
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

function ListRow({ item, onLongPress }: { item: LibItem; onLongPress?: () => void }) {
  return (
    <PressableScale
      scaleTo={1}
      onPress={item.onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      className="flex-row items-center gap-3 px-4 py-2"
    >
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

function GridCell({ item, size, onLongPress }: { item: LibItem; size: number; onLongPress?: () => void }) {
  return (
    <PressableScale scaleTo={0.97} onPress={item.onPress} onLongPress={onLongPress} delayLongPress={300} style={{ width: size }}>
      {item.cover(size)}
      <Text numberOfLines={2} className="mt-1.5 text-[13px] font-semibold leading-4" style={{ color: colors.foreground }}>
        {item.title}
      </Text>
      <SubtitleLine pinned={item.pinned} subtitle={item.subtitle} small />
    </PressableScale>
  );
}

// The "Add …" shortcuts pinned to the bottom of Your Library (Spotify parity): a
// hollow chip + label. Artists is a circle; the rest are rounded squares. In grid
// view these flow as cells in the SAME wrap as the library tiles, so they backfill
// the last row instead of leaving gaps; in list view they're rows at the bottom.
type AddAction = { key: string; label: string; shape: "circle" | "square"; Icon: LucideIcon; onPress: () => void };

function AddActionGridCell({ action, size }: { action: AddAction; size: number }) {
  return (
    <PressableScale scaleTo={0.97} onPress={action.onPress} style={{ width: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: action.shape === "circle" ? size / 2 : 6,
          backgroundColor: colors.card,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <action.Icon size={Math.round(size * 0.34)} color={colors.iconIdle} />
      </View>
      <Text numberOfLines={2} className="mt-1.5 text-[13px] font-semibold leading-4" style={{ color: colors.foreground }}>
        {action.label}
      </Text>
    </PressableScale>
  );
}

function LibraryAddActionsList({ actions }: { actions: AddAction[] }) {
  return (
    <View className="pt-1">
      {actions.map((a) => (
        <PressableScale key={a.key} scaleTo={1} onPress={a.onPress} className="flex-row items-center gap-3 px-4 py-2">
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: a.shape === "circle" ? 28 : 6,
              backgroundColor: colors.card,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <a.Icon size={24} color={colors.iconIdle} />
          </View>
          <Text className="text-base font-medium" style={{ color: colors.foreground }}>
            {a.label}
          </Text>
        </PressableScale>
      ))}
    </View>
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
  const view = useLibraryViewStore((s) => s.view);
  const toggleView = useLibraryViewStore((s) => s.toggleView);
  const sort = useLibrarySortStore((s) => s.sort);
  const userShows = useUserPodcastsStore((s) => s.shows);
  const pinnedKeys = useLibraryPinsStore((s) => s.pinned);
  const openLibraryActions = useUiStore((s) => s.openLibraryActions);
  const openLibrarySort = useUiStore((s) => s.openLibrarySort);

  const cellWidth = Math.floor((width - 32 - GRID_GAP * 2) / 3);

  const items = useMemo<LibItem[]>(() => {
    const owner = user?.name || user?.email || "You";
    const liked: LibItem = {
      key: "liked",
      cover: gradientCover(["#4c1d95", colors.emerald], (s) => <Heart size={s} color="#fff" fill="#fff" />),
      title: "Liked Songs",
      subtitle: `Playlist • ${owner}`,
      pinnable: true,
      onPress: () => router.push("/liked"),
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
    const events: LibItem = {
      key: "events",
      cover: gradientCover(["#7c3aed", "#4c1d95"], (s) => <Ticket size={s} color="#fff" />),
      title: "Live Events",
      subtitle: "Concerts & venues near you",
      onPress: () => router.push("/events"),
    };
    const playlists: LibItem[] = data.playlists.map((pl) => {
      const added = pl.createdAt ? Date.parse(pl.createdAt) : NaN;
      return {
        key: `pl-${pl.id}`,
        cover: imageCover(pl.imageUrl),
        title: pl.name,
        subtitle: `Playlist • ${owner}`,
        pinnable: true,
        addedAt: Number.isNaN(added) ? undefined : added,
        onPress: () => router.push(`/playlist/${pl.id}`),
      };
    });
    const shows: LibItem[] = [...userShows, ...PODCAST_SHOWS].map((show) => ({
      key: `pod-${show.id}`,
      cover: imageCover(show.imageUrl),
      title: show.title,
      subtitle: `Podcast • ${show.author}`,
      pinnable: true,
      onPress: () => router.push(`/podcasts/${show.id}`),
    }));

    if (filter === "playlists") return [liked, ...playlists];
    if (filter === "podcasts") return shows;
    return [liked, radio, podcastsShortcut, events, ...playlists];
  }, [filter, data.playlists, userShows, user, router]);

  // Pinned items float to the top in pin order (newest first); the rest follow the
  // chosen sort. `pinned` drives the green pin indicator on the row.
  const ordered = useMemo(() => {
    const rank = new Map(pinnedKeys.map((k, i) => [k, i] as const));
    const pinnedItems = items
      .filter((it) => rank.has(it.key))
      .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
    const rest = items.filter((it) => !rank.has(it.key));
    // "Recents" keeps the natural (API) order; the others sort the unpinned items.
    // Both sorts are stable, so ties (and dateless nav shortcuts) hold their order.
    const sortedRest =
      sort === "alphabetical"
        ? [...rest].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
        : sort === "recently-added"
          ? [...rest].sort((a, b) => (b.addedAt ?? Number.MAX_SAFE_INTEGER) - (a.addedAt ?? Number.MAX_SAFE_INTEGER))
          : rest;
    return [...pinnedItems, ...sortedRest].map((it) => ({ ...it, pinned: rank.has(it.key) }));
  }, [items, pinnedKeys, sort]);

  const handleLongPress = (item: LibItem) => {
    if (!item.pinnable) return;
    openLibraryActions({ key: item.key, title: item.title, subtitle: item.subtitle, cover: item.cover });
  };

  const showPlaylistSkeleton = loading && data.playlists.length === 0 && filter !== "podcasts";

  const addActions: AddAction[] = [
    { key: "add-artists", label: "Add artists", shape: "circle", Icon: Plus, onPress: () => router.push("/search") },
    { key: "add-podcasts", label: "Add podcasts", shape: "square", Icon: Plus, onPress: () => router.push("/podcasts/add") },
    { key: "add-events", label: "Add events & venues", shape: "square", Icon: Plus, onPress: () => router.push("/events") },
    { key: "import", label: "Import your music", shape: "square", Icon: Download, onPress: () => router.push("/upload") },
  ];

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

        {/* sort + view toggle */}
        <View className="mb-1 flex-row items-center justify-between px-4">
          <PressableScale onPress={openLibrarySort} hitSlop={8} accessibilityLabel="Change sort order">
            {/* flex-row on an inner View, not the Pressable (RN/Fabric row→column quirk) */}
            <View className="flex-row items-center gap-2">
              <ArrowDownUp size={16} color={colors.foreground} />
              <Text className="text-sm" style={{ color: colors.foreground }}>
                {librarySortLabel(sort)}
              </Text>
            </View>
          </PressableScale>
          <PressableScale onPress={toggleView} hitSlop={8} accessibilityLabel="Toggle layout">
            <View>{view === "grid" ? <ListIcon size={22} color={colors.iconIdle} /> : <LayoutGrid size={20} color={colors.iconIdle} />}</View>
          </PressableScale>
        </View>

        {view === "grid" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP, paddingHorizontal: 16, paddingTop: 10 }}>
            {ordered.map((item) => (
              <GridCell key={item.key} item={item} size={cellWidth} onLongPress={() => handleLongPress(item)} />
            ))}
            {filter === "all"
              ? addActions.map((a) => <AddActionGridCell key={a.key} action={a} size={cellWidth} />)
              : null}
          </View>
        ) : (
          ordered.map((item) => <ListRow key={item.key} item={item} onLongPress={() => handleLongPress(item)} />)
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

        {filter === "all" && view === "list" ? (
          <View className="mt-2">
            <LibraryAddActionsList actions={addActions} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
