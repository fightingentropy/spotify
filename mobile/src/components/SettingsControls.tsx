import { type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { type LucideIcon } from "lucide-react-native";
import { colors } from "@/theme";

// Frosted "liquid glass" surface for settings sections: a translucent blurred
// panel with a top-down sheen and a hairline highlight border, softly floated
// off the background. Children supply their own padding.
export function GlassCard({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          borderRadius: 22,
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 10 },
        },
        style,
      ]}
    >
      <View style={{ borderRadius: 22, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" }}>
        <BlurView intensity={36} tint="dark">
          <LinearGradient
            colors={["rgba(255,255,255,0.10)", "rgba(255,255,255,0.025)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {children}
        </BlurView>
      </View>
    </View>
  );
}

// Full-width action button beneath a settings group (e.g. "Clear downloads",
// "Clear cache"). Shares the glass treatment so it reads as a deliberate control
// rather than floating text. tone: danger = red, success = emerald, default = neutral.
export function FooterButton({
  icon: Icon,
  label,
  tone = "default",
  busy,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "danger" | "success";
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const fg = tone === "danger" ? "#ff6b6b" : tone === "success" ? colors.emerald : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({ marginTop: 14, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 })}
    >
      <View style={{ borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)" }}>
        <BlurView intensity={28} tint="dark">
          <LinearGradient
            colors={["rgba(255,255,255,0.07)", "rgba(255,255,255,0.015)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, minHeight: 54 }}>
            {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon size={18} color={fg} />}
            <Text style={{ color: fg, fontSize: 15, fontWeight: "600" }}>{label}</Text>
          </View>
        </BlurView>
      </View>
    </Pressable>
  );
}
