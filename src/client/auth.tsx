import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { invalidateApiCache } from "@/client/api";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type AuthContextValue = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_AUTH_USER_KEY = "spotify_cached_auth_user";

function coerceAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof AuthUser, unknown>>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") return null;
  return {
    id: candidate.id,
    email: candidate.email,
    name: typeof candidate.name === "string" ? candidate.name : null,
    image: typeof candidate.image === "string" ? candidate.image : null,
  };
}

function readCachedAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    return coerceAuthUser(JSON.parse(localStorage.getItem(CACHED_AUTH_USER_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeCachedAuthUser(user: AuthUser | null): void {
  if (typeof window === "undefined") return;
  try {
    if (user) localStorage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_AUTH_USER_KEY);
  } catch {}
}

function clearServiceWorkerApiCache(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const message = { type: "CLEAR_RUNTIME_CACHE" };
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(message);
  }
  navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initialUser] = useState<AuthUser | null>(() => readCachedAuthUser());
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [status, setStatus] = useState<AuthContextValue["status"]>(
    initialUser ? "authenticated" : "unauthenticated",
  );

  const refresh = useCallback(async (options?: { showLoading?: boolean }) => {
    if (options?.showLoading) setStatus("loading");
    try {
      const response = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Session check failed with ${response.status}`);
      const data = (await response.json().catch(() => ({}))) as { user?: AuthUser | null };
      const nextUser = coerceAuthUser(data.user ?? null);
      writeCachedAuthUser(nextUser);
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    } catch {
      const cachedUser = readCachedAuthUser();
      setUser(cachedUser);
      setStatus(cachedUser ? "authenticated" : "unauthenticated");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await fetch("/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { user?: AuthUser; error?: string };
    if (!response.ok || !data.user) {
      throw new Error(data.error || "Invalid email or password");
    }
    invalidateApiCache();
    clearServiceWorkerApiCache();
    writeCachedAuthUser(data.user);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/signout", {
      method: "POST",
      credentials: "include",
    }).catch(() => null);
    invalidateApiCache();
    clearServiceWorkerApiCache();
    writeCachedAuthUser(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(
    () => ({ user, status, refresh, signIn, signOut }),
    [refresh, signIn, signOut, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
