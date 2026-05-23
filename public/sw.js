const CACHE_VERSION = "spotify-v6";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, RUNTIME_CACHE]);

const SHELL_URLS = [
  "/",
  "/liked",
  "/search",
  "/library",
  "/settings",
  "/upload",
  "/icon.svg",
  "/icon-512.png",
  "/apple-icon.png",
  "/favicon.ico",
];

function isCacheableResponse(response) {
  return response && response.ok && response.type !== "opaqueredirect";
}

async function putCache(cacheName, request, response) {
  if (!isCacheableResponse(response)) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch {}
}

function refreshCache(cacheName, request) {
  return fetch(request)
    .then(async (response) => {
      await putCache(cacheName, request, response);
      return response;
    })
    .catch(() => undefined);
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await putCache(cacheName, request, response);
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    await putCache(cacheName, request, response);
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("network and cache miss");
  }
}

async function staleWhileRevalidate(event, request, cacheName) {
  const cached = await caches.match(request);
  const refreshed = refreshCache(cacheName, request);
  event.waitUntil(refreshed.then(() => undefined));
  if (cached) {
    return cached;
  }

  const response = await refreshed;
  return response || fetch(request);
}

async function navigationResponse(event, request) {
  try {
    const response = await fetch(request);
    event.waitUntil(putCache(SHELL_CACHE, request, response.clone()));
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match("/", { ignoreSearch: true }));
    if (cached) {
      return cached;
    }

    return new Response("<!doctype html><title>Spotify</title><body>Spotify is offline.</body>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 503,
    });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => undefined))))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(
            (key) => !CURRENT_CACHES.has(key),
          )
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol === "blob:" || url.protocol === "data:") return;
  if (url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(event, request));
    return;
  }

  if (request.headers.has("range")) {
    return;
  }

  if (url.pathname.startsWith("/api/auth/")) {
    return;
  }

  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/icon-512.png" ||
    url.pathname === "/apple-icon.png" ||
    url.pathname === "/favicon.ico"
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (
    request.destination === "image" ||
    request.destination === "font" ||
    request.destination === "style" ||
    request.destination === "script" ||
    url.pathname.startsWith("/_next/image") ||
    url.pathname.startsWith("/api/artwork/")
  ) {
    event.respondWith(staleWhileRevalidate(event, request, RUNTIME_CACHE));
  }
});
