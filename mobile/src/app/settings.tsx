import { ScrollView, Switch, Text, View } from "react-native";
import Slider from "@react-native-community/slider";
import { OfflineSettings } from "@/components/OfflineSettings";
import { Screen } from "@/components/ui/Screen";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="mb-2 mt-6 px-4 text-xs font-semibold uppercase tracking-wide" style={{ color: colors.muted }}>
      {children}
    </Text>
  );
}

function RowSwitch({ title, subtitle, value, onValueChange }: { title: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void }) {
  return (
    <View className="flex-row items-center justify-between px-4 py-3">
      <View className="mr-4 flex-1">
        <Text className="text-base" style={{ color: colors.foreground }}>{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-sm" style={{ color: colors.muted }}>{subtitle}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: colors.emerald, false: "#3a3a3a" }} thumbColor="#fff" />
    </View>
  );
}

export default function SettingsScreen() {
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

  return (
    <Screen topInset={false}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }}>
        <SectionLabel>Crossfade</SectionLabel>
        <RowSwitch title="Crossfade" subtitle="Blend the end of one track into the next" value={crossfadeEnabled} onValueChange={setCrossfadeEnabled} />
        {crossfadeEnabled ? (
          <View className="px-4 py-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm" style={{ color: colors.muted }}>Duration</Text>
              <Text className="text-sm font-semibold" style={{ color: colors.emerald }}>{crossfadeSeconds}s</Text>
            </View>
            <Slider
              minimumValue={0}
              maximumValue={12}
              step={1}
              value={crossfadeSeconds}
              onValueChange={setCrossfadeSeconds}
              minimumTrackTintColor={colors.emerald}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor={colors.emerald}
            />
          </View>
        ) : null}

        <SectionLabel>Offline</SectionLabel>
        <OfflineSettings />
      </ScrollView>
    </Screen>
  );
}
