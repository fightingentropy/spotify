import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { formatBytes, getDiskUsage, type DiskUsage } from "@/lib/disk-usage";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { hasUserDownloadScope, keyFor, useOfflineStore } from "@/store/offline";
import { PLAYBACK_CACHE_SCOPE } from "@/lib/offline-download-queue";
import { colors } from "@/theme";

export function DownloadActivity({ scope }: { scope: string }) {
  const router = useRouter();
  const isOnline = useOnlineStatus();
  const records = useOfflineStore((state) => state.records);
  const progress = useOfflineStore((state) => state.progress);
  const storageBytes = useOfflineStore((state) => state.storageBytes);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const retryAll = useOfflineStore((state) => state.retryFailedDownloads);
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);
  const [disk, setDisk] = useState<{ scope: string; usage: DiskUsage } | null>(null);
  const { ready, transfers, failed } = useMemo(() => {
    const own = Object.values(records).filter((record) => record.accountScope === scope && hasUserDownloadScope(record));
    const transfers = own.filter((record) => record.status !== "ready").sort((a, b) => {
      const priority = { downloading: 0, error: 1, queued: 2, ready: 3 };
      return priority[a.status] - priority[b.status] || a.updatedAt - b.updatedAt;
    });
    return { ready: own.length - transfers.length, transfers, failed: transfers.filter((record) => record.status === "error").length };
  }, [records, scope]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void getDiskUsage().then((usage) => { if (active) setDisk({ scope, usage }); }).catch(() => {});
    }, 800);
    return () => { active = false; clearTimeout(timer); };
  }, [scope, storageBytes]);
  const usage = disk?.scope === scope ? disk.usage : null;
  const activeCount = transfers.length - failed;

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }}>Ready offline</Text>
        <PressableScale onPress={() => router.push("/settings/storage")} accessibilityRole="button" accessibilityLabel="Open storage settings" style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: colors.muted, fontSize: 13 }}>Storage settings</Text>
        </PressableScale>
      </View>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
        {ready} {ready === 1 ? "song" : "songs"}{usage ? ` · ${formatBytes(usage.usedByDownloads)}` : ""}{usage?.free == null ? "" : ` · ${formatBytes(usage.free)} free`}
      </Text>
      {transfers.length > 0 ? (
        <View style={{ marginTop: 16, borderTopWidth: 0.5, borderTopColor: colors.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <PressableScale onPress={() => setExpanded((value) => !value)} accessibilityRole="button" accessibilityLabel={expanded ? "Hide download activity" : "Show download activity"} accessibilityState={{ expanded }} style={{ flex: 1, minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ flex: 1, color: colors.foreground, fontSize: 14 }}>
                {[activeCount > 0 ? `${activeCount} ${isOnline ? "in progress" : "waiting for connection"}` : "", failed > 0 ? `${failed} need attention` : ""].filter(Boolean).join(" · ")}
              </Text>
              {expanded ? <ChevronUp size={17} color={colors.muted} /> : <ChevronDown size={17} color={colors.muted} />}
            </PressableScale>
            {failed > 0 ? <PressableScale onPress={() => void retryAll()} accessibilityRole="button" accessibilityLabel="Retry failed downloads" style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Retry failed</Text></PressableScale> : null}
          </View>
          {expanded ? <>
            {transfers.slice(0, visibleCount).map((record) => {
              const fraction = Math.max(0, Math.min(1, progress[keyFor(scope, record.songId)] ?? 0));
              const downloadScope = record.scopes.find((value) => value !== PLAYBACK_CACHE_SCOPE);
              const subtitle = record.status === "error" ? "Couldn't download" : !isOnline ? "Waiting for connection" : record.status === "downloading" ? `Downloading · ${Math.round(fraction * 100)}%` : "Queued";
              return (
                <View key={record.songId} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 66 }}>
                  <CoverImage src={record.song.imageUrl} offlineSongId={record.songId} style={{ width: 42, height: 42, borderRadius: 6 }} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14 }}>{record.song.title}</Text>
                    <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 3 }}>{subtitle}</Text>
                  </View>
                  {record.status === "error" && downloadScope ? (
                    <PressableScale onPress={() => void queueDownloads([record.song], downloadScope)} accessibilityRole="button" accessibilityLabel={`Retry ${record.song.title}`} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><RefreshCw size={18} color={colors.foreground} /></PressableScale>
                  ) : record.status === "downloading" ? <DownloadProgressRing size={22} progress={fraction} /> : null}
                </View>
              );
            })}
            {transfers.length > visibleCount ? <PressableScale onPress={() => setVisibleCount((count) => count + 20)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: colors.muted, fontSize: 13 }}>Show more ({transfers.length - visibleCount})</Text></PressableScale> : null}
          </> : null}
        </View>
      ) : null}
    </View>
  );
}
