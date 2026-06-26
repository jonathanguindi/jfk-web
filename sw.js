/* Service Worker · Portal de ventas — Fase 1 (shell offline + instalable)
   Estrategia:
   - HTML/navegación: network-first (siempre traes la versión fresca si hay señal; si no, la última cacheada).
   - Estáticos propios + librerías CDN + fuentes: cache-first con actualización en segundo plano.
   - Supabase y Netlify Functions: NUNCA se cachean (datos dinámicos; lo offline lo manejan IndexedDB/cola en fases 2-3).
   Sube CACHE_VERSION en cada cambio del shell para forzar actualización. */
const CACHE_VERSION = 'jfk-portal-v41';
const SHELL = [
  '/vendedores.html',
  '/clientes.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/manifest-clientes.webmanifest',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/bcryptjs@2.4.3/dist/bcrypt.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.0/dist/jspdf.plugin.autotable.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_VERSION);
    // addAll falla si una falla; cacheamos una por una para tolerar CDN caídos.
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Borra versiones viejas del shell PERO conserva 'portal-img' (fotos offline),
    // para no re-descargar todas las imágenes en cada actualización.
    await Promise.all(keys.filter(k => k !== CACHE_VERSION && k !== 'portal-img').map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Fotos de productos en Supabase Storage: SÍ se cachean (para verlas offline).
function isProductImg(url) {
  return url.hostname.endsWith('.supabase.co') && url.pathname.indexOf('/storage/v1/object/public/productos') !== -1;
}
function isDynamic(url) {
  return (url.hostname.endsWith('.supabase.co') && !isProductImg(url)) ||
         url.pathname.startsWith('/.netlify/functions/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                  // POST/PUT van directo a la red
  const url = new URL(req.url);
  if (isDynamic(url)) return;                         // datos dinámicos: red directa (sin cache)

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // network-first: versión fresca si hay señal; si no, la cacheada.
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE_VERSION);
        c.put(req, fresh.clone());   // cachea cada página por su URL (vendedores Y clientes)
        return fresh;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match('/vendedores.html')) ||
               new Response('Sin conexión y sin copia guardada todavía.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // estáticos/CDN/fuentes: cache-first + refresco en segundo plano
  const prodImg = isProductImg(url);
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fetching = fetch(req).then(res => {
      // Para fotos de producto SOLO se cachean respuestas legibles (res.ok / CORS),
      // nunca opacas: una opaca no se puede usar en canvas y rompía el PDF.
      const cacheable = res && (res.ok || (res.type === 'opaque' && !prodImg));
      if (cacheable) {
        caches.open(CACHE_VERSION).then(c => c.put(req, res.clone()));
      }
      return res;
    }).catch(() => null);
    return cached || (await fetching) ||
           new Response('', { status: 504 });
  })());
});
