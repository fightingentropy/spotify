import { useEffect, useState } from "react";
import { type LayoutChangeEvent, Text, type TextStyle, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// RN port of .wf-marquee. If the text overflows its container it scrolls left
// then returns (dwell at both ends), per the wf-marquee-scroll keyframe; short
// text falls back to a single ellipsized line. The CSS edge-fade mask is omitted.
export function MarqueeText({
  children,
  active = true,
  className,
  style,
  durationMs = 9000,
}: {
  children: string;
  active?: boolean;
  className?: string;
  style?: TextStyle;
  durationMs?: number;
}) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const overflow = active && textW > containerW + 1 && containerW > 0;
  const distance = overflow ? textW - containerW : 0;

  const tx = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(tx);
    tx.value = 0;
    if (overflow) {
      tx.value = withRepeat(
        withDelay(1500, withTiming(-distance, { duration: Math.max(2000, durationMs * 0.66), easing: Easing.linear })),
        -1,
        true,
      );
    }
    return () => cancelAnimation(tx);
  }, [overflow, distance, durationMs, tx]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

  return (
    <View onLayout={(e: LayoutChangeEvent) => setContainerW(e.nativeEvent.layout.width)} style={{ overflow: "hidden" }}>
      <Animated.View style={overflow ? animatedStyle : undefined}>
        <Text
          numberOfLines={1}
          className={className}
          style={[style, overflow ? { width: textW } : undefined]}
          onLayout={(e: LayoutChangeEvent) => setTextW(e.nativeEvent.layout.width)}
        >
          {children}
        </Text>
      </Animated.View>
    </View>
  );
}
