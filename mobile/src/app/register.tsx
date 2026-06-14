import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { MailCheck } from "lucide-react-native";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { ErrorText } from "@/components/ui/States";
import { apiFetch } from "@/lib/http";
import { colors } from "@/theme";

export default function RegisterScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, email: email.trim(), password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not create your account");
      }
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your account");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { color: colors.foreground, height: 50, fontSize: 16, paddingHorizontal: 14, backgroundColor: "#1f1f1f", borderRadius: 8 } as const;

  if (submitted) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center px-8" style={{ gap: 16 }}>
          <MailCheck size={56} color={colors.emerald} />
          <Text className="text-center text-2xl font-bold" style={{ color: colors.foreground }}>
            Check your email
          </Text>
          <Text className="text-center text-base" style={{ color: colors.muted }}>
            We sent a verification link to {email.trim()}. Open it to finish setting up your account.
          </Text>
          <PressableScale onPress={() => router.replace("/signin")} className="mt-2 rounded-full px-6 py-3" style={{ backgroundColor: colors.green }}>
            <Text className="font-bold text-black">Back to sign in</Text>
          </PressableScale>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View className="flex-1 justify-center px-6" style={{ gap: 16 }}>
          <Text className="mb-2 text-3xl font-bold" style={{ color: colors.foreground }}>
            Create account
          </Text>
          <TextInput value={name} onChangeText={setName} placeholder="Name (optional)" placeholderTextColor={colors.muted} style={inputStyle} />
          <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="email-address" style={inputStyle} />
          <TextInput value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.muted} secureTextEntry style={inputStyle} />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PressableScale
            onPress={submit}
            disabled={busy || !email || !password}
            className="items-center rounded-full py-3.5"
            style={{ backgroundColor: colors.green, opacity: busy || !email || !password ? 0.6 : 1 }}
          >
            <Text className="text-base font-bold text-black">{busy ? "Creating…" : "Create account"}</Text>
          </PressableScale>
          <PressableScale onPress={() => router.replace("/signin")} className="items-center py-2">
            <Text style={{ color: colors.muted }}>
              Already have an account? <Text style={{ color: colors.foreground, fontWeight: "600" }}>Sign in</Text>
            </Text>
          </PressableScale>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
