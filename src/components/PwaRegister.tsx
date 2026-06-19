"use client";

import { useEffect } from "react";

// The web app no longer ships a service worker — offline/PWA support was removed
// in favour of the native iOS app. Older builds DID register one, so proactively
// unregister any worker a previous visit installed and wipe its caches; otherwise
// returning visitors keep being served stale, offline-cached assets forever.
async function unregisterLegacyServiceWorkers(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);

  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  const unregistered = await Promise.all(
    registrations.map((registration) => registration.unregister().catch(() => false)),
  );

  if (typeof caches !== "undefined") {
    const cacheNames = await caches.keys().catch(() => [] as string[]);
    await Promise.all(cacheNames.map((name) => caches.delete(name).catch(() => false)));
  }

  // Reload once so the page detaches from the now-removed controller and fetches
  // fresh assets from the network. After the reload there's no controller, so
  // this branch can't loop.
  if (hadController && unregistered.some(Boolean)) {
    window.location.reload();
  }
}

export default function PwaRegister() {
  useEffect(() => {
    void unregisterLegacyServiceWorkers().catch(() => undefined);
  }, []);

  return null;
}
