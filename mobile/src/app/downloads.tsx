import { useMemo } from "react";
import { View } from "react-native";
import { SongGrid } from "@/components/song/SongGrid";
import { EmptyState } from "@/components/ui/States";
import { getOfflineAccountScope, useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

// Grid of locally-downloaded tracks (status "ready"), deduped by songId. The
// records map is populated by the download pump (task 5). Offline playback
// resolution (swapping in file:// URLs) is also wired there.
export default function DownloadsScreen() {
  const records = useOfflineStore((s) => s.records);
  const scope = getOfflineAccountScope();

  const songs = useMemo(() => {
    const seen = new Set<string>();
    const list: PlayerSong[] = [];
    for (const key of Object.keys(records)) {
      const record = records[key];
      if (record.status !== "ready" || record.accountScope !== scope) continue;
      if (seen.has(record.songId)) continue;
      seen.add(record.songId);
      list.push(record.audioPath ? { ...record.song, source: "offline", audioUrl: record.audioPath } : record.song);
    }
    return list;
  }, [records, scope]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        emptyComponent={<EmptyState title="No downloads yet" subtitle="Download songs to listen offline." />}
      />
    </View>
  );
}
