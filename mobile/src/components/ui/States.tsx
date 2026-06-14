import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

export function ErrorText({ children }: { children: string }) {
  return <Text style={{ color: "#f87171" }} className="text-sm">{children}</Text>;
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View className="items-center px-8 py-16">
      <Text className="text-center text-base font-medium" style={{ color: colors.foreground }}>
        {title}
      </Text>
      {subtitle ? (
        <Text className="mt-2 text-center text-sm" style={{ color: colors.muted }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function SignedOutPrompt({ message }: { message: string }) {
  const router = useRouter();
  return (
    <View className="items-center px-8 py-16">
      <Text className="mb-4 text-center text-base" style={{ color: colors.muted }}>
        {message}
      </Text>
      <PressableScale onPress={() => router.push("/signin")} className="rounded-full px-6 py-3" style={{ backgroundColor: colors.green }}>
        <Text className="font-semibold text-black">Sign in</Text>
      </PressableScale>
    </View>
  );
}
