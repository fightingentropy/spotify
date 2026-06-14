import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
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
import { apiFetch } from "@/lib/http";
import { playSongs } from "@/audio/actions";
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
    { songs: [], likedSongIds: [] },
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

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleDiscover = useCallback(
    async (track: DiscoverTrack) => {
      // Already current → toggle.
      if (currentDiscoverTrackId && currentDiscoverTrackId === track.id) {
        toggle();
        return;
      }
      // Instant path: already staged in the .discover cache.
      if (track.staged && track.audioUrl && track.audioId) {
        const song: PlayerSong = {
          id: track.audioId,
          title: track.title,
          artist: track.artist,
          album: track.album || undefined,
          imageUrl: track.imageUrl,
          audioUrl: track.audioUrl,
          duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
          source: "server",
          staged: true,
          discoverTrackId: track.id,
        };
        playSongs([song], 0);
        return;
      }
      // Not staged: materialize on demand, then play.
      if (importingId) return;
      setImportingId(track.id);
      setImportError(null);
      try {
        const res = await apiFetch("/api/discover/stage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            spotifyUrl: track.spotifyUrl,
            region: "US",
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationMs: track.durationMs ?? undefined,
            imageUrl: track.imageUrl,
            qualityProfile: "max",
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Couldn't load this track (${res.status})`);
        }
        const song = (await res.json()) as PlayerSong;
        playSongs([song], 0);
      } catch (e) {
        setImportError(e instanceof Error ? e.message : "Couldn't load this track");
      } finally {
        setImportingId(null);
      }
    },
    [currentDiscoverTrackId, importingId, toggle],
  );

  if ((loading && homeData.songs.length === 0) || status === "loading") {
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
      <ScrollView contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingHorizontal: 16, paddingTop: 24 }}>
        <EmailVerificationBanner />
        {error ? <View className="mb-4"><ErrorText>{error}</ErrorText></View> : null}

        {discoverData.tracks.length > 0 ? (
          <View className="mb-9">
            <SectionTitle>Discover</SectionTitle>
            {importError ? <View className="mb-3"><ErrorText>{importError}</ErrorText></View> : null}
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
                    loading={importingId === track.id}
                    onPress={() => void handleDiscover(track)}
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
