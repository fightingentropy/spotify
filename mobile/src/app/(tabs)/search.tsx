import { useMemo, useState } from "react";
import { FlatList, TextInput, View, Text } from "react-native";
import { Search as SearchIcon } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { SongListItem } from "@/components/song/SongListItem";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { type SearchIndexPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toggleSongInList } from "@/audio/actions";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

function score(song: PlayerSong, q: string): number {
  const title = song.title.toLowerCase();
  const artist = song.artist.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (artist.startsWith(q)) return 60;
  if (title.includes(q)) return 40;
  if (artist.includes(q)) return 20;
  return 0;
}

export default function SearchScreen() {
  const { user, status } = useAuth();
  const { data, loading } = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    { songs: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.songs
      .map((song) => ({ song, s: score(song, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 100)
      .map((entry) => entry.song);
  }, [data.songs, query]);

  return (
    <Screen>
      <View className="px-4 pb-2 pt-3">
        <View className="mb-3 flex-row items-center gap-3">
          <ProfileButton />
          <Text className="text-3xl font-bold" style={{ color: colors.foreground }}>
            Search
          </Text>
        </View>
        <View className="flex-row items-center gap-2 rounded-lg px-3" style={{ backgroundColor: "#242424" }}>
          <SearchIcon size={20} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Songs and artists"
            placeholderTextColor={colors.muted}
            style={{ flex: 1, color: colors.foreground, height: 44, fontSize: 16 }}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>

      {loading && data.songs.length === 0 ? (
        <View className="px-4 pt-2" style={{ gap: 12 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <View key={i} className="flex-row items-center gap-3">
              <Skeleton width={48} height={48} radius={6} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={"70%"} height={14} />
                <Skeleton width={"40%"} height={12} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, index) => `${item.id}:${index}`}
          renderItem={({ item, index }) => <SongListItem song={item} onPress={() => toggleSongInList(results, index)} showActions />}
          contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingTop: 4 }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            query.trim() ? <EmptyState title="No results" subtitle={`Nothing matches "${query.trim()}"`} /> : null
          }
        />
      )}
    </Screen>
  );
}
