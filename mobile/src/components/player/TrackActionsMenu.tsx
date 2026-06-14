import { Text, View } from "react-native";
import { Heart, ListEnd, ListStart } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { colors } from "@/theme";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { useUiStore } from "@/store/ui";

// The third global sheet (alongside Now Playing + Queue): Play next / Add to
// queue / Save-Remove from Liked. Driven by ui.trackActions.
export function TrackActionsMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const target = useUiStore((s) => s.trackActions);
  const liked = useLikesStore((s) => (target ? !!s.likedSongIds[target.song.id] : false));

  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const song = target?.song;

  const Row = ({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) => (
    <PressableScale
      scaleTo={1}
      onPress={() => {
        onPress();
        onClose();
      }}
      className="flex-row items-center gap-4 px-5 py-4"
    >
      <View style={{ width: 24 }}>{icon}</View>
      <Text className="text-base" style={{ color: colors.foreground }}>
        {label}
      </Text>
    </PressableScale>
  );

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.5} zIndex={200}>
      <View style={{ paddingBottom: 32 }}>
        {song ? (
          <>
            <View className="border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
              <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
                {song.title}
              </Text>
              <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
                {song.artist}
              </Text>
            </View>
            <Row icon={<ListStart size={22} color={colors.foreground} />} label="Play next" onPress={() => playNext(song)} />
            <Row icon={<ListEnd size={22} color={colors.foreground} />} label="Add to queue" onPress={() => addToQueue(song)} />
            {target?.showLike && target.canLike ? (
              <Row
                icon={<Heart size={22} color={liked ? colors.emerald : colors.foreground} fill={liked ? colors.emerald : "transparent"} />}
                label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
                onPress={() => void useLikesStore.getState().toggleLike(song.id, !liked, song)}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}
