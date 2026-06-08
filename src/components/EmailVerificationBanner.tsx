import { useEffect, useState } from "react";
import { useAuth } from "@/client/auth";

type VerifyResult = "success" | "expired" | "invalid";

function readVerifiedParam(): VerifyResult | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("verified");
  return value === "success" || value === "expired" || value === "invalid" ? value : null;
}

function stripVerifiedParam(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("verified")) return;
  params.delete("verified");
  const query = params.toString();
  const next = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
  window.history.replaceState(null, "", next);
}

export default function EmailVerificationBanner() {
  const { user, refresh, resendVerification } = useAuth();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [dismissed, setDismissed] = useState(false);

  // Handle the ?verified=... redirect the Worker sends after an email link click.
  useEffect(() => {
    const verified = readVerifiedParam();
    if (!verified) return;
    setResult(verified);
    if (verified === "success") void refresh();
    stripVerifiedParam();
  }, [refresh]);

  async function onResend() {
    setResendState("sending");
    try {
      await resendVerification();
      setResendState("sent");
    } catch {
      setResendState("error");
    }
  }

  if (result === "success") {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-emerald-500/30 bg-emerald-500/15 px-4 py-3 text-sm text-emerald-100 sm:px-6"
      >
        <span>Your email is verified. Thanks!</span>
        <button
          type="button"
          onClick={() => setResult(null)}
          className="shrink-0 rounded px-2 py-1 text-emerald-200 underline-offset-2 hover:underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const needsVerification = Boolean(user) && user?.emailVerified === false;
  // Show the nudge when the account is unverified, or when a link came back
  // expired/invalid (so the user can request a fresh one).
  const showNudge = !dismissed && (needsVerification || result === "expired" || result === "invalid");
  if (!showNudge) return null;

  const linkProblem = result === "expired" ? "That link expired." : result === "invalid" ? "That link was invalid." : null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-3 text-sm text-amber-100 sm:px-6"
    >
      <span>
        {linkProblem ? `${linkProblem} ` : ""}
        Please verify your email{user?.email ? <> (<span className="font-medium">{user.email}</span>)</> : ""} to secure
        your account.
      </span>
      <div className="flex shrink-0 items-center gap-3">
        {resendState === "sent" ? (
          <span className="text-amber-200">Verification email sent — check your inbox.</span>
        ) : (
          <button
            type="button"
            onClick={onResend}
            disabled={resendState === "sending"}
            className="rounded-full border border-amber-300/50 px-3 py-1 font-medium text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-50"
          >
            {resendState === "sending" ? "Sending…" : resendState === "error" ? "Try again" : "Resend email"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded px-1 py-1 text-amber-200 underline-offset-2 hover:underline"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
