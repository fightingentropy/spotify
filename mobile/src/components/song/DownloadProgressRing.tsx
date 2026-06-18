import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "@/theme";

// Spotify-style download fill ring. Pass `progress` (0..1) for a determinate
// fill while a download streams in; omit it for an indeterminate spinner while
// the item waits its turn in the serial pump. Optional `children` render
// centred (e.g. a small stop square to signal "tap to cancel").
export function DownloadProgressRing({
  size = 22,
  strokeWidth = 2,
  progress,
  color = colors.emerald,
  trackColor = "rgba(255,255,255,0.18)",
  children,
}: {
  size?: number;
  strokeWidth?: number;
  progress?: number;
  color?: string;
  trackColor?: string;
  children?: ReactNode;
}) {
  const radius = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * radius;
  const indeterminate = progress == null;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!indeterminate) return undefined;
    const anim = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 850, easing: Easing.linear, useNativeDriver: true }),
    );
    anim.start();
    return () => anim.stop();
  }, [indeterminate, spin]);

  const clamped = Math.max(0, Math.min(1, progress ?? 0));
  // A tiny floor so a freshly-started download still shows a sliver of arc.
  const arc = indeterminate ? circ * 0.28 : circ * Math.max(clamped, clamped > 0 ? 0.04 : 0);
  const center = size / 2;

  const ring = (
    <Svg width={size} height={size}>
      <Circle cx={center} cy={center} r={radius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
      <Circle
        cx={center}
        cy={center}
        r={radius}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${arc} ${circ}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {indeterminate ? (
        <Animated.View
          style={{ transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}
        >
          {ring}
        </Animated.View>
      ) : (
        ring
      )}
      {children != null ? <View style={{ position: "absolute" }}>{children}</View> : null}
    </View>
  );
}
