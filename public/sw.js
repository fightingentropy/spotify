const CACHE_VERSION = "spotify-v48";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const APP_ASSETS_CACHE = "spotify-app-assets-v1";
const MEDIA_CACHE = "spotify-media-v1";
const PLAYBACK_CACHE = "spotify-playback-v1";
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, RUNTIME_CACHE, APP_ASSETS_CACHE, MEDIA_CACHE, PLAYBACK_CACHE]);
const CURRENT_CACHE_VERSION_NUMBER = Number(CACHE_VERSION.match(/spotify-v(\d+)/)?.[1] || 0);
const OFFLINE_PLAYBACK_SEARCH_PARAM = "spotify_offline";
const API_REFRESH_HEADER = "x-spotify-api-refresh";
const APP_CACHE_RETENTION_COUNT = 3;
const RUNTIME_CACHE_MAX_ENTRIES = 200;
const OFFLINE_ASSETS_MANIFEST_URL = "/offline-assets.json";

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
  "/savannah.jpg",
  "/favicon.ico",
  "/manifest.webmanifest",
];

const API_CACHE_PATHS = [
  "/api/home",
  "/api/search-index",
  "/api/library",
  "/api/liked",
  "/api/likes",
  "/api/music/source",
  "/api/songs",
];

function isCacheableResponse(response) {
  return response && response.ok && response.status !== 206 && response.type !== "opaqueredirect";
}

function offlineJsonResponse(message = "You're offline and this data has not been cached yet.") {
  return new Response(JSON.stringify({ error: message, offline: true }), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isKnownOffline() {
  return self.navigator && self.navigator.onLine === false;
}

function isRetainedVersionedAppCache(key) {
  const match = key.match(/^spotify-v(\d+)-(shell|static|runtime)$/);
  if (!match) return false;
  const version = Number(match[1]);
  if (!Number.isFinite(version) || !Number.isFinite(CURRENT_CACHE_VERSION_NUMBER)) return false;
  return version >= CURRENT_CACHE_VERSION_NUMBER - APP_CACHE_RETENTION_COUNT + 1;
}

async function pruneRuntimeCache(cache) {
  try {
    const keys = await cache.keys();
    const overflow = keys.length - RUNTIME_CACHE_MAX_ENTRIES;
    if (overflow <= 0) return;
    await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  } catch {}
}

async function putCache(cacheName, request, response) {
  if (!isCacheableResponse(response) || response.status === 206) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    if (cacheName.endsWith("-runtime")) await pruneRuntimeCache(cache);
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

async function cacheFirst(request, cacheName, fallbackResponse) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    await putCache(cacheName, request, response);
    return response;
  } catch {
    if (fallbackResponse) return fallbackResponse;
    throw new Error("network and cache miss");
  }
}

async function networkFirst(request, cacheName, fallbackResponse) {
  if (isKnownOffline()) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackResponse) return fallbackResponse;
  }

  try {
    const response = await fetch(request);
    await putCache(cacheName, request, response);
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackResponse) return fallbackResponse;
    throw new Error("network and cache miss");
  }
}

async function staleWhileRevalidate(event, request, cacheName, fallbackResponse) {
  const cached = await caches.match(request);
  if (isKnownOffline()) {
    if (cached) return cached;
    if (fallbackResponse) return fallbackResponse;
  }
  const refreshed = refreshCache(cacheName, request);
  event.waitUntil(refreshed.then(() => undefined));
  if (cached) {
    return cached;
  }

  const response = await refreshed;
  if (response) return response;
  if (fallbackResponse) return fallbackResponse;
  return fetch(request);
}

function precacheUrlsFromHtml(html) {
  const urls = new Set();
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/g;
  let match;
  while ((match = attributePattern.exec(html))) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin !== self.location.origin) continue;
      if (url.pathname.startsWith("/assets/")) urls.add(url.toString());
    } catch {}
  }
  return [...urls];
}

