import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, TextInput, View, Text } from "react-native";
import { Search as SearchIcon } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { SongListItem } from "@/components/song/SongListItem";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import {
  type SearchCatalogPayload,
  type SearchIndexPayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
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

// Collapse case/punctuation so a library hit and its Spotify-catalog twin
// ("Revelries; Victoria Voss" vs "Revelries, Victoria Voss") dedupe to one row.
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function SearchingSpotify() {
  return (
    <View className="flex-row items-center justify-center gap-2 px-4 py-5">
      <ActivityIndicator size="small" color={colors.muted} />
      <Text className="text-sm" style={{ color: colors.muted }}>
        Searching Spotify…
      </Text>
    </View>
  );
}

type SearchRow =
  | { kind: "header"; key: string; title: string }
  | { kind: "song"; key: string; song: PlayerSong; list: PlayerSong[]; index: number };

export default function SearchScreen() {
  const { user, status } = useAuth();
  const { data, loading } = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    { songs: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const [query, setQuery] = useState("");

  // Library results: filtered on-device from the prefetched index (instant, works
  // offline). This is everything you already own.
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

  // Catalog results: songs you DON'T own, from Spotify. Debounced + only once the
  // query is meaningful, so we don't hit the search surface on every keystroke.
  const debouncedQuery = useDebouncedValue(query.trim(), 350);
  const catalogEnabled = debouncedQuery.length >= 2;
  const catalog = useApiData<SearchCatalogPayload>(
    `/api/search/catalog?q=${encodeURIComponent(debouncedQuery)}`,
    { results: [] },
    { enabled: catalogEnabled, keepPreviousData: true },
  );

  const libraryKeys = useMemo(
    () => new Set(results.map((song) => `${normalizeKey(song.title)}|${normalizeKey(song.artist)}`)),
    [results],
  );
  const catalogResults = useMemo(() => {
    if (!catalogEnabled) return [];
    return catalog.data.results.filter(
      (song) => !libraryKeys.has(`${normalizeKey(song.title)}|${normalizeKey(song.artist)}`),
    );
  }, [catalog.data.results, catalogEnabled, libraryKeys]);

  // One flat list: your library matches first (no header — same instant feel as
  // before), then a "More on Spotify" section for catalog hits you can preview +
  // save. Tapping plays within its own section so "up next" stays coherent.
  const rows = useMemo<SearchRow[]>(() => {
    const out: SearchRow[] = [];
    results.forEach((song, index) => out.push({ kind: "song", key: `lib:${song.id}:${index}`, song, list: results, index }));
    if (catalogResults.length > 0) {
      out.push({ kind: "header", key: "hdr:spotify", title: "More on Spotify" });
      catalogResults.forEach((song, index) =>
        out.push({ kind: "song", key: `cat:${song.id}:${index}`, song, list: catalogResults, index }),
      );
    }
    return out;
  }, [results, catalogResults]);

  const catalogLoading = catalogEnabled && catalog.loading && catalogResults.length === 0;

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
          data={rows}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <Text className="px-4 pb-1 pt-5 text-sm font-semibold" style={{ color: colors.muted }}>
                {item.title}
              </Text>
            ) : (
              <SongListItem song={item.song} onPress={() => toggleSongInList(item.list, item.index)} showActions />
            )
          }
          contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingTop: 4 }}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={rows.length > 0 && catalogLoading ? <SearchingSpotify /> : null}
          ListEmptyComponent={
            query.trim()
              ? catalogLoading
                ? <SearchingSpotify />
                : <EmptyState title="No results" subtitle={`Nothing matches "${query.trim()}"`} />
              : null
          }
        />
      )}
    </Screen>
  );
}
