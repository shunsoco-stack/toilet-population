/* Only the public app shell is cached. Firebase traffic and analytics are never cached. */
const CACHE = "toilet-population-shell-v1";
const FALLBACK = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([FALLBACK, "/icon.svg", "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("toilet-population-shell-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.assets)) return;
  const assets = event.data.assets.slice(0, 60).filter((value) => {
    if (typeof value !== "string") return false;
    try { const url = new URL(value); return url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"); } catch { return false; }
  });
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await Promise.allSettled(["/", ...assets].map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (response.ok) await cache.put(url, response);
    }));
  }));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/_vercel" || url.pathname.startsWith("/_vercel/") || url.pathname === "/sw.js") return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && url.pathname === "/") {
          try {
            const cache = await caches.open(CACHE);
            await cache.put("/", response.clone());
          } catch { /* A full or disabled cache must never hide a successful response. */ }
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return (url.pathname === "/" && await cache.match("/")) || await cache.match(FALLBACK) || Response.error();
      }
    })());
  } else if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === "/icon.svg") {
    event.respondWith((async () => {
      const cached = await caches.match(request).catch(() => undefined);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        try { const cache = await caches.open(CACHE); await cache.put(request, response.clone()); }
        catch { /* Cache storage is optional, including in private browsing. */ }
      }
      return response;
    })());
  }
});
