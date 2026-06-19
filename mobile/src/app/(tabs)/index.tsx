import { useCallback, useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { ScrollerTile } from "@/components/song/ScrollerTile";
import { ErrorText } from "@/components/ui/States";
import {
  type DiscoverPayload,
  type DiscoverTrack,
  type HomePayload,
  type StatsHomePayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playSongs } from "@/audio/actions";
import { discoverTrackToPlayerSong } from "@/lib/discover-queue";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

function SectionTitle({ children }: { children: string }) {
  return (
    <Text className="mb-4 text-2xl font-bold" style={{ color: "#fff" }}>
      {children}
    </Text>
  );
}

function HScroller({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingRight: 16 }}>
      {children}
    </ScrollView>
  );
}

export default function HomeScreen() {
  const { user, status } = useAuth();
  const scope = user?.id ?? status;

  const { data: homeData, loading, error } = useApiData<HomePayload>(
    withAccountScope("/api/home", scope),
    { likedSongIds: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    mergeInitialLikes(homeData.likedSongIds);
  }, [mergeInitialLikes, homeData.likedSongIds]);

  const { data: statsData } = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", scope),
    { recentlyPlayed: [], mostPlayed: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const { data: discoverData } = useApiData<DiscoverPayload>(
    "/api/discover/trending",
    { tracks: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );

  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const currentDiscoverTrackId = usePlayerStore((s) => s.currentSong?.discoverTrackId ?? null);
  // The active Discover track is still "loading" while it's an un-staged
  // placeholder (no real src yet) — the stager is materializing it in the background.
  const currentSongHasAudio = usePlayerStore((s) => Boolean(s.currentSong?.audioUrl));
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);

  const recentlyPlayed = statsData.recentlyPlayed as PlayerSong[];
  const mostPlayed = statsData.mostPlayed;

  const playScroller = (songs: PlayerSong[], index: number) => {
    const song = songs[index];
    if (!song) return;
    if (song.id === currentSongId) {
      toggle();
      return;
    }
    playSongs(songs, index);
  };

  const handleDiscover = useCallback(
    (track: DiscoverTrack) => {
      // Already the current Discover track → toggle play/pause.
      if (currentDiscoverTrackId && currentDiscoverTrackId === track.id) {
        toggle();
        return;
      }
      // Queue the WHOLE Discover row, starting at the tapped track, so there's a
      // real "up next". Already-staged tracks play instantly; the rest enter as
      // placeholders and the DiscoverQueueStager materializes each on demand as it
      // becomes current (and prefetches one ahead). Nothing is added to the library.
      const tracks = discoverData.tracks;
      const index = tracks.findIndex((t) => t.id === track.id);
      playSongs(tracks.map(discoverTrackToPlayerSong), index >= 0 ? index : 0);
    },
    [currentDiscoverTrackId, discoverData.tracks, toggle],
  );

  if ((loading && homeData.likedSongIds.length === 0) || status === "loading") {
    return (
      <Screen>
        <View className="px-4 pt-12">
          <Text style={{ color: colors.muted }}>Loading library…</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingHorizontal: 16, paddingTop: 12 }}>
        <View className="mb-5 flex-row items-center">
          <ProfileButton />
        </View>
        <EmailVerificationBanner />
        {error ? <View className="mb-4"><ErrorText>{error}</ErrorText></View> : null}

        {discoverData.tracks.length > 0 ? (
          <View className="mb-9">
            <SectionTitle>Discover</SectionTitle>
            <HScroller>
              {discoverData.tracks.map((track) => {
                const active = currentDiscoverTrackId === track.id;
                return (
                  <ScrollerTile
                    key={track.id}
                    title={track.title}
                    artist={track.artist}
                    imageUrl={track.imageUrl}
                    subtitle={undefined}
                    active={active}
                    isPlaying={active && isPlaying}
                    loading={active && isPlaying && !currentSongHasAudio}
                    onPress={() => handleDiscover(track)}
                  />
                );
              })}
            </HScroller>
          </View>
        ) : null}

        {recentlyPlayed.length > 0 ? (
          <View className="mb-9">
            <SectionTitle>Recently played</SectionTitle>
            <HScroller>
              {recentlyPlayed.map((song, index) => (
                <ScrollerTile
                  key={song.id}
                  title={song.title}
                  artist={song.artist}
                  imageUrl={song.imageUrl}
                  networkImageUrl={song.networkImageUrl}
                  active={currentSongId === song.id}
                  isPlaying={currentSongId === song.id && isPlaying}
                  onPress={() => playScroller(recentlyPlayed, index)}
                />
              ))}
            </HScroller>
          </View>
        ) : null}

        {mostPlayed.length > 0 ? (
          <View className="mb-9">
            <SectionTitle>Most played</SectionTitle>
            <HScroller>
              {mostPlayed.map((entry, index) => {
                const songs = mostPlayed.map((e) => e.song);
                const song = entry.song;
                return (
                  <ScrollerTile
                    key={song.id}
                    title={song.title}
                    artist={song.artist}
                    imageUrl={song.imageUrl}
                    networkImageUrl={song.networkImageUrl}
                    subtitle={entry.playCount > 0 ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}` : undefined}
                    active={currentSongId === song.id}
                    isPlaying={currentSongId === song.id && isPlaying}
                    onPress={() => playScroller(songs, index)}
                  />
                );
              })}
            </HScroller>
          </View>
        ) : null}

        {discoverData.tracks.length === 0 && recentlyPlayed.length === 0 && mostPlayed.length === 0 ? (
          <View className="pt-20">
            <Text className="text-center" style={{ color: colors.muted }}>
              Your library is empty. Start playing something to see it here.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
