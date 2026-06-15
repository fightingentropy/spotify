import { ActivityIndicator, Pressable, Text } from "react-native";
import { type LucideIcon } from "lucide-react-native";
import { colors } from "@/theme";

// Full-width action button used as a "footer" beneath a settings group
// (e.g. "Clear downloads", "Clear cache"). Shared so both read identically.
// tone: danger = red, success = emerald (transient confirmation), default = neutral.
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
  const fg = tone === "danger" ? "#f87171" : tone === "success" ? colors.emerald : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        marginTop: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 16,
        minHeight: 50,
        borderRadius: 16,
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.line,
        opacity: disabled || busy ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon size={18} color={fg} />}
      <Text style={{ color: fg, fontSize: 15, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
