import { type ReactNode, useState } from "react";
import {
  type GestureResponderEvent,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

type Props = Omit<PressableProps, "style"> & {
  children: ReactNode;
  // Press-feedback scale (styles.css: scale(0.985)). List rows pass 1 to opt out.
  scaleTo?: number;
  className?: string;
  style?: StyleProp<ViewStyle>;
};

// Press-feedback wrapper. Uses a plain Pressable so NativeWind's `className` is
// applied natively. (The previous Animated.createAnimatedComponent + cssInterop
// wrapper silently dropped className AND inline width when combined with a
// Reanimated animated style — which is why Home tiles ballooned to full width and
// the tab bar collapsed to the left.) The press scale rides Pressable's built-in
// pressed state: instant instead of the web's 160ms ease, imperceptible at 1.5%.
export function PressableScale({ children, scaleTo = 0.985, style, onPressIn, onPressOut, ...props }: Props) {
  const animates = scaleTo !== 1;
  const [pressed, setPressed] = useState(false);

  if (!animates) {
    return (
      <Pressable {...props} style={style} onPressIn={onPressIn} onPressOut={onPressOut}>
        {children}
      </Pressable>
    );
  }

  return (
    <Pressable
      {...props}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[{ transform: [{ scale: pressed ? scaleTo : 1 }] }, style]}
    >
      {children}
    </Pressable>
  );
}
