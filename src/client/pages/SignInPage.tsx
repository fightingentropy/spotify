import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@/client/auth";
import { PageHeader, PageLayout } from "@/components/PageLayout";

function resolveRedirectTarget(
  state: unknown,
  search: string,
): string {
  // Prefer an explicit return-to passed via navigation state (e.g. from a
  // guard that bounced the user to /signin), then fall back to ?next=, else
  // home. Only accept same-origin path redirects to avoid open-redirects.
  const fromState =
    state && typeof state === "object" && "from" in state
      ? (state as { from?: unknown }).from
      : undefined;
  const next =
    typeof fromState === "string"
      ? fromState
      : new URLSearchParams(search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      navigate(resolveRedirectTarget(location.state, location.search), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageLayout narrow>
      <div className="max-w-md">
        <PageHeader title="Sign in" description="Access your personal music library." />
        <form onSubmit={onSubmit} className="wf-panel space-y-5 p-5">
          <div>
            <label htmlFor="signin-email" className="mb-2 block text-sm">Email</label>
            <input
              id="signin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? "signin-error" : undefined}
              className="wf-input w-full"
              required
            />
          </div>
          <div>
            <label htmlFor="signin-password" className="mb-2 block text-sm">Password</label>
            <input
              id="signin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={error ? "signin-error" : undefined}
              className="wf-input w-full"
              required
            />
          </div>
          {error && (
            <div id="signin-error" role="alert" className="text-sm text-red-300">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="wf-button-primary w-full"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p className="wf-muted mt-4 text-sm">
          Private personal library. Sign-in only.
        </p>
      </div>
    </PageLayout>
  );
}
