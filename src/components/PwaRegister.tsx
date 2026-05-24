"use client";

import { useEffect } from "react";

function hasActiveAudio(): boolean {
  return Array.from(document.querySelectorAll("audio")).some(
    (audio) => !audio.paused && !audio.ended,
  );
}

export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reloading = false;
    const reloadOnControllerChange = () => {
      if (reloading) return;
      reloading = true;
      if (!hasActiveAudio()) {
        window.location.reload();
        return;
      }

      const reloadWhenPlaybackStops = () => {
        if (hasActiveAudio()) return;
        window.location.reload();
      };
      for (const audio of Array.from(document.querySelectorAll("audio"))) {
        audio.addEventListener("pause", reloadWhenPlaybackStops, { once: true });
        audio.addEventListener("ended", reloadWhenPlaybackStops, { once: true });
      }
    };

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        await registration.update();
      } catch {
        // Service worker registration is optional for core app functionality.
      }
    };

    const refreshServiceWorker = () => {
      if (document.visibilityState !== "visible") return;
      void register();
    };

    navigator.serviceWorker.addEventListener("controllerchange", reloadOnControllerChange);
    document.addEventListener("visibilitychange", refreshServiceWorker);
    window.addEventListener("pageshow", refreshServiceWorker);

    if (document.readyState === "complete") {
      void register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", reloadOnControllerChange);
      document.removeEventListener("visibilitychange", refreshServiceWorker);
      window.removeEventListener("pageshow", refreshServiceWorker);
    };
  }, []);

  return null;
}
