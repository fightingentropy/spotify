import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { CheckCircle2, Trash2 } from "lucide-react-native";
import { clearAppCache } from "@/lib/clear-cache";
import { colors } from "@/theme";

// "Clear cache" control. Drops the read-through API caches (in-memory + MMKV
// snapshots) and the cover-art image caches so every screen re-pulls fresh from
// the server. Non-destructive — downloads, the account session and user settings
// are kept — so it gets neutral styling, unlike the red "Clear downloads".

export function CacheSettings() {
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState(false);
  const clearedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearedTimer.current) clearTimeout(clearedTimer.current);
    };
  }, []);

  const runClear = async () => {
    setBusy(true);
    try {
      await clearAppCache();
      setCleared(true);
      if (clearedTimer.current) clearTimeout(clearedTimer.current);
      clearedTimer.current = setTimeout(() => setCleared(false), 3000);
    } catch {
      Alert.alert("Clear cache", "Could not clear the cache. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handlePress = () => {
    Alert.alert(
      "Clear cache",
      "Reloads your library, images and other data fresh from the server. Your downloads, account and settings are kept.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear cache", onPress: () => void runClear() },
      ],
      { cancelable: true },
    );
  };

  const Icon = cleared ? CheckCircle2 : Trash2;
  const tint = cleared ? colors.emerald : colors.foreground;

  return (
    <View className="mt-6 px-4">
      <View
        className="rounded-lg p-4"
        style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line }}
      >
        <Text className="text-base font-semibold" style={{ color: colors.foreground }}>
          Cache
        </Text>
        <Text className="mt-0.5 text-sm" style={{ color: colors.muted }}>
          Clears cached library, images and other data so they reload fresh from the server.
          Your downloads, account and settings are kept.
        </Text>

        <View className="mt-4 flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear cache"
            disabled={busy}
            onPress={handlePress}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              height: 40,
              paddingHorizontal: 14,
              borderRadius: 999,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.line,
              opacity: busy ? 0.5 : pressed ? 0.8 : 1,
            })}
          >
            {busy ? (
              <ActivityIndicator size="small" color={tint} />
            ) : (
              <Icon size={16} color={tint} />
            )}
            <Text className="text-sm font-medium" style={{ color: tint }}>
              {cleared ? "Cache cleared" : "Clear cache"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
