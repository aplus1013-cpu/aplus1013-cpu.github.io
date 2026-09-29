// 앱 화면 파일만 캐시해 빠르게 열고, 데이터(API)는 항상 서버에서 받음
const CACHE = "coach-v2";
const SHELL = ["./", "index.html", "app/styles.css", "app/main.js", "app/core.js", "app/api.js", "app/ui.js", "app/config.js", "app/media.js",
  "app/pages/upload.js", "app/pages/evaluation.js", "app/pages/employee.js", "app/pages/manager.js", "app/pages/admin.js", "app/pages/best.js", "app/pages/people-bulk.js", "app/pages/batch.js",
  "vendor/supabase.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 주소의 앱 파일: 네트워크 우선(새 버전 반영), 오프라인이면 캐시
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && SHELL.some((s) => u.pathname.endsWith(s.replace("./", "/")))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r ?? caches.match("index.html"))));
});
