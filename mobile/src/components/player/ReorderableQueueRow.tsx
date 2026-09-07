import type { ReactNode } from "react";
import { View } from "react-native";
import { GripVertical } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { colors } from "@/theme";
import { selectionAsync } from "@/lib/haptics";

export const QUEUE_ROW_HEIGHT = 64;

export function ReorderableQueueRow({ children, label, onMove, onDragging, dimmed }: {
  children: ReactNode;
  label: string;
  onMove: (offset: number) => void;
  onDragging: (dragging: boolean) => void;
  dimmed?: boolean;
}) {
  const translation = useSharedValue(0);
  const active = useSharedValue(false);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: translation.value }],
    zIndex: active.value ? 10 : 0,
    backgroundColor: active.value ? colors.cardActive : "transparent",
  }));
  const pan = Gesture.Pan()
    .activateAfterLongPress(180)
    .onStart(() => {
      active.value = true;
      runOnJS(onDragging)(true);
      runOnJS(selectionAsync)();
    })
    .onUpdate((event) => { translation.value = event.translationY; })
    .onEnd((event) => { runOnJS(onMove)(Math.round(event.translationY / QUEUE_ROW_HEIGHT)); })
    .onFinalize(() => {
      active.value = false;
      translation.value = withTiming(0, { duration: 120 });
      runOnJS(onDragging)(false);
    });

  return (
    <Animated.View style={[{ height: QUEUE_ROW_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8, gap: 8, opacity: dimmed ? 0.45 : 1 }, style]}>
      {children}
      <GestureDetector gesture={pan}>
        <View accessible accessibilityRole="adjustable" accessibilityLabel={`Move ${label}`} accessibilityHint="Hold and drag to reorder, or use the move up and move down actions" accessibilityActions={[{ name: "increment", label: "Move down" }, { name: "decrement", label: "Move up" }]} onAccessibilityAction={(event) => onMove(event.nativeEvent.actionName === "increment" ? 1 : -1)} style={{ width: 36, height: 44, alignItems: "center", justifyContent: "center" }}>
          <GripVertical size={18} color={colors.muted} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}