async function cacheStaticUrls(urls, options = {}) {
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) return;

  const results = await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const parsed = new URL(url, self.location.origin);
        if (parsed.origin !== self.location.origin) return true;
        const cached = await caches.match(parsed.toString());
        if (cached) return true;
        const response = await fetch(parsed.toString(), { cache: "reload" });
        await putCache(STATIC_CACHE, parsed.toString(), response);
        return isCacheableResponse(response);
      } catch {
        return false;
      }
    }),
  );
  if (options.required && results.some((cached) => !cached)) {
    throw new Error("Failed to cache app shell assets");
  }
}

async function cacheHtmlAssets(response, options = {}) {
  if (!response?.ok) return;
  const contentType = response.headers.get("content-type") || "";
  const html = await response.clone().text().catch(() => "");
  if (!contentType.includes("text/html") && !html.includes("/assets/")) return;
  const urls = precacheUrlsFromHtml(html);
  await cacheStaticUrls(urls, options);
}

async function cacheOfflineAssetsManifest(options = {}) {
  const response = await fetch(OFFLINE_ASSETS_MANIFEST_URL, { cache: "reload" });
  if (!response.ok) return false;
  await putCache(STATIC_CACHE, OFFLINE_ASSETS_MANIFEST_URL, response.clone());
  const payload = await response.json().catch(() => null);
  const files = Array.isArray(payload?.files)
    ? payload.files.filter((value) => typeof value === "string" && value.startsWith("/"))
    : [];
  if (files.length === 0) return false;
  await cacheStaticUrls(files, { required: options.required });
  return true;
}

async function cacheBuildAssets(response, options = {}) {
  const cachedManifest = await cacheOfflineAssetsManifest({ required: options.required }).catch((error) => {
    if (options.required) throw error;
    return false;
  });
  if (cachedManifest) {
    await cacheHtmlAssets(response).catch(() => undefined);
  } else {
    await cacheHtmlAssets(response, { required: options.required });
  }
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const response = await fetch("/", { cache: "reload" });
  await cacheBuildAssets(response.clone(), { required: true });
  await putCache(SHELL_CACHE, "/", response.clone());
  await Promise.all(
    SHELL_URLS
      .filter((url) => url !== "/")
      .map((url) => cache.add(url).catch(() => undefined)),
  );
}

function urlWithoutOfflinePlaybackParam(urlValue) {
  try {
    const url = new URL(urlValue, self.location.origin);
    if (!url.searchParams.has(OFFLINE_PLAYBACK_SEARCH_PARAM)) return null;
    url.searchParams.delete(OFFLINE_PLAYBACK_SEARCH_PARAM);
    return url.toString();
  } catch {
    return null;
  }
}

async function matchCachedMedia(urlValue) {
  const url = new URL(urlValue, self.location.origin);
  const exact = await caches.match(url.toString());
  if (exact) return exact;

  const originalMediaUrl = urlWithoutOfflinePlaybackParam(url.toString());
  if (originalMediaUrl) {
    const cachedOriginal = await caches.match(originalMediaUrl);
    if (cachedOriginal) return cachedOriginal;
  }

  if (!url.pathname.startsWith("/api/files/") && !url.pathname.startsWith("/api/artwork/")) {
    return null;
  }
  if (!url.search) return null;

  for (const cacheName of [MEDIA_CACHE, PLAYBACK_CACHE, RUNTIME_CACHE]) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    for (const request of requests) {
      try {
        const cachedUrl = new URL(request.url);
        if (cachedUrl.origin === url.origin && cachedUrl.pathname === url.pathname) {
          const matched = await cache.match(request);
          if (matched) return matched;
        }
      } catch {}
    }
  }

  return null;
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

  const cached = await matchCachedMedia(request.url);
  if (!cached || !cached.ok) return null;

  // Cache API blobs are disk-backed and sliced lazily, so serving ranges this
  // way stays cheap even for large hi-res audio files. Refusing to serve a
  // range here makes the media non-seekable in Safari/iOS, which breaks both
  // resume position and the seek controls while offline.
  const blob = await cached.blob();
  if (blob.size <= 0) return null;
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

