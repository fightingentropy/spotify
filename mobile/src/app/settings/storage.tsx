import { ScrollView } from "react-native";
import { CacheSettings } from "@/components/CacheSettings";
import { OfflineSettings } from "@/components/OfflineSettings";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";

export default function StorageSettingsScreen() {
  return (
    <Screen topInset={false}>
      {/* Each section owns its own title card (the nav bar already reads
          "Data-saving and offline"), so no extra screen heading here. Bottom
          inset clears the mini-player + tab bar so "Clear cache" isn't hidden. */}
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: CONTENT_BOTTOM_INSET }}>
        <OfflineSettings />
        <CacheSettings />
      </ScrollView>
    </Screen>
  );
}
