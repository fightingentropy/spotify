import { Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import { sleepTimerRemainingMinutes, usePlayerStore } from "@/store/player";

const OPTIONS = [5, 15, 30, 45, 60];

export function SleepTimerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtEndOfTrack = usePlayerStore((s) => s.sleepAtEndOfTrack);
  const startSleepTimer = usePlayerStore((s) => s.startSleepTimer);
  const setSleepAtEndOfTrack = usePlayerStore((s) => s.setSleepAtEndOfTrack);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const active = sleepTimerEndsAt != null || sleepAtEndOfTrack;

  const Row = ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) => (
    <PressableScale
      scaleTo={1}
      onPress={() => {
        onPress();
        onClose();
      }}
      className="flex-row items-center justify-between px-5 py-4"
    >
      <Text className="text-base" style={{ color: colors.foreground }}>
        {label}
      </Text>
      {selected ? <Check size={20} color={colors.emerald} /> : null}
    </PressableScale>
  );

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.5}>
      <View style={{ paddingBottom: 32 }}>
        <View className="px-5 pb-2 pt-1">
          <Text className="text-lg font-bold" style={{ color: colors.foreground }}>
            Sleep timer
          </Text>
          {sleepTimerEndsAt != null ? (
            <Text className="mt-1 text-sm" style={{ color: colors.emerald }}>
              {sleepTimerRemainingMinutes(sleepTimerEndsAt)} min left
            </Text>
          ) : null}
        </View>
        {OPTIONS.map((m) => (
          <Row key={m} label={`${m} minutes`} selected={false} onPress={() => startSleepTimer(m)} />
        ))}
        <Row label="End of track" selected={sleepAtEndOfTrack} onPress={setSleepAtEndOfTrack} />
        {active ? <Row label="Turn off" selected={false} onPress={cancelSleepTimer} /> : null}
      </View>
    </Sheet>
  );
}
