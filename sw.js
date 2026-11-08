// Service worker del Diario delle calorie: fa funzionare l'app offline.
// Quando aggiorni i file dell'app, cambia VERSION: l'app mostrerà "È pronta una nuova versione".
const VERSION = "1.3.0";
const SHELL_CACHE = "diario-shell-" + VERSION;
const FONT_CACHE = "diario-fonts";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  // cache: "reload" scarica sempre i file nuovi, anche se il browser ne ha una copia vecchia
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("diario-shell-") && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Claude (AI): sempre dalla rete, mai in cache
  if (url.hostname === "api.anthropic.com") return;

  // caratteri tipografici: dalla cache, aggiornati in background
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") cache.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // pagine: l'app dalla cache (funziona offline)
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (await cache.match("./index.html")) || (await cache.match("./")) || fetch(req);
    })());
    return;
  }

  // altri file dell'app: cache, poi rete
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch (e) {
      return new Response("", { status: 504 });
    }
  })());
});
