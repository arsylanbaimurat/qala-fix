// Service worker: кэширует оболочку приложения, чтобы оно открывалось быстро и ставилось на экран.
// Данные (жалобы, фото) всегда берутся из сети.
const VERSION = "qala-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "vendor/leaflet.js", "vendor/leaflet.css", "vendor/supabase.js", "icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase, тайлы карты — мимо кэша
  // Сначала сеть, при отсутствии сети — кэш
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
