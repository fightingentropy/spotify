import { useMemo } from "react";
import { FlatList, Text, View } from "react-native";
import { Plus, Sparkles, X } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import { addRecommendationToContext, skipRecommendation } from "@/lib/smart-shuffle-actions";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Current song highlighted + "Up Next" (in playback order — shuffle shows the
// redo stack then the pool, via getUpcomingPlaybackIndices). Tap to jump, X to remove.
export function QueueSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const playFuture = usePlayerStore((s) => s.playFuture);
  const shuffleRemaining = usePlayerStore((s) => s.shuffleRemaining);
  const recommendedIds = usePlayerStore((s) => s.recommendedIds);
  const advanceToIndex = usePlayerStore((s) => s.advanceToIndex);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);

  const upcoming = useMemo(
    () =>
      getUpcomingPlaybackIndices(queue.length, currentIndex, queue.length, {
        shuffle,
        repeatMode,
        playFuture,
        shuffleRemaining,
      }),
    [queue.length, currentIndex, shuffle, repeatMode, playFuture, shuffleRemaining],
  );

  // A Smart Shuffle recommendation: sparkle by the title, a trailing [+] to Add
  // it to the queue's context (like / add to playlist), and the [X] becomes Skip
  // (removes + blocklists so it isn't recommended again). Membership is the
  // store's recommendedIds Set, not a flag on the song (the id changes on staging).
  const renderRow = (song: PlayerSong, index: number) => {
    const isRec = recommendedIds.has(song.id);
    return (
      <View className="flex-row items-center gap-3 px-4 py-2">
        <PressableScale scaleTo={1} onPress={() => advanceToIndex(index)} className="min-w-0 flex-1 flex-row items-center gap-3">
          <View className="h-11 w-11 overflow-hidden rounded">
            <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={song.id} />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-1.5">
              {isRec ? <Sparkles size={13} color={colors.emerald} /> : null}
              <Text numberOfLines={1} className="text-sm font-medium" style={{ color: colors.foreground, flexShrink: 1 }}>
                {song.title}
              </Text>
            </View>
            <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
              {song.artist}
            </Text>
          </View>
        </PressableScale>
        {isRec ? (
          <PressableScale onPress={() => void addRecommendationToContext(song, index)} hitSlop={8} accessibilityLabel={`Add ${song.title}`}>
            <View className="p-1">
              <Plus size={18} color={colors.emerald} />
            </View>
          </PressableScale>
        ) : null}
        <PressableScale
          onPress={() => (isRec ? skipRecommendation(song, index) : removeFromQueue(index))}
          hitSlop={8}
          accessibilityLabel={isRec ? `Skip ${song.title}` : `Remove ${song.title}`}
        >
          <View className="p-1">
            <X size={18} color={colors.muted} />
          </View>
        </PressableScale>
      </View>
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.8} zIndex={200}>
      <FlatList
        data={upcoming}
        keyExtractor={(i) => String(i)}
        extraData={recommendedIds}
        renderItem={({ item }) => renderRow(queue[item], item)}
        ListHeaderComponent={
          <View className="px-4 pb-2 pt-1">
            <Text className="mb-3 text-lg font-bold" style={{ color: colors.foreground }}>
              Queue
            </Text>
            {currentSong ? (
              <>
                <Text className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: colors.muted }}>
                  Now playing
                </Text>
                {renderRow(currentSong, currentIndex)}
                <Text className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide" style={{ color: colors.muted }}>
                  Up next
                </Text>
              </>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View className="items-center py-10">
            <Text style={{ color: colors.muted }}>Nothing up next</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </Sheet>
  );
}
