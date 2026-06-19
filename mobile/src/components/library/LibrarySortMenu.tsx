import { Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import { LIBRARY_SORT_OPTIONS, useLibrarySortStore } from "@/store/library-sort";

// Sort picker for Your Library, opened by tapping the sort row ("Recents" etc.).
// Radio-style list — picking an option persists it and closes. Mounted globally in
// PlayerSheets so it overlays the tab bar + mini-player like the other sheets.
export function LibrarySortMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const sort = useLibrarySortStore((s) => s.sort);
  const setSort = useLibrarySortStore((s) => s.setSort);

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.4} zIndex={200}>
      <View style={{ paddingBottom: 32 }}>
        <View className="px-5 pb-2 pt-1">
          <Text className="text-lg font-bold" style={{ color: colors.foreground }}>
            Sort by
          </Text>
        </View>
        {LIBRARY_SORT_OPTIONS.map((opt) => {
          const selected = opt.key === sort;
          return (
            <PressableScale
              key={opt.key}
              scaleTo={1}
              onPress={() => {
                setSort(opt.key);
                onClose();
              }}
            >
              {/* flex-row on an inner View, not the Pressable (RN/Fabric row→column quirk) */}
              <View className="flex-row items-center justify-between px-5 py-4">
                <Text className="text-base" style={{ color: selected ? colors.emerald : colors.foreground }}>
                  {opt.label}
                </Text>
                {selected ? <Check size={20} color={colors.emerald} /> : null}
              </View>
            </PressableScale>
          );
        })}
      </View>
    </Sheet>
  );
}
