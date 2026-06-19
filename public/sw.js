// Tombstone service worker. The app dropped offline/PWA support (it now lives in
// the native iOS app), so this replaces the old caching worker: when a client
// running a previous build checks for an update it picks this up, deletes every
// cache the old worker created, and unregisters itself. New visitors never
// register a worker at all (see src/components/PwaRegister.tsx).
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      await self.clients.claim();
    })(),
  );
});
