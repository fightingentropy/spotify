import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/client/auth";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { signIn } = useAuth();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-16 px-4">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="signin-email" className="block text-sm mb-1">Email</label>
          <input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "signin-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        <div>
          <label htmlFor="signin-password" className="block text-sm mb-1">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? "signin-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        {error && (
          <div id="signin-error" role="alert" className="text-sm text-red-600">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full h-10 rounded bg-foreground text-background disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-sm">
        Don&apos;t have an account? <Link className="underline" to="/register">Register</Link>
      </p>
    </div>
  );
}
