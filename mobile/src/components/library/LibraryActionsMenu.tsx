import { Text, View } from "react-native";
import { Pin } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import { useUiStore } from "@/store/ui";
import { useLibraryPinsStore } from "@/store/library-pins";

// Long-press sheet for a Your Library row: cover + title/subtitle header, then a
// single Pin / Unpin action that toggles the persisted pin state and floats the
// item to the top of the library. Driven by ui.libraryActions, mounted globally
// in PlayerSheets so it overlays the tab bar + mini-player.
export function LibraryActionsMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const target = useUiStore((s) => s.libraryActions);
  const pinned = useLibraryPinsStore((s) => (target ? s.pinned.includes(target.key) : false));
  const togglePin = useLibraryPinsStore((s) => s.togglePin);

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.32} zIndex={200}>
      <View style={{ paddingBottom: 32 }}>
        {target ? (
          <>
            <View className="flex-row items-center gap-3 border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
              {target.cover(48)}
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
                  {target.title}
                </Text>
                <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
                  {target.subtitle}
                </Text>
              </View>
            </View>
            <PressableScale
              scaleTo={1}
              onPress={() => {
                togglePin(target.key);
                onClose();
              }}
              className="flex-row items-center gap-4 px-5 py-4"
            >
              <View style={{ width: 24 }}>
                <Pin size={22} color={colors.green} fill={colors.green} />
              </View>
              <Text className="text-base" style={{ color: colors.foreground }}>
                {pinned ? "Unpin" : "Pin to top"}
              </Text>
            </PressableScale>
          </>
        ) : null}
      </View>
    </Sheet>
  );
}
