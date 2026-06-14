import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { API_AUTH_REQUIRED_EVENT, invalidateApiCache } from "@/lib/api";
import { on } from "@/lib/events";
import { apiFetch } from "@/lib/http";
import { storage } from "@/lib/storage";
import { setOfflineAccountScope } from "@/store/offline";
import { useLikesStore } from "@/store/likes";

// Ported from src/client/auth.tsx. Logic preserved (auth generation guard, cached
// user, session refresh with a 2.5s timeout, forced-logout on 401). Changes:
// localStorage → MMKV storage; fetch → apiFetch; the LAN/localhost auto-trust,
// serviceWorker/Cache-API profile-image warming, navigator.onLine, and Capacitor
// multipart base64 workaround are all dropped (§9). The native cookie store keeps
// the session across launches, so no token persistence is needed here.

// An image picked via expo-image-picker (uri + name + mime), for multipart upload.
export type ProfileImageAsset = { uri: string; name: string; type: string };

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfileImage: (asset: ProfileImageAsset) => Promise<void>;
  resendVerification: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_AUTH_USER_KEY = "spotify_cached_auth_user";
const CACHED_AUTH_SIGNED_OUT_KEY = "spotify_auth_signed_out";
const ERLIN_PROFILE_IMAGE_URL = "/profile.jpg";
const SESSION_REFRESH_TIMEOUT_MS = 2_500;

function defaultAuthUserImage(email: string, name: string | null): string | null {
  const normalizedName = name?.trim().toLowerCase() || "";
  const emailLocalPart = email.split("@")[0]?.trim().toLowerCase() || "";
  if (
    normalizedName === "erlin" ||
    normalizedName === "erlin hoxha" ||
    emailLocalPart === "erlin" ||
    emailLocalPart === "erlinhoxha"
  ) {
    return ERLIN_PROFILE_IMAGE_URL;
  }
  return null;
}

function coerceAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof AuthUser, unknown>>;
  if (typeof candidate.id !== "string" || typeof candidate.email !== "string") return null;
  const name = typeof candidate.name === "string" ? candidate.name : null;
  const defaultImage = defaultAuthUserImage(candidate.email, name);
  const storedImage = typeof candidate.image === "string" && candidate.image.trim() ? candidate.image : null;
  return {
    id: candidate.id,
    email: candidate.email,
    name,
    image: storedImage || defaultImage,
    // Default to verified when the field is absent (older cached users / local
    // owner) so we never falsely nag; the server sends an explicit boolean.
    emailVerified: candidate.emailVerified !== false,
  };
}

function readCachedAuthUser(): AuthUser | null {
  try {
    return coerceAuthUser(JSON.parse(storage.getItem(CACHED_AUTH_USER_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeCachedAuthUser(user: AuthUser | null, options?: { signedOut?: boolean }): void {
  try {
    if (user) {
      storage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
      storage.removeItem(CACHED_AUTH_SIGNED_OUT_KEY);
    } else {
      storage.removeItem(CACHED_AUTH_USER_KEY);
      if (options?.signedOut) storage.setItem(CACHED_AUTH_SIGNED_OUT_KEY, "1");
    }
  } catch {}
}

function initialAuthStatus(user: AuthUser | null): AuthContextValue["status"] {
  return user ? "authenticated" : "loading";
}

async function fetchSession(): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = apiFetch("/api/auth/session", {
      cache: "no-store",
      signal: controller?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error("Session check timed out"));
      }, SESSION_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initialUser] = useState<AuthUser | null>(() => readCachedAuthUser());
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [status, setStatus] = useState<AuthContextValue["status"]>(() => initialAuthStatus(initialUser));
  const userIdRef = useRef<string | null>(initialUser?.id ?? null);
  // Bumped whenever auth state is set authoritatively (sign in/out, forced
  // logout). An in-flight refresh() captures this at its start and bails if it
  // changed, so a slow session check can't resurrect a just-signed-out user.
  const authGenerationRef = useRef(0);

  const refresh = useCallback(async (options?: { showLoading?: boolean }) => {
    const generation = authGenerationRef.current;
    const isStale = () => authGenerationRef.current !== generation;
    if (options?.showLoading) setStatus("loading");
    try {
      const response = await fetchSession();
      if (isStale()) return;
      if (response.status === 401 || response.status === 403) {
        invalidateApiCache();
        writeCachedAuthUser(null, { signedOut: true });
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      if (!response.ok) throw new Error(`Session check failed with ${response.status}`);
      const data = (await response.json().catch(() => ({}))) as { user?: AuthUser | null };
      if (isStale()) return;
      const nextUser = coerceAuthUser(data.user ?? null);
      writeCachedAuthUser(nextUser, { signedOut: !nextUser });
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    } catch {
      if (isStale()) return;
      const cachedUser = readCachedAuthUser();
      setUser(cachedUser);
      setStatus(cachedUser ? "authenticated" : "unauthenticated");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = on(API_AUTH_REQUIRED_EVENT, () => {
      authGenerationRef.current += 1;
      invalidateApiCache();
      writeCachedAuthUser(null, { signedOut: true });
      setUser(null);
      setStatus("unauthenticated");
    });
    return off;
  }, []);

  useEffect(() => {
    setOfflineAccountScope(user?.id ?? status);
  }, [status, user?.id]);

  useEffect(() => {
    const nextUserId = user?.id ?? null;
    if (userIdRef.current === nextUserId) return;
    userIdRef.current = nextUserId;
    useLikesStore.getState().resetRemote();
  }, [user?.id]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await apiFetch("/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) {
      throw new Error(data.error || "Invalid email or password");
    }
    authGenerationRef.current += 1;
    invalidateApiCache();
    writeCachedAuthUser(nextUser);
    setOfflineAccountScope(nextUser.id);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    authGenerationRef.current += 1;
    await apiFetch("/api/auth/signout", { method: "POST" }).catch(() => null);
    invalidateApiCache();
    writeCachedAuthUser(null, { signedOut: true });
    setOfflineAccountScope("unauthenticated");
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const updateProfileImage = useCallback(async (asset: ProfileImageAsset) => {
    // RN multipart: FormData accepts a { uri, name, type } file part natively.
    // (The web app's Capacitor base64-JSON workaround is dropped — §9.)
    const form = new FormData();
    form.append("image", {
      uri: asset.uri,
      name: asset.name,
      type: asset.type,
    } as unknown as Blob);
    const response = await apiFetch("/api/profile/image", {
      method: "POST",
      body: form,
    });
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) {
      throw new Error(data.error || "Failed to update profile image");
    }
    writeCachedAuthUser(nextUser);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const resendVerification = useCallback(async () => {
    const response = await apiFetch("/api/auth/resend-verification", { method: "POST" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to resend verification email");
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, refresh, signIn, signOut, updateProfileImage, resendVerification }),
    [refresh, signIn, signOut, status, updateProfileImage, resendVerification, user],
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