async function cachedFullMediaResponse(request) {
  const cached = await matchCachedMedia(request.url);
  if (!cached || !cached.ok) return null;
  const headers = new Headers(cached.headers);
  headers.set("accept-ranges", "bytes");
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

async function rangeResponse(request) {
  const url = new URL(request.url);
  if (url.searchParams.get(OFFLINE_PLAYBACK_SEARCH_PARAM) === "1") {
    const cachedRange = await cachedRangeResponse(request);
    if (cachedRange) return cachedRange;
    const cachedFull = await cachedFullMediaResponse(request);
    if (cachedFull) return cachedFull;
  }

  try {
    return await fetch(request);
  } catch {
    const cached = await cachedRangeResponse(request);
    if (cached) return cached;
    const cachedFull = await cachedFullMediaResponse(request);
    if (cachedFull) return cachedFull;
    throw new Error("network and cached media miss");
  }
}

async function cacheMediaUrls(urls, cacheName = PLAYBACK_CACHE) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const cache = await caches.open(cacheName);
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
        await putCache(cacheName, url.toString(), response);
      } catch {}
    }),
  );
}

async function deleteMediaUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const mediaCaches = await Promise.all([caches.open(MEDIA_CACHE), caches.open(PLAYBACK_CACHE)]);
  await Promise.all(
    urls.flatMap((value) =>
      mediaCaches.map(async (cache) => {
        if (typeof value !== "string" || !value) return;
        try {
          const url = new URL(value, self.location.origin);
          await cache.delete(url.toString());
        } catch {}
      }),
    ),
  );
}

async function clearRuntimeCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.endsWith("-runtime")).map((key) => caches.delete(key)));
}

async function mediaResponse(request) {
  const url = new URL(request.url);
  if (url.searchParams.get(OFFLINE_PLAYBACK_SEARCH_PARAM) === "1") {
    const cached = await cachedFullMediaResponse(request);
    if (cached) return cached;
  }

  try {
    return await fetch(request);
  } catch {
    const cached = await cachedFullMediaResponse(request);
    if (cached) return cached;
    throw new Error("network and cached media miss");
  }
}

async function cachedNavigationResponse(cache, request) {
  return (
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match("/", { ignoreSearch: true })) ||
    (await caches.match(request, { ignoreSearch: true })) ||
    (await caches.match("/", { ignoreSearch: true }))
  );
}

function offlineNavigationResponse() {
  return new Response("<!doctype html><title>Spotify</title><body>Spotify is offline.</body>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 503,
  });
}

async function navigationResponse(event, request) {
  const cache = await caches.open(SHELL_CACHE);

  if (isKnownOffline()) {
    const cached = await cachedNavigationResponse(cache, request);
    if (cached) return cached;
    return offlineNavigationResponse();
  }

  try {
    const response = await fetch(request, { cache: "reload" });
    if (!response.ok) {
      const cached = await cachedNavigationResponse(cache, request);
      if (cached) return cached;
      return response;
    }
    event.waitUntil(cacheBuildAssets(response.clone()).catch(() => undefined));
    await putCache(SHELL_CACHE, request, response.clone());
    return response;
  } catch {
    const cached = await cachedNavigationResponse(cache, request);
    if (cached) return cached;
    return offlineNavigationResponse();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !CURRENT_CACHES.has(key) && !isRetainedVersionedAppCache(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
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
    event.respondWith(rangeResponse(request));
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
    const fallback = offlineJsonResponse();
    event.respondWith(
      request.headers.get(API_REFRESH_HEADER) === "1"
        ? networkFirst(request, RUNTIME_CACHE, fallback)
        : staleWhileRevalidate(event, request, RUNTIME_CACHE, fallback),
    );
    return;
  }

  if (url.pathname.startsWith("/api/files/")) {
    event.respondWith(mediaResponse(request));
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
  if (event.data?.type === "CACHE_MEDIA") {
    event.waitUntil(cacheMediaUrls(event.data.urls, event.data.cacheName));
    return;
  }
  if (event.data?.type === "DELETE_MEDIA") {
    event.waitUntil(deleteMediaUrls(event.data.urls));
    return;
  }
  if (event.data?.type === "CLEAR_PLAYBACK_CACHE") {
    event.waitUntil(caches.delete(PLAYBACK_CACHE));
    return;
  }
  if (event.data?.type === "CLEAR_RUNTIME_CACHE") {
    event.waitUntil(clearRuntimeCaches());
    return;
  }
  if (event.data?.type === "CACHE_APP_SHELL") {
    event.waitUntil(precacheShell());
  }
});
