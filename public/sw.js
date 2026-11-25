const CACHE = "plato-mail-shell-v6";
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

// ---------- Web Push ----------
// The page can only poll while a tab is open, so the device is reached through the
// push service instead. The service worker has no audio, so the notification uses
// the system sound; the app plays the chosen tone when it is opened.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Plato Mail";
  const body = typeof data.body === "string" && data.body ? data.body : "Pesan baru";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.inbox === "string" ? data.inbox : undefined,
      renotify: true,
      data: { inbox: data.inbox, from: data.from },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })(),
  );
});
