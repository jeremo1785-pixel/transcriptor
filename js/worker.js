// Transcripcion en segundo plano (Web Worker): no congela la pantalla.
// Recibe el audio ya decodificado (mono a 16 kHz y a 22,05 kHz) y devuelve
// las notas, el pulso, el compas y la tonalidad.
import * as ort from "../vendor/ort/ort.all.min.mjs";
import { beatSpectrogram, estimateTuning, resampleLinear } from "./dsp.js";
import * as piano from "./piano.js";
import * as beats from "./beats.js";
import { detectKey, rhythmFrom } from "./analysis.js";

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
// Un solo hilo: dentro de un worker, el modo multihilo de WASM tiene que abrir
// sus propios sub-workers y en algunos navegadores se cuelga al crear el modelo
// (lo vimos en pruebas). La GPU (WebGPU) no lo necesita; es la via principal.
ort.env.wasm.numThreads = 1;

const MODELS = new URL("../models/", import.meta.url).href;
const sessions = {};
let backend = null;

async function fetchModel(name, onProgress) {
  // Primero el cache (queda guardado despues de la primera vez: funciona sin internet).
  const url = MODELS + name;
  const cache = await caches.open("transcriptor-modelos-v1");
  let res = await cache.match(url);
  if (!res) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`No se pudo bajar el modelo ${name} (${net.status})`);
    const total = +net.headers.get("content-length") || 0;
    const reader = net.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total && onProgress) onProgress(got / total);
    }
    const blob = new Blob(parts);
    await cache.put(url, new Response(blob, { headers: { "content-type": "application/octet-stream" } }));
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await res.arrayBuffer());
}

// El modelo de pulso da resultados equivocados en WebGPU (lo medimos: 262
// pulsos donde van 56; en el procesador coincide exacto con Python). Por eso va
// siempre por el procesador, que para este modelo alcanza y sobra.
const CPU_ONLY = new Set(["beats.onnx"]);

async function getSession(name, onProgress) {
  if (sessions[name]) return sessions[name];
  const bytes = await fetchModel(name, onProgress);
  // WebGPU (la GPU del iPad) y, si no esta disponible, el procesador.
  const tries = CPU_ONLY.has(name) ? ["wasm"] : forced ? [forced] : backend ? [backend] : ["webgpu", "wasm"];
  let lastErr;
  for (const ep of tries) {
    if (ep === "webgpu" && !("gpu" in navigator)) continue;
    try {
      log(`creando sesion ${name} con ${ep}`);
      let s = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
      log(`sesion ${name} lista (${ep})`);
      if (ep === "webgpu" && !forced) s = await verifyGpu(name, s, bytes);
      if (!CPU_ONLY.has(name)) backend = s.__ep || ep;
      sessions[name] = s;
      return s;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No se pudo cargar el modelo");
}

// Control de la GPU: el mismo tramo de prueba en la GPU y en el procesador
// tiene que dar lo mismo. Si no (algun navegador calcula mal alguna
// operacion), se usa el procesador: mas lento, pero correcto.
async function verifyGpu(name, gpu, bytes) {
  const n = 160000, x = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000) * ((i >> 12) % 2)
      + 0.2 * Math.sin((2 * Math.PI * 262 * i) / 16000) + 0.02 * (seed / 2147483647 - 0.5);
  }
  const feeds = { audio: new ort.Tensor("float32", x, [1, n]) };
  const cpu = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  const [a, b] = [await gpu.run(feeds), await cpu.run(feeds)];
  let diff = 0;
  for (const k of Object.keys(b)) {
    const u = a[k].data, v = b[k].data;
    for (let i = 0; i < v.length; i++) diff = Math.max(diff, Math.abs(u[i] - v[i]));
  }
  log(`control GPU ${name}: diferencia ${diff.toFixed(4)}`);
  if (diff > 0.02) {
    await gpu.release?.();
    cpu.__ep = "wasm";
    return cpu;
  }
  await cpu.release?.();
  return gpu;
}

const post = (type, extra) => self.postMessage({ type, ...extra });
const log = msg => post("log", { msg });
let forced = null;   // para pruebas: "wasm" o "webgpu"

