import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// A small centered modal for naming a playlist — reused for Create and Rename
// (driven by ui.namePrompt). Renders nothing until a prompt is requested.
export function PlaylistNamePrompt() {
  const target = useUiStore((s) => s.namePrompt);
  const close = useUiStore((s) => s.closeNamePrompt);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (target) setValue(target.initialValue);
  }, [target]);

  const submit = () => {
    const name = value.trim();
    if (!name) return;
    target?.onSubmit(name);
    close();
  };

  return (
    <Modal visible={!!target} transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
      <Pressable
        onPress={close}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 28 }}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          {/* Inner press stops the backdrop tap from closing while interacting. */}
          <Pressable onPress={() => {}} style={{ backgroundColor: "#1c1c1e", borderRadius: 14, padding: 20 }}>
            <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "700", textAlign: "center" }}>
              {target?.title ?? "Playlist"}
            </Text>
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder={target?.placeholder ?? "Playlist name"}
              placeholderTextColor={colors.muted}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              maxLength={120}
              onSubmitEditing={submit}
              style={{
                color: colors.foreground,
                fontSize: 16,
                height: 48,
                paddingHorizontal: 14,
                backgroundColor: "#2c2c2e",
                borderRadius: 8,
                marginTop: 16,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <PressableScale onPress={close} className="px-4 py-2">
                <Text style={{ color: colors.muted, fontSize: 15, fontWeight: "600" }}>Cancel</Text>
              </PressableScale>
              <PressableScale onPress={submit} className="rounded-full px-5 py-2" style={{ backgroundColor: colors.emerald }}>
                <Text style={{ color: "#000", fontSize: 15, fontWeight: "700" }}>{target?.confirmLabel ?? "Save"}</Text>
              </PressableScale>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
