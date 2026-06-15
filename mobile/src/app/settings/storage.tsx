import { ScrollView, Text } from "react-native";
import { OfflineSettings } from "@/components/OfflineSettings";
import { Screen } from "@/components/ui/Screen";
import { colors } from "@/theme";

export default function StorageSettingsScreen() {
  return (
    <Screen topInset={false}>
      <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: 48 }}>
        <Text className="mb-3 px-4 text-2xl font-bold" style={{ color: colors.foreground }}>
          Downloads
        </Text>
        <OfflineSettings />
      </ScrollView>
    </Screen>
  );
}
