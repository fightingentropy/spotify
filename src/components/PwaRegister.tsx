"use client";

import { useEffect } from "react";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_APP_SHELL_MESSAGE = { type: "CACHE_APP_SHELL" };
const APP_ASSETS_CACHE = "spotify-app-assets-v1";
const OFFLINE_ASSETS_MANIFEST_URL = "/offline-assets.json";
const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>();

function warmAppShell(registration: ServiceWorkerRegistration) {
  try {
    navigator.serviceWorker.controller?.postMessage(CACHE_APP_SHELL_MESSAGE);
    registration.active?.postMessage(CACHE_APP_SHELL_MESSAGE);
    registration.waiting?.postMessage(CACHE_APP_SHELL_MESSAGE);
  } catch {}
}

function warmWhenWorkerActivates(registration: ServiceWorkerRegistration) {
  warmAppShell(registration);
  const worker = registration.installing || registration.waiting;
  if (!worker) return;
  const handleStateChange = () => {
    if (worker.state === "activated") {
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

export default function PwaRegister() {
  useEffect(() => {
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
