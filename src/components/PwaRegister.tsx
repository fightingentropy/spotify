"use client";

import { useEffect } from "react";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_APP_SHELL_MESSAGE = { type: "CACHE_APP_SHELL" };
const APP_ASSETS_CACHE = "spotify-app-assets-v1";
const OFFLINE_ASSETS_MANIFEST_URL = "/offline-assets.json";
const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>();
const WARM_APP_SHELL_COALESCE_MS = 5_000;
let lastWarmAppShellAt = 0;

function isVersionedAppCache(cacheName: string): boolean {
  return cacheName.startsWith("spotify-v") || cacheName === APP_ASSETS_CACHE;
}

function isNativeCapacitorApp(): boolean {
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  try {
    return !!capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

function warmAppShell(registration: ServiceWorkerRegistration) {
  const target =
    navigator.serviceWorker.controller || registration.active || registration.waiting;
  if (!target) return;
  const timestamp = Date.now();
  if (timestamp - lastWarmAppShellAt < WARM_APP_SHELL_COALESCE_MS) return;
  lastWarmAppShellAt = timestamp;
  try {
    target.postMessage(CACHE_APP_SHELL_MESSAGE);
  } catch {}
}

function warmWhenWorkerActivates(registration: ServiceWorkerRegistration) {
  warmAppShell(registration);
  const worker = registration.installing || registration.waiting;
  if (!worker) return;
  const handleStateChange = () => {
    if (worker.state === "activated") {
      lastWarmAppShellAt = 0;
      warmAppShell(registration);
      worker.removeEventListener("statechange", handleStateChange);
    }
  };
  worker.addEventListener("statechange", handleStateChange);
}

function watchRegistration(registration: ServiceWorkerRegistration) {
  if (watchedRegistrations.has(registration)) return;
  watchedRegistrations.add(registration);
  registration.addEventListener("updatefound", () => warmWhenWorkerActivates(registration));
}

async function warmAppAssetsFromPage(): Promise<void> {
  if (typeof caches === "undefined") return;
  if (navigator.onLine === false) return;
  try {
    const response = await fetch(OFFLINE_ASSETS_MANIFEST_URL, {
      cache: "reload",
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = (await response.clone().json().catch(() => null)) as { files?: unknown } | null;
    const files = Array.isArray(payload?.files)
      ? payload.files.filter((value): value is string => typeof value === "string" && value.startsWith("/assets/"))
      : [];
    if (files.length === 0) return;

    const cache = await caches.open(APP_ASSETS_CACHE);
    await cache.put(OFFLINE_ASSETS_MANIFEST_URL, response);
    await Promise.all(
      files.map(async (file) => {
        const url = new URL(file, location.origin).toString();
        if (await caches.match(url)) return;
        const assetResponse = await fetch(url, {
          cache: "reload",
          credentials: "same-origin",
        });
        if (assetResponse.ok) await cache.put(url, assetResponse);
      }),
    );
  } catch {}
}

async function resetDevelopmentServiceWorkers(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  const registrations = await navigator.serviceWorker.getRegistrations();
  const results = await Promise.all(registrations.map((registration) => registration.unregister()));

  if (typeof caches !== "undefined") {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter(isVersionedAppCache)
        .map((cacheName) => caches.delete(cacheName)),
    );
  }

  if (hadController && results.some(Boolean)) {
    window.location.reload();
  }
}

export default function PwaRegister() {
  useEffect(() => {
    if (isNativeCapacitorApp()) return;
    if (import.meta.env.DEV) {
      void resetDevelopmentServiceWorkers().catch(() => undefined);
      return;
    }
    if (!("serviceWorker" in navigator)) return;

    let lastUpdateCheck = 0;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        warmWhenWorkerActivates(registration);
        watchRegistration(registration);
        navigator.serviceWorker.ready
          .then(warmAppShell)
          .catch(() => undefined);
        void warmAppAssetsFromPage();

        if (navigator.onLine === false) return;
        const timestamp = Date.now();
        if (timestamp - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
        lastUpdateCheck = timestamp;
        warmWhenWorkerActivates(await registration.update());
        void warmAppAssetsFromPage();
      } catch {
        // Service worker registration is optional for core app functionality.
      }
    };

    const refreshServiceWorker = () => {
      if (document.visibilityState !== "visible") return;
      if (navigator.onLine === false) return;
      void register();
    };

    document.addEventListener("visibilitychange", refreshServiceWorker);
    window.addEventListener("pageshow", refreshServiceWorker);
    window.addEventListener("online", refreshServiceWorker);

    if (document.readyState === "complete") {
      void register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => {
      window.removeEventListener("load", register);
      document.removeEventListener("visibilitychange", refreshServiceWorker);
      window.removeEventListener("pageshow", refreshServiceWorker);
      window.removeEventListener("online", refreshServiceWorker);
    };
  }, []);

  return null;
}
