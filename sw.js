// Offline shell. Same-origin only; this worker never contacts any other host.
const VERSION = 'ht-v0.3.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/fonts.css',
  './js/app.js', './js/db.js', './js/model.js', './js/crypto.js', './js/speech.js', './js/dom.js', './js/texts.js',
  './data/resources.json',
  './icons/logo.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './fonts/Rubik-400-hebrew.woff2', './fonts/Rubik-400-latin.woff2',
  './fonts/Rubik-500-hebrew.woff2', './fonts/Rubik-500-latin.woff2',
  './fonts/Rubik-700-hebrew.woff2', './fonts/Rubik-700-latin.woff2',
  './fonts/FrankRuhlLibre-700-hebrew.woff2', './fonts/FrankRuhlLibre-700-latin.woff2',
  './fonts/FrankRuhlLibre-900-hebrew.woff2', './fonts/FrankRuhlLibre-900-latin.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Help-resources list: stale-while-revalidate. The cached copy answers at once (a weak street
  // connection must never hold the screen); the network refresh lands in the cache for next time.
  // No cached copy yet: wait for the network at most 4 s.
  if (url.pathname.endsWith('/data/resources.json')) {
    const net = fetch(req).then(res => {
      if (!res.ok) return res;
      const copy = res.clone();
      return caches.open(VERSION).then(c => c.put('./data/resources.json', copy)).then(() => res, () => res);
    });
    e.waitUntil(net.then(() => {}, () => {}));
    e.respondWith(caches.match('./data/resources.json').then(hit => hit ||
      Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
        .catch(() => caches.match('./data/resources.json').then(c => c || Response.error()))));
    return;
  }

  // Everything else: cache first, then network; navigations fall back to the shell.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).catch(() => {
    if (req.mode === 'navigate') return caches.match('./index.html');
    return Response.error();
  })));
});
