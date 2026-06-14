import { useState } from "react";
import { Text, View } from "react-native";
import Slider from "@react-native-community/slider";
import { seekTo } from "@/audio/actions";
import { useAudioProgress } from "@/audio/progress";
import { formatTime } from "@/lib/format";
import { colors } from "@/theme";

// Emerald scrubber. Reads the backend-agnostic progress store (fed by the native
// dual-deck engine on iOS, RNTP elsewhere); while dragging we hold a local value
// so the thumb doesn't snap back to the reported position. For radio there is no
// scrubber — a live indicator is shown instead.
export function Scrubber({ live = false }: { live?: boolean }) {
  const { position, duration } = useAudioProgress();
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  if (live) {
    return (
      <View className="flex-row items-center gap-2 py-2">
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
        <Text style={{ color: colors.muted }} className="text-xs font-semibold uppercase tracking-wide">
          Live
        </Text>
      </View>
    );
  }

  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const value = seeking ? seekValue : position;

  return (
    <View className="w-full">
      <Slider
        style={{ width: "100%", height: 32 }}
        minimumValue={0}
        maximumValue={max || 1}
        value={Math.min(value, max || 1)}
        minimumTrackTintColor={colors.emerald}
        maximumTrackTintColor="rgba(255,255,255,0.2)"
        thumbTintColor={colors.emerald}
        onSlidingStart={() => setSeeking(true)}
        onValueChange={(v) => setSeekValue(v)}
        onSlidingComplete={(v) => {
          setSeeking(false);
          void seekTo(v);
        }}
      />
      <View className="flex-row justify-between">
        <Text style={{ color: colors.muted, fontVariant: ["tabular-nums"] }} className="text-xs">
          {formatTime(value)}
        </Text>
        <Text style={{ color: colors.muted, fontVariant: ["tabular-nums"] }} className="text-xs">
          {formatTime(max)}
        </Text>
      </View>
    </View>
  );
}
