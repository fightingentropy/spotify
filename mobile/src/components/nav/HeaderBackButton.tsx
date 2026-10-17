import type { ColorValue } from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

// iOS 26+ draws the native back button as a round glass control. Android's native
// header would draw a bare Material arrow over artwork, so pushed screens there
// use this matching circle instead.
export function HeaderBackButton({ tintColor }: { tintColor?: ColorValue }) {
  const router = useRouter();
  return (
    <PressableScale
      onPress={() => router.back()}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(38,38,40,0.88)",
        borderWidth: 0.5,
        borderColor: colors.hairline,
      }}
    >
      <ChevronLeft size={26} color={typeof tintColor === "string" ? tintColor : colors.foreground} strokeWidth={2.2} style={{ marginLeft: -2 }} />
    </PressableScale>
  );
}
