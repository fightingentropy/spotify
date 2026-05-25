const CACHE_VERSION = "spotify-v12";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, RUNTIME_CACHE]);

const SHELL_URLS = [
  "/",
  "/liked",
  "/search",
  "/library",
  "/profile",
  "/settings",
  "/upload",
  "/icon.svg",
  "/icon-512.png",
  "/apple-icon.png",
  "/profile.jpg",
  "/favicon.ico",
  "/manifest.webmanifest",
];

const API_CACHE_PATHS = [
  "/api/home",
  "/api/library",
  "/api/liked",
  "/api/likes",
  "/api/songs",
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

function isCacheableApiRequest(url) {
  if (!url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/api/auth/")) return false;
  if (url.pathname.startsWith("/api/files/")) return false;
  if (API_CACHE_PATHS.includes(url.pathname)) return true;
  return url.pathname.startsWith("/api/playlist/");
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=") || size <= 0) return null;
  const rangeValue = rangeHeader.slice("bytes=".length).trim();
  if (!rangeValue || rangeValue.includes(",")) return null;
  const dashIndex = rangeValue.indexOf("-");
  if (dashIndex === -1) return null;
  const startValue = rangeValue.slice(0, dashIndex);
  const endValue = rangeValue.slice(dashIndex + 1);
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startValue);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  let end = endValue ? Number(endValue) : size - 1;
  if (!Number.isFinite(end) || end < 0) return null;
  if (end >= size) end = size - 1;
  if (end < start) return null;
  return { start, end };
}

async function cachedRangeResponse(request) {
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) return null;

  const cached = await caches.match(request.url);
  if (!cached || !cached.ok) return null;

  const blob = await cached.blob();
  const range = parseRangeHeader(rangeHeader, blob.size);
  if (!range) return null;

  const body = blob.slice(range.start, range.end + 1);
  const headers = new Headers(cached.headers);
  headers.set("accept-ranges", "bytes");
  headers.set("content-length", String(body.size));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${blob.size}`);
  headers.set("content-type", cached.headers.get("content-type") || "application/octet-stream");

  return new Response(body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

async function cacheMediaUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const cache = await caches.open(RUNTIME_CACHE);
  await Promise.all(
    urls.map(async (value) => {
      if (typeof value !== "string" || !value) return;
      if (/^(blob:|data:)/i.test(value)) return;
      try {
        const url = new URL(value, self.location.origin);
        if (url.origin !== self.location.origin) return;
        const request = new Request(url.toString(), {
          credentials: "include",
          cache: "reload",
        });
        const cached = await cache.match(url.toString());
        if (cached) return;
        const response = await fetch(request);
        await putCache(RUNTIME_CACHE, url.toString(), response);
      } catch {}
    }),
  );
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
    event.respondWith(cachedRangeResponse(request).then((response) => response || fetch(request)));
    return;
  }

  if (url.pathname.startsWith("/api/auth/")) {
    return;
  }

  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  if (isCacheableApiRequest(url)) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
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
    url.pathname.startsWith("/api/artwork/")
  ) {
    event.respondWith(staleWhileRevalidate(event, request, RUNTIME_CACHE));
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_MEDIA") return;
  event.waitUntil(cacheMediaUrls(event.data.urls));
});
