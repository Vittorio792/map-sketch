// sw.js
const VERSION = 'v1.2.0';
const APP_CACHE = `mapsketch-app-${VERSION}`;
const RUNTIME_CACHE = `mapsketch-runtime-${VERSION}`;
const SHELL = ['/index.html','/manifest.webmanifest'];

self.addEventListener('install', e=>{
  e.waitUntil((async()=>{
    const c = await caches.open(APP_CACHE);
    await c.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k===APP_CACHE||k===RUNTIME_CACHE)?null:caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);

  // Network-first for index.html (avoid stale app shell)
  if (url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    e.respondWith((async()=>{
      try {
        const res = await fetch(e.request, {cache:'no-store'});
        const c = await caches.open(APP_CACHE);
        c.put(e.request, res.clone());
        return res;
      } catch {
        const c = await caches.open(APP_CACHE);
        return (await c.match(e.request)) || Response.error();
      }
    })());
    return;
  }

  // Cache-first for other static assets
  if (/\.(css|js|png|jpg|svg|webp|ico|json)$/.test(url.pathname)) {
    e.respondWith((async()=>{
      const c = await caches.open(APP_CACHE);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    })());
    return;
  }

  // OSM tiles: stale-while-revalidate
  if (/tile\.openstreetmap\.org$/.test(url.host)) {
    e.respondWith((async()=>{
      const c = await caches.open(RUNTIME_CACHE);
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r=>{ if(r.ok) c.put(e.request, r.clone()); return r; }).catch(()=>hit);
      return hit ? Promise.race([net, hit]) : net;
    })());
  }
});
