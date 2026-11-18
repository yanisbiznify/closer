// Service worker minimal : rend l'app installable et garde l'interface disponible hors ligne.
const CACHE = "biznify-v6";
const SHELL = ["/", "/app.css", "/app.js", "/login", "/brand/wordmark.svg", "/brand/icon-192.png", "/brand/mark.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/facture/")) return;
  // Réseau d'abord, cache en secours
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

// Notifications push (paiements, RDV, réponses…)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Biznify", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Biznify", {
    body: d.body || "", tag: d.tag, renotify: true, icon: "/brand/icon-192.png", badge: "/brand/favicon-32.png", data: { url: d.url || "/" }, vibrate: [30, 60, 30],
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url.startsWith(self.location.origin)) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
