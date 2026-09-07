import { useEffect, useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Download, Heart, ListMusic } from "lucide-react-native";
import { useRouter, type Href } from "expo-router";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
import { MadeForYouCover } from "@/components/playlist/MadeForYouCover";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { PlaylistScrollerTile } from "@/components/playlist/PlaylistScrollerTile";
import { ScrollerTile } from "@/components/song/ScrollerTile";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { ErrorText } from "@/components/ui/States";
import {
  type DiscoverPlaylistsPayload,
  type HomePayload,
  type StatsHomePayload,
  type LibraryPayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MADE_FOR_YOU_DEFINITIONS } from "@/lib/made-for-you";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import { useOfflineStore, keyFor } from "@/store/offline";
import { useLibraryPinsStore } from "@/store/library-pins";
import { useCollectionHistory } from "@/store/collection-history";
import { toggleSongInList } from "@/audio/actions";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { colors } from "@/theme";

function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function SectionTitle({ title }: { title: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        style={{
          color: colors.foreground,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.35,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

function HScroller({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={176}
      contentContainerStyle={{ gap: 12, paddingRight: 20 }}
    >
      {children}
    </ScrollView>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { user, status } = useAuth();
  const scope = user?.id ?? status;
  const isOnline = useOnlineStatus();
  const offlineRecords = useOfflineStore((state) => state.records);
  const currentSongId = usePlayerStore((state) => state.currentSong?.id);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const pinned = useLibraryPinsStore((state) => state.pinned);
  const collectionHistory = useCollectionHistory(scope);
  const stats = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", scope),
    { recentlyPlayed: [], mostPlayed: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const library = useApiData<LibraryPayload>(
    withAccountScope("/api/library", scope),
    { playlists: [], userId: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const recent = useMemo(() => {
    const seen = new Set<string>();
    return stats.data.recentlyPlayed.filter((song) => {
      if (seen.has(song.id)) return false;
      seen.add(song.id);
      return isOnline || offlineRecords[keyFor(scope, song.id)]?.status === "ready";
    }).slice(0, 12).map((song) => {
      const record = offlineRecords[keyFor(scope, song.id)];
      // The audio engine resolves the local file; keep queue snapshots portable.
      if (record?.status === "ready" && record.audioPath) return record.song;
      return song.preview && song.discoverTrackId && song.audioUrl.includes("/.discover/") ? { ...song, audioUrl: "" } : song;
    });
  }, [stats.data.recentlyPlayed, isOnline, offlineRecords, scope]);
  const shortcuts = useMemo(() => {
    const history = new Map(collectionHistory.map((entry) => [entry.key, entry]));
    return [...library.data.playlists].sort((a, b) => {
      const pinA = pinned.includes(`pl-${a.id}`) ? 1 : 0;
      const pinB = pinned.includes(`pl-${b.id}`) ? 1 : 0;
      const playA = history.get(`playlist:${a.id}`);
      const playB = history.get(`playlist:${b.id}`);
      return pinB - pinA || (playB?.count ?? 0) - (playA?.count ?? 0) ||
        (playB?.lastPlayed ?? 0) - (playA?.lastPlayed ?? 0);
    }).slice(0, 4);
  }, [library.data.playlists, pinned, collectionHistory]);

  const { data: homeData, loading, error } = useApiData<HomePayload>(
    withAccountScope("/api/home", scope),
    { likedSongIds: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    if (Array.isArray(homeData.likedSongIds)) mergeInitialLikes(homeData.likedSongIds);
  }, [mergeInitialLikes, homeData.likedSongIds]);

  // The Discover first row is now auto-updating PLAYLISTS (Top 50 + the YouTube
  // Music Discover Mix), not individual tracks. Each card opens its detail screen.
  const { data: discoverData } = useApiData<DiscoverPlaylistsPayload>(
    withAccountScope("/api/discover/playlists", scope),
    { playlists: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const discoverPlaylists = discoverData.playlists;

  if (status === "loading") {
    return (
      <Screen ambience="none">
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <ActivityIndicator color={colors.foreground} />
          <Text style={{ color: colors.muted, fontSize: 14 }}>Loading your library…</Text>
        </View>
      </Screen>
    );
  }

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `${greetingForNow()}, ${firstName}` : greetingForNow();

  return (
    <Screen ambience="none">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: CONTENT_BOTTOM_INSET,
          paddingHorizontal: 16,
          paddingTop: 14,
        }}
      >
        <View style={{ marginBottom: 28 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View style={{ minWidth: 0, flex: 1 }}>
              <Text
                style={{
                  color: colors.muted,
                  fontSize: 13,
                  lineHeight: 18,
                  fontWeight: "600",
                }}
              >
                {greeting}
              </Text>
              <Text
                style={{
                  marginTop: 4,
                  color: colors.foreground,
                  fontSize: 34,
                  lineHeight: 39,
                  fontWeight: "700",
                  letterSpacing: -0.9,
                }}
              >
                Listen now
              </Text>
            </View>
            <ProfileButton size={40} />
          </View>
        </View>

        <View style={{ marginHorizontal: -16, marginBottom: 10 }}>
          <EmailVerificationBanner />
        </View>
        {error ? <View className="mb-4"><ErrorText>{error}</ErrorText></View> : null}

        <View style={{ marginBottom: 30, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {[
            { key: "liked", name: "Liked Songs", imageUrl: null, href: "/liked", Icon: Heart },
            { key: "downloads", name: "Downloads", imageUrl: null, href: "/downloads", Icon: Download },
            ...shortcuts.map((playlist) => ({ key: playlist.id, name: playlist.name, imageUrl: playlist.imageUrl, href: `/playlist/${playlist.id}`, Icon: ListMusic })),
          ].map(({ key, name, imageUrl, href, Icon }) => (
            <PressableScale key={key} onPress={() => router.push(href as Href)} accessibilityRole="button" accessibilityLabel={`Open ${name}`} style={{ flexBasis: "45%", flexGrow: 1, minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 9, overflow: "hidden", backgroundColor: colors.surface }}>
              <View style={{ width: 54, height: 58, alignItems: "center", justifyContent: "center", backgroundColor: colors.card }}>
                {imageUrl ? <CoverImage src={imageUrl} style={{ width: 54, height: 58 }} /> : <Icon size={21} color={colors.foreground} />}
              </View>
              <Text numberOfLines={2} style={{ flex: 1, paddingRight: 8, color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{name}</Text>
            </PressableScale>
          ))}
        </View>

        {recent.length > 0 ? (
          <View style={{ marginBottom: 34 }}>
            <SectionTitle title="Continue listening" />
            <HScroller>
              {recent.map((song, index) => (
                <ScrollerTile key={song.id} songId={song.id} title={song.title} artist={song.artist} imageUrl={song.imageUrl} networkImageUrl={song.networkImageUrl} active={currentSongId === song.id} isPlaying={isPlaying} onPress={() => toggleSongInList(recent, index)} />
              ))}
            </HScroller>
          </View>
        ) : loading && stats.loading ? <ActivityIndicator color={colors.muted} style={{ marginBottom: 24 }} /> : null}

        <View style={{ marginBottom: 34 }}>
          <SectionTitle title="Made for you" />
          <HScroller>
            {MADE_FOR_YOU_DEFINITIONS.map((definition) => (
              <PlaylistScrollerTile
                key={definition.kind}
                name={definition.name}
                subtitle={definition.subtitle}
                cover={<MadeForYouCover kind={definition.kind} />}
                onPress={() =>
                  router.push({
                    pathname: "/made-for-you/[kind]",
                    params: { kind: definition.kind },
                  } as unknown as Href)
                }
              />
            ))}
          </HScroller>
        </View>

        {discoverPlaylists.length > 0 ? (
          <View style={{ marginBottom: 34 }}>
            <SectionTitle title="Discover" />
            <HScroller>
              {discoverPlaylists.map((pl) => (
                <PlaylistScrollerTile
                  key={pl.id}
                  name={pl.name}
                  subtitle={pl.songsCount > 0 ? `Playlist • ${pl.songsCount} songs` : "Playlist"}
                  imageUrl={pl.imageUrl}
                  onPress={() => router.push(`/playlist/${pl.id}`)}
                />
              ))}
            </HScroller>
          </View>
        ) : null}

      </ScrollView>
    </Screen>
  );
}
