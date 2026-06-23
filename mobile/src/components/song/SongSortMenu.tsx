import { Text, View } from "react-native";
import { ArrowDown, ArrowUp, Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import {
  DEFAULT_SONG_SORT,
  SONG_SORT_OPTIONS,
  type SongSortDir,
  defaultDirFor,
  useSongSortStore,
} from "@/store/song-sort";

// Sort picker for a song list, opened from a SongSortBar. `context` is the
// collection being sorted (null = closed). Picking a new field applies its
// natural direction; re-tapping the selected field flips asc/desc. The sheet
// stays open so the list re-sorts live behind it; dismiss via backdrop/drag.
// Mounted globally in PlayerSheets so it overlays the tab bar + mini-player.
export function SongSortMenu({ context, onClose }: { context: string | null; onClose: () => void }) {
  const byContext = useSongSortStore((s) => s.byContext);
  const setSort = useSongSortStore((s) => s.setSort);
  const current = (context ? byContext[context] : null) ?? DEFAULT_SONG_SORT;

  return (
    <Sheet visible={!!context} onClose={onClose} heightPct={0.5} zIndex={200}>
      <View style={{ paddingBottom: 32 }}>
        <View className="px-5 pb-2 pt-1">
          <Text className="text-lg font-bold" style={{ color: colors.foreground }}>
            Sort by
          </Text>
        </View>
        {SONG_SORT_OPTIONS.map((opt) => {
          const selected = opt.key === current.key;
          return (
            <PressableScale
              key={opt.key}
              scaleTo={1}
              onPress={() => {
                if (!context) return;
                const dir: SongSortDir = selected
                  ? current.dir === "asc"
                    ? "desc"
                    : "asc"
                  : defaultDirFor(opt.key);
                setSort(context, { key: opt.key, dir });
              }}
            >
              {/* flex-row on an inner View, not the Pressable (RN/Fabric row→column quirk) */}
              <View className="flex-row items-center justify-between px-5 py-4">
                <Text className="text-base" style={{ color: selected ? colors.emerald : colors.foreground }}>
                  {opt.label}
                </Text>
                {selected ? (
                  <View className="flex-row items-center" style={{ gap: 8 }}>
                    {opt.key !== "custom" ? (
                      current.dir === "asc" ? (
                        <ArrowUp size={18} color={colors.emerald} />
                      ) : (
                        <ArrowDown size={18} color={colors.emerald} />
                      )
                    ) : null}
                    <Check size={20} color={colors.emerald} />
                  </View>
                ) : null}
              </View>
            </PressableScale>
          );
        })}
      </View>
    </Sheet>
  );
}
