"use client";

import { useEffect } from "react";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

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

        if (navigator.onLine === false) return;
        const timestamp = Date.now();
        if (timestamp - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
        lastUpdateCheck = timestamp;
        await registration.update();
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
