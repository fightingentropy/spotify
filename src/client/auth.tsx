import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { API_AUTH_REQUIRED_EVENT, invalidateApiCache } from "@/client/api";
import { setOfflineAccountScope } from "@/client/offline";
import { useLikesStore } from "@/store/likes";

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
  updateProfileImage: (file: File) => Promise<void>;
  resendVerification: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_AUTH_USER_KEY = "spotify_cached_auth_user";
const CACHED_AUTH_SIGNED_OUT_KEY = "spotify_auth_signed_out";
const ERLIN_PROFILE_IMAGE_URL = "/profile.jpg";
const SESSION_REFRESH_TIMEOUT_MS = 2_500;
const PROFILE_IMAGE_CACHE = "spotify-media-v1";
const LOCAL_OFFLINE_AUTH_USER: AuthUser = {
  id: "local-mac-mini",
  email: "erlin@spotify.local",
  name: "Erlin",
  image: ERLIN_PROFILE_IMAGE_URL,
  emailVerified: true,
};

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

function sameOriginUrl(value: string | null | undefined): string | null {
  if (typeof window === "undefined" || !value || /^(blob:|data:)/i.test(value)) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function warmProfileImage(imageUrl: string | null | undefined): void {
  const url = sameOriginUrl(imageUrl);
  if (!url || typeof window === "undefined") return;

  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "CACHE_MEDIA",
      urls: [url],
      cacheName: PROFILE_IMAGE_CACHE,
    });
  } catch {}

  if (typeof caches === "undefined") return;
  void (async () => {
    try {
      const cache = await caches.open(PROFILE_IMAGE_CACHE);
      if (await cache.match(url)) return;
      const response = await fetch(url, {
        credentials: "include",
        cache: "reload",
      });
      if (response.ok) await cache.put(url, response);
    } catch {}
  })();
}

function isKnownOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function readLocalOfflineAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    if (localStorage.getItem(CACHED_AUTH_SIGNED_OUT_KEY) === "1") return null;
  } catch {}
  const hostname = window.location.hostname.toLowerCase();
  const localHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local");
  return localHost ? LOCAL_OFFLINE_AUTH_USER : null;
}

function readCachedAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    return coerceAuthUser(JSON.parse(localStorage.getItem(CACHED_AUTH_USER_KEY) || "null")) ?? readLocalOfflineAuthUser();
  } catch {
    return readLocalOfflineAuthUser();
  }
}

function writeCachedAuthUser(user: AuthUser | null, options?: { signedOut?: boolean }): void {
  if (typeof window === "undefined") return;
  try {
    if (user) {
      localStorage.setItem(CACHED_AUTH_USER_KEY, JSON.stringify(user));
      localStorage.removeItem(CACHED_AUTH_SIGNED_OUT_KEY);
    } else {
      localStorage.removeItem(CACHED_AUTH_USER_KEY);
      if (options?.signedOut) localStorage.setItem(CACHED_AUTH_SIGNED_OUT_KEY, "1");
    }
  } catch {}
}

function initialAuthStatus(user: AuthUser | null): AuthContextValue["status"] {
  if (user) return "authenticated";
  return isKnownOffline() ? "unauthenticated" : "loading";
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

async function fetchSession(): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutId: number | undefined;
  try {
    const request = fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
      signal: controller?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller?.abort();
        reject(new Error("Session check timed out"));
      }, SESSION_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initialUser] = useState<AuthUser | null>(() => readCachedAuthUser());
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [status, setStatus] = useState<AuthContextValue["status"]>(() => initialAuthStatus(initialUser));
  const userIdRef = useRef<string | null>(initialUser?.id ?? null);

  const refresh = useCallback(async (options?: { showLoading?: boolean }) => {
    if (isKnownOffline()) {
      const cachedUser = readCachedAuthUser();
      setUser(cachedUser);
      setStatus(cachedUser ? "authenticated" : "unauthenticated");
      return;
    }
    if (options?.showLoading) setStatus("loading");
    try {
      const response = await fetchSession();
      if (response.status === 401 || response.status === 403) {
        invalidateApiCache();
        clearServiceWorkerApiCache();
        writeCachedAuthUser(null, { signedOut: true });
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      if (!response.ok) throw new Error(`Session check failed with ${response.status}`);
      const data = (await response.json().catch(() => ({}))) as { user?: AuthUser | null };
      const nextUser = coerceAuthUser(data.user ?? null);
      writeCachedAuthUser(nextUser, { signedOut: !nextUser });
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => {
      void refresh();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [refresh]);

  useEffect(() => {
    warmProfileImage(user?.image);
  }, [user?.image]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleApiAuthRequired = () => {
      invalidateApiCache();
      clearServiceWorkerApiCache();
      writeCachedAuthUser(null, { signedOut: true });
      setUser(null);
      setStatus("unauthenticated");
    };
    window.addEventListener(API_AUTH_REQUIRED_EVENT, handleApiAuthRequired);
    return () => window.removeEventListener(API_AUTH_REQUIRED_EVENT, handleApiAuthRequired);
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
    const response = await fetch("/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { user?: unknown; error?: string };
    const nextUser = coerceAuthUser(data.user ?? null);
    if (!response.ok || !nextUser) {
      throw new Error(data.error || "Invalid email or password");
    }
    invalidateApiCache();
    clearServiceWorkerApiCache();
    writeCachedAuthUser(nextUser);
    setOfflineAccountScope(nextUser.id);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/signout", {
      method: "POST",
      credentials: "include",
    }).catch(() => null);
    invalidateApiCache();
    clearServiceWorkerApiCache();
    writeCachedAuthUser(null, { signedOut: true });
    setOfflineAccountScope("unauthenticated");
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const updateProfileImage = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("image", file);
    const response = await fetch("/api/profile/image", {
      method: "POST",
      credentials: "include",
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
    warmProfileImage(nextUser.image);
  }, []);

  const resendVerification = useCallback(async () => {
    const response = await fetch("/api/auth/resend-verification", {
      method: "POST",
      credentials: "include",
    });
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
