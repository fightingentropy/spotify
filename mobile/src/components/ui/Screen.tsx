import { type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, layout } from "@/theme";

// Bottom space reserved on tab screens for the mini-player + tab bar + safe area.
export const CONTENT_BOTTOM_INSET = layout.mobileNavHeight + layout.mobilePlayerHeight + 24;

export function Screen({ children, topInset = true }: { children: ReactNode; topInset?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topInset ? insets.top : 0 }}>
      {children}
    </View>
  );
}
