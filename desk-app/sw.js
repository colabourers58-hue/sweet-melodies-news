/* Editor's Desk service worker: the app shell works offline; the queue is always
   fetched fresh when there is a connection, and the last copy is used when there isn't. */
const SHELL = "desk-shell-v1";
const FILES = ["./", "index.html", "app.js", "manifest.json", "logo.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== "desk-data").map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === "https://api.github.com") return;          // never cache the API
  const sameOrigin = url.origin === self.location.origin;
  // Queue and photos: network first, fall back to the last copy.
  if (sameOrigin && (url.pathname.endsWith("queue.json") || url.pathname.includes("/img/"))) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        if (r.ok) caches.open("desk-data").then((c) => c.put(url.pathname, copy));
        return r;
      }).catch(() => caches.open("desk-data").then((c) => c.match(url.pathname)).then((r) => r || Response.error()))
    );
    return;
  }
  // App shell and fonts: cache first, refresh in the background.
  if (sameOrigin || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request).then((r) => {
          if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
          return r;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
