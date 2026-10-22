// Service worker: cài app lên màn hình, mở được khi mất mạng (ôn tập, solo, tra cứu).
// Mã nguồn (html/js/css) lấy mạng trước để luôn là bản mới; dữ liệu câu hỏi và hình ảnh lấy cache trước.
const CACHE = 'gplx-v1';
const CORE = ['./', './index.html', './style.css', './game.js', './live.js', './study.js', './realtime.js',
  './config.js', './manifest.webmanifest', './data/questions_600_bca.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(CORE.map(u => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  const isAsset = /\/(images|data|icons)\//.test(url.pathname);
  if (isAsset) {
    // cache trước, cập nhật nền
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // mạng trước, rớt mạng thì dùng cache
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
});
