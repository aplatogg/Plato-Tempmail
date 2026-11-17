const CACHE = "haldgoff-mail-shell-v5";
const ASSETS = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.png",
  "/logo-mark.png",
  "/fonts/plex-sans-latin.woff2",
  "/fonts/plex-mono-400-latin.woff2",
  "/fonts/plex-mono-500-latin.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

// Network first so a deploy is visible on the next load; the cache is the
// offline fallback and is refreshed on every successful response.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then(
            (cached) => cached || (request.mode === "navigate" ? caches.match("/") : undefined),
          ),
      ),
  );
});
