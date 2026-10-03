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
        className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-5 py-3 text-sm text-white/80 sm:px-8"
      >
        <span>Your email is verified. Thanks!</span>
        <button
          type="button"
          onClick={() => setResult(null)}
          className="wf-button"
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
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-white/10 bg-white/[0.025] px-5 py-3 text-sm text-white/80 sm:px-8"
    >
      <span>
        {linkProblem ? `${linkProblem} ` : ""}
        Please verify your email{user?.email ? <> (<span className="font-medium">{user.email}</span>)</> : ""} to secure
        your account.
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {resendState === "sent" ? (
          <span className="wf-muted">Verification email sent — check your inbox.</span>
        ) : (
          <button
            type="button"
            onClick={onResend}
            disabled={resendState === "sending"}
            className="wf-button"
          >
            {resendState === "sending" ? "Sending…" : resendState === "error" ? "Try again" : "Resend email"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="wf-button"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
