import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

// RN port of src/components/EmailVerificationBanner.tsx. Shows an amber nudge when
// the signed-in user's email is unverified, with a Resend action (proxied through
// useAuth().resendVerification → POST /api/auth/resend-verification via apiFetch)
// and a session-local Dismiss. The web app's ?verified= success banner is dropped:
// mobile has no URL query, so the Worker can't hand back a redirect param (§ port).

// Amber tones (Tailwind amber-500/300/100) kept as literals — there's no amber
// token in @/theme; `colors` is imported for the dismiss glyph so the tint stays
// in sync with the rest of the app's chrome.
const AMBER_BG = "rgba(245,158,11,0.15)"; // amber-500/15
const AMBER_BORDER = "rgba(245,158,11,0.30)"; // amber-500/30
const AMBER_TEXT = "#fde68a"; // amber-200/-100 range, legible on the wash
const AMBER_STRONG = "#fcd34d"; // amber-300, for the title + button outline

type ResendState = "idle" | "sending" | "sent" | "error";

export function EmailVerificationBanner() {
  const { user, status, resendVerification } = useAuth();
  const [resendState, setResendState] = useState<ResendState>("idle");
  const [dismissed, setDismissed] = useState(false);

  // Only nag a confirmed, signed-in account whose email is unverified.
  const shouldShow = status === "authenticated" && Boolean(user) && user?.emailVerified === false;
  if (!shouldShow || dismissed) return null;

  async function onResend() {
    if (resendState === "sending") return;
    setResendState("sending");
    try {
      await resendVerification();
      setResendState("sent");
    } catch {
      setResendState("error");
    }
  }

  const resendLabel =
    resendState === "sending"
      ? "Sending…"
      : resendState === "sent"
        ? "Sent"
        : resendState === "error"
          ? "Try again"
          : "Resend";

  return (
    <View
      accessibilityRole="alert"
      className="mx-4 my-2 flex-row items-center gap-3 rounded-row px-4 py-3"
      style={{ backgroundColor: AMBER_BG, borderWidth: 1, borderColor: AMBER_BORDER }}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-semibold" style={{ color: AMBER_STRONG }}>
          Verify your email
        </Text>
        <Text numberOfLines={2} className="mt-0.5 text-xs" style={{ color: AMBER_TEXT }}>
          {user?.email ? `Confirm ${user.email} to secure your account.` : "Confirm your email to secure your account."}
        </Text>
      </View>

      <PressableScale
        onPress={onResend}
        disabled={resendState === "sending" || resendState === "sent"}
        accessibilityRole="button"
        accessibilityLabel="Resend verification email"
        className="shrink-0 rounded-full px-3 py-1.5"
        style={{
          borderWidth: 1,
          borderColor: AMBER_STRONG,
          opacity: resendState === "sending" ? 0.5 : 1,
        }}
      >
        <Text className="text-xs font-semibold" style={{ color: AMBER_STRONG }}>
          {resendLabel}
        </Text>
      </PressableScale>

      <Pressable
        onPress={() => setDismissed(true)}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={8}
        className="shrink-0 p-1"
      >
        <X size={18} color={colors.iconIdle} />
      </Pressable>
    </View>
  );
}

export default EmailVerificationBanner;
