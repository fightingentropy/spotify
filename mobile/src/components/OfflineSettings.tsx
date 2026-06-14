import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, View } from "react-native";
import {
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react-native";
import { formatBytes, getDiskUsage, type DiskUsage } from "@/lib/disk-usage";
import { useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";

// Offline downloads management, ported from src/components/OfflineSettings.tsx
// (web) to RN. Storage stats + verification card + Verify / Retry failed / Sync
// now / Clear downloads, plus the auto-download-liked toggle. The web app's
// diagnostics block and playback-cache controls are dropped — RN has no Cache
// API / service worker, and the playback cache is the same on-disk files the
// downloads total already accounts for.

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View className="flex-1 rounded-md p-3" style={{ backgroundColor: "rgba(0,0,0,0.2)", minWidth: 140 }}>
      <Text className="text-xs" style={{ color: colors.muted }}>
        {label}
      </Text>
      <Text className="mt-1 text-base font-semibold" style={{ color: colors.foreground }}>
        {value}
      </Text>
      {sub ? (
        <Text className="mt-0.5 text-xs" style={{ color: colors.dim }}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  Icon,
  onPress,
  disabled,
  busy,
  danger,
}: {
  label: string;
  Icon: typeof RefreshCw;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}) {
  const bg = danger ? "rgba(239,68,68,0.15)" : colors.card;
  const fg = danger ? "#fca5a5" : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 40,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: bg,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon size={16} color={fg} />}
      <Text className="text-sm font-medium" style={{ color: fg }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function OfflineSettings() {
  const records = useOfflineStore((s) => s.records);
  const hydrate = useOfflineStore((s) => s.hydrate);
  const refreshStorage = useOfflineStore((s) => s.refreshStorage);
  const storageBytes = useOfflineStore((s) => s.storageBytes);
  const syncStatus = useOfflineStore((s) => s.syncStatus);
  const syncError = useOfflineStore((s) => s.syncError);
  const pendingMutations = useOfflineStore((s) => s.pendingMutations);
  const verificationStatus = useOfflineStore((s) => s.verificationStatus);
  const verificationCheckedAt = useOfflineStore((s) => s.verificationCheckedAt);
  const verifiedDownloads = useOfflineStore((s) => s.verifiedDownloads);
  const missingDownloads = useOfflineStore((s) => s.missingDownloads);
  const verificationError = useOfflineStore((s) => s.verificationError);
  const verifyDownloads = useOfflineStore((s) => s.verifyDownloads);
  const retryFailedDownloads = useOfflineStore((s) => s.retryFailedDownloads);
  const syncOfflineMutations = useOfflineStore((s) => s.syncOfflineMutations);
  const clearDownloads = useOfflineStore((s) => s.clearDownloads);
  const autoDownloadLiked = useOfflineStore((s) => s.autoDownloadLiked);
  const setAutoDownloadLiked = useOfflineStore((s) => s.setAutoDownloadLiked);

  const [disk, setDisk] = useState<DiskUsage | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Recompute the device free/total alongside the store's downloads total
  // whenever records change (a download finished/was removed) or storage refreshes.
  useEffect(() => {
    let cancelled = false;
    getDiskUsage()
      .then((usage) => {
        if (!cancelled) setDisk(usage);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [records, storageBytes]);

  const { downloaded, active, failed } = useMemo(() => {
    const list = Object.values(records);
    return {
      downloaded: list.filter((r) => r.status === "ready").length,
      active: list.filter((r) => r.status === "queued" || r.status === "downloading").length,
      failed: list.filter((r) => r.status === "error").length,
    };
  }, [records]);

  const freeBytes = disk?.free;
  const usedByDownloads = disk?.usedByDownloads ?? storageBytes;

  const verificationLabel =
    verificationStatus === "checking"
      ? "Checking downloads"
      : verificationStatus === "ok"
        ? "Downloads verified"
        : verificationStatus === "repair-needed"
          ? "Repair queued"
          : verificationStatus === "failed"
            ? "Verification failed"
            : "Not checked yet";
  const VerificationIcon =
    verificationStatus === "ok"
      ? CheckCircle2
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? TriangleAlert
        : ShieldCheck;
  const verificationTint =
    verificationStatus === "ok"
      ? colors.emerald
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? "#fbbf24"
        : colors.muted;

  const syncSummary =
    pendingMutations === 0
      ? "Up to date"
      : `${pendingMutations} pending${syncStatus === "auth-required" ? " · sign in required" : ""}`;

  const handleClearDownloads = () => {
    Alert.alert(
      "Clear downloads",
      "Remove all offline downloads from this device?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => void clearDownloads() },
      ],
      { cancelable: true },
    );
  };

  return (
    <View className="px-4">
      <View
        className="rounded-lg p-4"
        style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line }}
      >
        <Text className="text-base font-semibold" style={{ color: colors.foreground }}>
          Downloads
        </Text>
        <Text className="mt-0.5 text-sm" style={{ color: colors.muted }}>
          {downloaded} downloaded · {active} active · {failed} failed
        </Text>

        {/* Storage stats */}
        <View className="mt-4 flex-row flex-wrap gap-3">
          <StatCard label="Downloaded media" value={formatBytes(usedByDownloads)} />
          <StatCard
            label="Available"
            value={freeBytes == null ? "Unknown" : `${formatBytes(freeBytes)} free`}
          />
          <StatCard label="Sync" value={syncSummary} />
        </View>

        {/* Verification card */}
        <View
          className="mt-3 rounded-md p-3"
          style={{ backgroundColor: "rgba(0,0,0,0.2)" }}
        >
          <Text className="text-xs" style={{ color: colors.muted }}>
            Download verification
          </Text>
          <View className="mt-1 flex-row items-center gap-2">
            {verificationStatus === "checking" ? (
              <ActivityIndicator size="small" color={verificationTint} />
            ) : (
              <VerificationIcon size={16} color={verificationTint} />
            )}
            <Text className="text-base font-semibold" style={{ color: colors.foreground }}>
              {verificationLabel}
            </Text>
          </View>
          {verificationCheckedAt ? (
            <Text className="mt-1 text-xs" style={{ color: colors.dim }}>
              {verifiedDownloads} ok · {missingDownloads} repaired/missing
            </Text>
          ) : null}
        </View>

        {syncError ? (
          <Text className="mt-3 text-sm" style={{ color: "#fbbf24" }}>
            {syncError}
          </Text>
        ) : null}
        {verificationError ? (
          <Text className="mt-3 text-sm" style={{ color: "#fbbf24" }}>
            {verificationError}
          </Text>
        ) : null}

        {/* Actions */}
        <View className="mt-4 flex-row flex-wrap gap-2">
          <ActionButton label="Verify downloads" Icon={ShieldCheck} busy={verificationStatus === "checking"} disabled={verificationStatus === "checking"} onPress={() => void verifyDownloads()} />
          <ActionButton label="Retry failed" Icon={RefreshCw} onPress={() => void retryFailedDownloads()} />
          <ActionButton label="Sync now" Icon={RefreshCw} busy={syncStatus === "syncing"} onPress={() => void syncOfflineMutations()} />
          <ActionButton
            label="Refresh"
            Icon={RefreshCw}
            onPress={() => {
              void refreshStorage();
              getDiskUsage().then(setDisk).catch(() => undefined);
            }}
          />
          <ActionButton label="Clear downloads" Icon={Trash2} danger onPress={handleClearDownloads} />
        </View>

        {/* Auto-download toggle */}
        <View
          className="mt-4 flex-row items-center justify-between rounded-md p-3"
          style={{ backgroundColor: "rgba(0,0,0,0.2)" }}
        >
          <Text className="mr-4 flex-1 text-sm font-medium" style={{ color: colors.foreground }}>
            Automatically download liked songs
          </Text>
          <Switch
            value={autoDownloadLiked}
            onValueChange={setAutoDownloadLiked}
            trackColor={{ true: colors.emerald, false: "#3a3a3a" }}
            thumbColor="#fff"
          />
        </View>
      </View>
    </View>
  );
}
