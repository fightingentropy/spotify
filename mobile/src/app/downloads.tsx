import { useMemo } from "react";
import { View } from "react-native";
import { SongGrid } from "@/components/song/SongGrid";
import { SongSortBar } from "@/components/song/SongSortBar";
import { EmptyState } from "@/components/ui/States";
import { DownloadActivity } from "@/components/DownloadActivity";
import { useAuth } from "@/lib/auth";
import { hasUserDownloadScope, useOfflineStore } from "@/store/offline";
import { sortSongs, useSongSort } from "@/store/song-sort";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

const DOWNLOADS_CONTEXT = "downloads";

// Grid of locally-downloaded tracks (status "ready"), deduped by songId. The
// records map is populated by the download pump (task 5). Offline playback
// resolution (swapping in file:// URLs) is also wired there.
export default function DownloadsScreen() {
  const records = useOfflineStore((s) => s.records);
  const { user, status } = useAuth();
  const scope = user?.id ?? status;

  const rawSongs = useMemo(() => {
    const seen = new Set<string>();
    const list: PlayerSong[] = [];
    for (const key of Object.keys(records)) {
      const record = records[key];
      if (record.status !== "ready" || record.accountScope !== scope || !hasUserDownloadScope(record)) continue;
      if (seen.has(record.songId)) continue;
      seen.add(record.songId);
      list.push(record.audioPath ? { ...record.song, source: "offline", audioUrl: record.audioPath } : record.song);
    }
    return list;
  }, [records, scope]);

  const sort = useSongSort(DOWNLOADS_CONTEXT);
  const songs = useMemo(() => sortSongs(rawSongs, sort), [rawSongs, sort]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        header={<View><DownloadActivity scope={scope} />{songs.length > 0 ? <SongSortBar context={DOWNLOADS_CONTEXT} /> : null}</View>}
        emptyComponent={<EmptyState title="No downloads yet" subtitle="Download songs to listen offline." />}
      />
    </View>
  );
}
