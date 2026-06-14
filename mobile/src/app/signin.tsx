import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { ErrorText } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid email or password");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { color: colors.foreground, height: 50, fontSize: 16, paddingHorizontal: 14 } as const;

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View className="flex-1 justify-center px-6" style={{ gap: 16 }}>
          <Text className="mb-2 text-3xl font-bold" style={{ color: colors.foreground }}>
            Sign in
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            style={[inputStyle, { backgroundColor: "#1f1f1f", borderRadius: 8 }]}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            autoComplete="password"
            style={[inputStyle, { backgroundColor: "#1f1f1f", borderRadius: 8 }]}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PressableScale
            onPress={submit}
            disabled={busy || !email || !password}
            className="items-center rounded-full py-3.5"
            style={{ backgroundColor: colors.green, opacity: busy || !email || !password ? 0.6 : 1 }}
          >
            <Text className="text-base font-bold text-black">{busy ? "Signing in…" : "Sign in"}</Text>
          </PressableScale>
          <PressableScale onPress={() => router.replace("/register")} className="items-center py-2">
            <Text style={{ color: colors.muted }}>
              Don&apos;t have an account? <Text style={{ color: colors.foreground, fontWeight: "600" }}>Register</Text>
            </Text>
          </PressableScale>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
