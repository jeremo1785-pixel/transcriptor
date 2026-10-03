// Service worker: guarda la app y los modelos en el iPad para que funcione
// sin internet despues de la primera vez.
const VERSION = "v7";
const SHELL = `transcriptor-app-${VERSION}`;
const MODELS = "transcriptor-modelos-v1";   // los modelos pesados, aparte: no se rebajan en cada version

const ASSETS = [
  "./", "index.html", "styles.css", "app.js", "manifest.json", "icon-192.png", "icon-512.png",
  "js/dsp.js", "js/piano.js", "js/beats.js", "js/analysis.js", "js/notation.js", "js/store.js", "js/worker.js",
  "vendor/opensheetmusicdisplay.min.js", "vendor/soundfont-player.min.js",
  "vendor/jspdf.umd.min.js", "pdfexport.js",
  "vendor/ort/ort.all.min.mjs", "vendor/ort/ort-wasm-simd-threaded.jsep.mjs", "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
  "vendor/sf/acoustic_grand_piano-mp3.js", "models/mel_22050_1024_128.f32",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== MODELS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    // Modelos: del cache propio si ya estan (los guarda el worker al bajarlos).
    if (url.pathname.includes("/models/") && url.pathname.endsWith(".onnx")) {
      const hit = await (await caches.open(MODELS)).match(e.request);
      if (hit) return hit;
      return fetch(e.request);
    }
    // Resto: red primero (para recibir actualizaciones) y cache si no hay conexion.
    try {
      const net = await fetch(e.request);
      if (net.ok) (await caches.open(SHELL)).put(e.request, net.clone());
      return net;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error("Sin conexión y sin copia guardada");
    }
  })());
});
