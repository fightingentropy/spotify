import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type LucideIcon } from "lucide-react-native";
import { colors } from "@/theme";

// Flat destructive/neutral action row beneath a settings group ("Clear
// downloads", "Clear cache"). Built to match the status rows exactly — the
// icon sits in an 18px box and the label fills the row — so it lines up with
// the rest of the page at the same icon (x=16) / label (x=46) columns instead
// of floating. Horizontal padding comes from the parent (16); pass `divider`
// for the hairline that ties it into the list above.
// tone: danger = red, success = emerald, default = neutral.
export function FooterButton({
  icon: Icon,
  label,
  tone = "default",
  busy,
  disabled,
  divider,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "danger" | "success";
  busy?: boolean;
  disabled?: boolean;
  divider?: boolean;
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
        borderTopWidth: divider ? 1 : 0,
        borderTopColor: colors.line,
        opacity: disabled || busy ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      {/* The row layout lives on an inner plain View — identical to <Row> above.
          Putting flexDirection:"row" directly on the Pressable stacked the icon
          above the label in this RN/Fabric setup. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 }}>
        <View style={{ width: 18, alignItems: "center" }}>
          {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon size={18} color={fg} />}
        </View>
        <Text style={{ flex: 1, color: fg, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      </View>
    </Pressable>
  );
}
