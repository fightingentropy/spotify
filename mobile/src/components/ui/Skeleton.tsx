import { useEffect } from "react";
import { type DimensionValue, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "@/theme";

// Mirrors .wf-skeleton + ::after shimmer (bg rgba(255,255,255,.08), a sweeping
// gradient over 1.25s ease-in-out). RN has no pseudo-elements, so the shimmer is
// a real child View.
export function Skeleton({
  width,
  height,
  radius = 6,
  style,
}: {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  style?: ViewStyle;
}) {
  const x = useSharedValue(-1);
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 1250, easing: Easing.inOut(Easing.ease) }), -1, false);
  }, [x]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: `${x.value * 100}%` }],
  }));

  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.skeletonBase, overflow: "hidden" },
        style,
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
        <LinearGradient
          colors={["transparent", colors.skeletonShimmer, "transparent"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}
