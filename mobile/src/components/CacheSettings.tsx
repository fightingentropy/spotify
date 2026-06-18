import { useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { CheckCircle2, Trash2 } from "lucide-react-native";
import { FooterButton } from "@/components/SettingsControls";
import { clearAppCache } from "@/lib/clear-cache";
import { colors } from "@/theme";

// "Clear cache" control. Drops the read-through API caches (in-memory + MMKV
// snapshots) and cover-art image caches so every screen re-pulls fresh from the
// server. Non-destructive — downloads, the account session and user settings are
// kept — so the footer button is neutral, unlike the red "Clear downloads".

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

  return (
    <View style={{ marginTop: 34 }}>
      <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }}>Cache</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
          Frees up space by clearing cached library data and images — they reload from the server
          next time. Your downloads, account and settings are kept.
        </Text>
      </View>
      <FooterButton
        icon={cleared ? CheckCircle2 : Trash2}
        label={cleared ? "Cache cleared" : "Clear cache"}
        tone={cleared ? "success" : "default"}
        busy={busy}
        onPress={handlePress}
      />
    </View>
  );
}
