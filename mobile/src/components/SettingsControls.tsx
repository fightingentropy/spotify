import { ActivityIndicator, Pressable, Text } from "react-native";
import { type LucideIcon } from "lucide-react-native";
import { colors } from "@/theme";

// Flat full-width action row beneath a settings group ("Clear downloads",
// "Clear cache"). Styled like the app's other settings rows — no card, no
// gradient — just an icon + label that highlights on press.
// tone: danger = red, success = emerald, default = neutral.
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
  const fg = tone === "danger" ? "#f8717a" : tone === "success" ? colors.emerald : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingHorizontal: 16,
        minHeight: 52,
        opacity: disabled || busy ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon size={22} color={fg} />}
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
