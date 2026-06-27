import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { Check, Shuffle, Sparkles, X } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { getIsOnline } from "@/lib/connectivity";
import { usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// The three listening modes (Off / Shuffle / Smart Shuffle), opened by
// long-pressing the shuffle control in Now Playing. Off and Shuffle just drive
// the existing `shuffle` boolean; Smart Shuffle flips `smartShuffleEnabled` and
// forces shuffle off so recs land on a clean 1-per-RECS_INTERVAL cadence. Smart
// Shuffle is disabled (dimmed, "Online only") when offline or the current queue
// has no editable/liked context to add recs to.

type Mode = "off" | "shuffle" | "smart";

function ModeRow({
  icon,
  title,
  subtitle,
  active,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={disabled ? 1 : 0.98}
      onPress={disabled ? undefined : onPress}
      className="flex-row items-center gap-4 px-5"
      style={{ paddingVertical: 14, opacity: disabled ? 0.4 : 1 }}
      accessibilityLabel={title}
    >
      <View style={{ width: 28, alignItems: "center" }}>{icon}</View>
      <View className="min-w-0 flex-1">
        <Text style={{ color: active ? colors.emerald : colors.foreground, fontSize: 16, fontWeight: "700" }}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {active ? <Check size={20} color={colors.emerald} /> : null}
    </PressableScale>
  );
}

export function ListeningModesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffleEnabled = usePlayerStore((s) => s.smartShuffleEnabled);
  const queueContext = usePlayerStore((s) => s.queueContext);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const setSmartShuffleEnabled = usePlayerStore((s) => s.setSmartShuffleEnabled);
  const listeningModesContext = useUiStore((s) => s.listeningModesContext);

  // Smart Shuffle only makes sense over a liked/editable collection we can add
  // recs into, and only while online (recs are fetched + streamed live). Prefer
  // the collection the sheet was opened from (a header) and fall back to the
  // currently-playing queue (opened from the Now Playing transport).
  const ctx = listeningModesContext ?? queueContext;
  const contextSupported =
    ctx != null && (ctx.kind === "liked" || (!!ctx.playlistId && !!ctx.editable));
  const smartDisabled = !getIsOnline() || !contextSupported;

  const active: Mode = smartShuffleEnabled ? "smart" : shuffle ? "shuffle" : "off";

  const selectOff = () => {
    if (smartShuffleEnabled) setSmartShuffleEnabled(false);
    if (shuffle) toggleShuffle();
    onClose();
  };

  const selectShuffle = () => {
    if (smartShuffleEnabled) setSmartShuffleEnabled(false);
    if (!shuffle) toggleShuffle();
    onClose();
  };

  const selectSmart = () => {
    if (shuffle) toggleShuffle();
    if (!smartShuffleEnabled) setSmartShuffleEnabled(true);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.46} zIndex={250}>
      <View className="px-5 pb-2 pt-1">
        <Text className="text-lg font-bold" style={{ color: colors.foreground }}>
          Listening modes
        </Text>
      </View>
      <ModeRow
        icon={<X size={22} color={active === "off" ? colors.emerald : colors.iconIdle} />}
        title="Off"
        subtitle="Play in order"
        active={active === "off"}
        onPress={selectOff}
      />
      <ModeRow
        icon={<Shuffle size={22} color={active === "shuffle" ? colors.emerald : colors.iconIdle} />}
        title="Shuffle"
        subtitle="Play your songs in a random order"
        active={active === "shuffle"}
        onPress={selectShuffle}
      />
      <ModeRow
        icon={<Sparkles size={22} color={active === "smart" ? colors.emerald : colors.iconIdle} />}
        title="Smart Shuffle"
        subtitle={smartDisabled ? "Online only" : "Mix in recommendations as you listen"}
        active={active === "smart"}
        disabled={smartDisabled}
        onPress={selectSmart}
      />
    </Sheet>
  );
}