async function runPiano(mono16, tuning, stage) {
  // Corregir la afinacion antes de transcribir: se remuestrea para llevar la
  // grabacion a La 440 y despues los tiempos se reescalan.
  let audio = mono16, factor = 1;
  if (Math.abs(tuning) >= 0.08) {
    factor = Math.pow(2, -tuning / 12);
    audio = resampleLinear(mono16, factor);
  }
  const sess = await getSession("piano_f32.onnx", p => stage("Bajando el modelo de piano (una sola vez)", p));
  const segs = piano.segments(audio);
  const outs = { onset: [], offset: [], frame: [], velocity: [] };
  for (let i = 0; i < segs.length; i++) {
    stage("Transcribiendo el piano", i / segs.length);
    const r = await sess.run({ audio: new ort.Tensor("float32", segs[i], [1, 160000]) });
    for (const k of Object.keys(outs)) outs[k].push(new Float32Array(r[k].data));
  }
  const merged = {};
  let frames = 0;
  for (const k of Object.keys(outs)) {
    const d = piano.deframe(outs[k]);
    merged[k] = d.data;
    frames = d.frames;
  }
  return piano.toNotes(merged, frames)
    .map(([s, e, p, v]) => [+(s * factor).toFixed(4), +(e * factor).toFixed(4), p, Math.max(1, Math.min(127, v))])
    .filter(([s, e]) => e - s >= 0.03);
}

async function runBeats(mono22, duration, stage) {
  try {
    const sess = await getSession("beats.onnx", p => stage("Bajando el modelo de pulso (una sola vez)", p));
    const fb = new Float32Array(await (await fetch(MODELS + "mel_22050_1024_128.f32")).arrayBuffer());
    stage("Detectando pulso y compás", 0);
    const spect = beatSpectrogram(mono22, fb, p => stage("Detectando pulso y compás", p * 0.5));
    const parts = beats.chunks(spect);
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      stage("Detectando pulso y compás", 0.5 + (0.5 * i) / parts.length);
      const r = await sess.run({ spect: new ort.Tensor("float32", parts[i].input, [1, 1500, 128]) });
      results.push({ start: parts[i].start, beat: r.beat.data, downbeat: r.downbeat.data });
    }
    const agg = beats.aggregate(results, spect.frames);
    const bt = beats.postprocess(agg.beat, agg.down);
    return rhythmFrom(bt.beats, bt.downbeats, duration);
  } catch (e) {
    console.warn("pulso:", e);
    return rhythmFrom([], [], duration);
  }
}

self.onmessage = async ev => {
  const { id, mono16, mono22, duration, mode } = ev.data;
  if (ev.data.backend) { forced = ev.data.backend; backend = null; }
  if (ev.data.threads) ort.env.wasm.numThreads = ev.data.threads;
  log(`hilos=${ort.env.wasm.numThreads} aislado=${self.crossOriginIsolated} gpu=${"gpu" in navigator}`);
  const t0 = performance.now();
  // Etapas con su peso en la barra de progreso.
  const plan = { tuning: [0, 0.03], piano: [0.03, 0.85], beats: [0.85, 0.99] };
  let cur = "tuning";
  const stage = (label, frac = 0) => {
    const key = /pulso/i.test(label) ? "beats" : /piano/i.test(label) ? "piano" : cur;
    cur = key;
    const [a, b] = plan[key];
    post("progress", { id, stage: label, progress: a + (b - a) * Math.min(1, frac) });
  };
  try {
    stage("Midiendo la afinación", 0);
    const tuning = ev.data.tuning ?? estimateTuning(mono22, 22050);
    if (mode !== "piano") throw new Error("En el iPad por ahora está el modo Piano solo.");
    const notes = await runPiano(mono16, tuning, stage);
    if (!notes.length) throw new Error("No se detectó ninguna nota. ¿El audio tiene música audible?");
    const rhythm = await runBeats(mono22, duration, stage);
    const tracks = [{ id: "piano", label: "Piano", color: "#4f8cff", program: 0, notes }];
    const key = detectKey(tracks);
    post("done", {
      id,
      data: {
        duration: +duration.toFixed(2), mode, tuning_cents: Math.round(tuning * 100),
        ...rhythm, rhythm_raw: rhythm, settings: { tempo_factor: 1, beats_per_bar: null },
        key, tracks,
      },
      backend, elapsed: Math.round((performance.now() - t0) / 1000),
    });
  } catch (e) {
    post("error", { id, error: String(e && e.message || e) });
  }
};
