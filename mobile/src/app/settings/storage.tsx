import { ScrollView, Text } from "react-native";
import { CacheSettings } from "@/components/CacheSettings";
import { OfflineSettings } from "@/components/OfflineSettings";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { colors } from "@/theme";

export default function StorageSettingsScreen() {
  return (
    <Screen topInset={false}>
      {/* Bottom inset clears the mini-player + tab bar so the last card's
          "Clear cache" button isn't hidden behind them. */}
      <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
        <Text className="mb-3 px-4 text-2xl font-bold" style={{ color: colors.foreground }}>
          Downloads
        </Text>
        <OfflineSettings />
        <CacheSettings />
      </ScrollView>
    </Screen>
  );
}
