import { store } from "./js/store.js";
import { applyRhythm, assignHands } from "./js/analysis.js";
import { buildMusicXml, buildMidi } from "./js/notation.js";
import { importScore, silentWav } from "./js/scoreimport.js";

/* =====================================================================
   Utilidades
   ===================================================================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function slug(t) {
  return (t || "transcripcion").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 60).toLowerCase() || "transcripcion";
}

// En el iPad se abre el menu Compartir (Guardar en Archivos, MuseScore,
// AirDrop...); en la compu, una descarga comun.
async function saveFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && "ontouchend" in document) {
    await navigator.share({ files: [file], title: file.name });
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// Primer indice con arr[i][0] >= t (las notas estan ordenadas por inicio).
function lowerBound(arr, t, key = n => n[0]) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ---------------------------------------------------------------- nombres */
const SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const LATIN = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

function keyInfo(tonic, mode) {
  tonic = ((tonic % 12) + 12) % 12;
  const fifths = MAJOR_FIFTHS[mode === "major" ? tonic : (tonic + 3) % 12];
  return { tonic, mode, fifths };
}

function pcName(pc, fifths, latin) {
  const n = (fifths < 0 ? FLAT : SHARP)[((pc % 12) + 12) % 12];
  return latin ? LATIN[n[0]] + n.slice(1) : n;
}

function noteName(midi, fifths, latin, octave = false) {
  const base = pcName(midi, fifths, latin);
  return octave ? base + (Math.floor(midi / 12) - 1) : base;
}

/* =====================================================================
   Inicio: nueva transcripcion y biblioteca (todo queda en el iPad)
   ===================================================================== */
const MODES = [
  { id: "piano", label: "Piano solo", hint: "Grabaciones de piano o teclado. Se transcribe en el propio iPad." },
];
const MODE_LABEL = { piano: "Piano solo", melodia: "Melodía", banda: "Banda completa", partitura: "Partitura" };

const home = { src: "file", file: null, recBlob: null, recorder: null, modes: MODES };
const queue = { running: false, items: [], live: {} };

async function initHome() {
  $("#modes").innerHTML = MODES.map((m, i) => `
    <label class="mode">
      <input type="radio" name="mode" value="${m.id}" ${i === 0 ? "checked" : ""}>
      <div><b>${esc(m.label)}</b><span>${esc(m.hint)}</span></div>
    </label>`).join("");

  $$("#srcTabs button").forEach(b => b.onclick = () => {
    home.src = b.dataset.src;
    $$("#srcTabs button").forEach(x => x.classList.toggle("on", x === b));
    $$(".src-pane").forEach(p => (p.hidden = p.dataset.src !== home.src));
    syncHomeMode();
  });

  // Partituras: pestaña propia (y tambien se aceptan en «Archivo»).
  const sdrop = $("#dropScore"), sinput = $("#scoreInput");
  sinput.onchange = () => setScore(sinput.files[0]);
  sdrop.ondragover = e => { e.preventDefault(); sdrop.classList.add("over"); };
  sdrop.ondragleave = () => sdrop.classList.remove("over");
  sdrop.ondrop = e => {
    e.preventDefault();
    sdrop.classList.remove("over");
    if (e.dataTransfer.files[0]) setScore(e.dataTransfer.files[0]);
  };

  const drop = $("#drop"), input = $("#fileInput");
  // Sin filtro de tipo: en el iPad, filtrar por "audio/*" deja los mp3 de
  // Archivos en gris. Si el archivo no es audio, lo avisa al decodificarlo.
  input.onchange = () => setFile(input.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  };

  $("#recBtn").onclick = toggleRecording;
  $("#goBtn").onclick = submitNew;
  syncHomeMode();
  catalog.init();
  newSheet.init();
  backup.init();

  // Lo que quedo a medias (se cerro la app mientras procesaba) se retoma solo.
  for (const s of await store.list()) {
    if (s.status === "queued" || s.status === "working") enqueue(s.id);
  }
}

function setFile(f) {
  home.file = f || null;
  $("#fileName").textContent = f ? `✓ ${f.name}` : "";
  syncHomeMode();
}

const SCORE_RE = /\.(pdf|musicxml|xml|mxl|midi?)$/i;
const isScoreFile = f => !!f && SCORE_RE.test(f.name);

function setScore(f) {
  home.scoreFile = f || null;
  $("#scoreName").textContent = f ? `✓ ${f.name}` : "";
}

// Con una partitura no hay nada que elegir: se importa tal cual.
function syncHomeMode() {
  const score = home.src === "score" || (home.src === "file" && isScoreFile(home.file));
  $("#modesBox").hidden = score || home.modes.length < 2;   // solo piano: nada que elegir
  $("#goBtn").textContent = score ? "Importar partitura" : "Transcribir";
}

async function toggleRecording() {
  const btn = $("#recBtn");
  if (home.recorder) {
    home.recorder.stop();
    return;
  }
  let stream;
  setAudioMode(true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setAudioMode(false);
    toast("No se pudo usar el micrófono: " + e.message);
    return;
  }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  home.recorder = rec;
  const t0 = Date.now();
  const timer = setInterval(() => ($("#recTime").textContent = fmtTime((Date.now() - t0) / 1000)), 250);
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    clearInterval(timer);
    stream.getTracks().forEach(t => t.stop());
    home.recorder = null;
    setAudioMode(false);
    home.recBlob = new Blob(chunks, { type: rec.mimeType || "audio/mp4" });
    const prev = $("#recPreview");
    prev.src = URL.createObjectURL(home.recBlob);
    prev.hidden = false;
    btn.classList.remove("on");
    btn.textContent = "● Grabar de nuevo";
  };
  rec.start(500);
  btn.classList.add("on");
  btn.textContent = "■ Detener";
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------- importar de la PC
// La version de PC genera archivos .transcriptor con la transcripcion completa
// (cualquier modo: banda, melodia, piano; incluso de links de YouTube) y el audio.
const PACKAGE_MAGIC = "TRANSCRIPTOR1\n";

async function isPackage(file) {
  const head = new Uint8Array(await file.slice(0, PACKAGE_MAGIC.length).arrayBuffer());
  return new TextDecoder().decode(head) === PACKAGE_MAGIC;
}

async function importPackage(file) {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const start = PACKAGE_MAGIC.length;
  const len = view.getUint32(start);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start + 4, len)));
  if (meta.version !== 1 || !meta.data?.tracks) throw new Error("El archivo no es un paquete válido de la PC");
  const audio = new Blob([new Uint8Array(buf, start + 4 + len)], { type: meta.audio_type || "audio/mpeg" });
  const d = meta.data;
  const id = newId();
  d.title = meta.title;
  await store.putBlob(id + ":audio", audio);
  await store.putBlob(id + ":notes", d);
  await store.put({
    id, title: meta.title, mode: meta.mode, status: "ready", stage: "Listo", progress: 1,
    created: Date.now(), duration: d.duration, key: d.key?.label, bpm: d.bpm, imported: true,
    tracks: d.tracks.map(t => ({ id: t.id, label: t.label, count: t.notes.length })),
  });
  importPackage.lastId = id;
  return meta.title;
}

// Los PDF son una imagen de la partitura: para pasarlos a notas hace falta
// Audiveris, que esta en la PC. El iPad le manda el PDF a la PC por el Wi-Fi
// (tiene que estar abierto el Transcriptor de la PC) y se trae el resultado.
const PC_ADDR = "https://192.168.1.30:8443";
async function pdfViaPc(file) {
  let base = PC_ADDR;
  try { base = (localStorage.getItem("pcAddr") || PC_ADDR).replace(/\/$/, ""); } catch { /* nada */ }
  const say = t => { const el = $("#newMsg"); if (el) { el.className = "msg"; el.textContent = t; } };
  const call = async (path, opts = {}, ms = 8000) => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(base + path, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      return r;
    } finally { clearTimeout(tm); }
  };
  say("Buscando la PC…");
  let cfg;
  try { cfg = await (await call("/api/config")).json(); } catch {
    throw new Error(`Los PDF los lee tu PC. Abrí el Transcriptor de la PC («Transcriptor (iPad).bat»). `
      + `Si es la primera vez, abrí ${base} en Safari y aceptá el aviso; después volvé a elegir el PDF.`);
  }
  if (!cfg.pdf) throw new Error("La PC no tiene el lector de PDF (Audiveris).");
  say("Mandando el PDF a la PC…");
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("title", file.name.replace(/\.pdf$/i, ""));
  form.append("mode", "piano");
  const job = await (await call("/api/jobs/upload", { method: "POST", body: form }, 120000)).json();
  for (let i = 0; ; i++) {
    if (i > 480) throw new Error("La PC tardó demasiado en leer el PDF.");
    await new Promise(r => setTimeout(r, 1500));
    let j;
    try { j = await (await call(`/api/jobs/${job.id}`)).json(); } catch { continue; }
    if (j.status === "ready") break;
    if (j.status === "error") throw new Error("La PC no pudo leer el PDF: " + (j.error || ""));
    say(`La PC está leyendo el PDF… ${Math.round((j.progress || 0) * 100)}% (puede tardar un par de minutos)`);
  }
  say("Trayendo la partitura…");
  const blob = await (await call(`/api/jobs/${job.id}/package`, {}, 120000)).blob();
  const title = await importPackage(new File([blob], "pdf.transcriptor"));
  return { id: importPackage.lastId, title };
}

// Canciones mandadas desde la PC a GitHub (compartidas/): solo las notas,
// sin la grabacion. Aparecen en la biblioteca («Desde tu PC»); al tocar una
// se guarda en el iPad como cualquier partitura.
async function importShared(o) {
  const song = await (await fetch(`compartidas/${o.shared}.json`, { cache: "no-store" })).json();
  const d = song.data;
  const id = newId();
  d.title = song.title;
  await store.putBlob(id + ":audio", silentWav(d.duration));
  await store.putBlob(id + ":notes", d);
  await store.put({
    id, title: song.title, mode: song.mode, status: "ready", stage: "Listo", progress: 1,
    created: Date.now(), duration: d.duration, key: d.key?.label, bpm: d.bpm, imported: true,
    tracks: d.tracks.map(t => ({ id: t.id, label: t.label, count: t.notes.length })),
  });
  return id;
}

// Partitura (MusicXML o MIDI): las notas vienen escritas, se guarda directo.
// El audio es silencio del mismo largo, para que el reproductor funcione igual.
async function importScoreFile(file) {
  if (/\.pdf$/i.test(file.name)) return pdfViaPc(file);
  const d = await importScore(file);
  const id = newId();
  await store.putBlob(id + ":audio", silentWav(d.duration));
  await store.putBlob(id + ":notes", d);
  await store.put({
    id, title: d.title, mode: "partitura", status: "ready", stage: "Listo", progress: 1,
    created: Date.now(), duration: d.duration, key: d.key?.label, bpm: d.bpm,
    tracks: d.tracks.map(t => ({ id: t.id, label: t.label, count: t.notes.length })),
  });
  return { id, title: d.title };
}

async function submitNew() {
  const mode = ($("input[name=mode]:checked") || {}).value || "piano";
  const msg = $("#newMsg"), btn = $("#goBtn");
  msg.className = "msg";
  msg.textContent = "";
  btn.disabled = true;
  try {
    const scoreFile = home.src === "score" ? home.scoreFile : isScoreFile(home.file) ? home.file : null;
    if (home.src === "score" && !scoreFile) throw new Error("Elegí una partitura primero");
    if (scoreFile) {
      const t = await importScoreFile(scoreFile);
      setFile(null);
      setScore(null);
      $("#fileInput").value = $("#scoreInput").value = "";
      msg.textContent = `«${t.title}» importada. Ya está en la lista.`;
      refreshJobs();
      return;
    }
    let blob = home.file, title = "";
    if (home.src === "mic") {
      if (!home.recBlob) throw new Error("Grabá algo primero");
      const d = new Date();
      title = `Grabación ${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
      blob = home.recBlob;
    } else {
      if (!blob) throw new Error("Elegí un archivo primero");
      if (await isPackage(blob)) {
        const t = await importPackage(blob);
        setFile(null);
        $("#fileInput").value = "";
        msg.textContent = `«${t}» importada desde la PC. Ya está en la lista.`;
        refreshJobs();
        return;
      }
      title = blob.name.replace(/\.[^.]+$/, "");
    }
    const id = newId();
    await store.putBlob(id + ":audio", blob);
    await store.put({ id, title, mode, status: "queued", stage: "En cola", progress: 0,
      created: Date.now(), duration: 0 });
    setFile(null);
    $("#fileInput").value = "";
    msg.textContent = "¡Listo! Ya empezó a procesarse abajo. Dejá la app abierta hasta que termine.";
    enqueue(id);
    refreshJobs();
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- cola
function enqueue(id) {
  if (!queue.items.includes(id)) queue.items.push(id);
  runQueue();
}

async function runQueue() {
  if (queue.running) return;
  queue.running = true;
  let lock = null;
  try {
    // Que el iPad no apague la pantalla mientras transcribe (si se bloquea, se pausa).
    lock = await navigator.wakeLock?.request("screen").catch(() => null);
    while (queue.items.length) await transcribeSong(queue.items.shift());
  } finally {
    queue.running = false;
    lock?.release?.().catch(() => {});
  }
}

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker("js/worker.js", { type: "module" });
  return worker;
}

// Decodifica el audio (mp3, m4a, wav, video...) a mono en la frecuencia pedida.
async function decodeTo(buf, sr) {
  const probe = await new OfflineAudioContext(1, 1, sr).decodeAudioData(buf.slice(0));
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(probe.duration * sr)), sr);
  const src = ctx.createBufferSource();
  src.buffer = probe;
  src.connect(ctx.destination);
  src.start();
  return { mono: (await ctx.startRendering()).getChannelData(0), duration: probe.duration };
}

async function transcribeSong(id) {
  const song = await store.get(id);
  if (!song) return;
  const live = (stage, progress) => {
    queue.live[id] = { stage, progress };
    updateJobRow(id);
  };
  try {
    await store.update(id, { status: "working", stage: "Preparando el audio", progress: 0, error: null });
    live("Preparando el audio", 0);
    const blob = await store.getBlob(id + ":audio");
    if (!blob) throw new Error("No está el audio de esta canción");
    const buf = await blob.arrayBuffer();
    let a16, a22;
    try {
      a16 = await decodeTo(buf, 16000);
      a22 = await decodeTo(buf, 22050);
    } catch {
      throw new Error("No se pudo leer el audio. Probá con mp3, m4a o wav.");
    }
    await store.update(id, { duration: +a16.duration.toFixed(2) });
    const w = getWorker();
    const res = await new Promise((ok, bad) => {
      w.onmessage = e => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "progress") live(m.stage, m.progress);
        else if (m.type === "done") ok(m);
        else if (m.type === "error") bad(new Error(m.error));
      };
      w.onerror = e => { worker = null; bad(new Error("El procesamiento se cortó: " + (e.message || "sin memoria"))); };
      w.postMessage({ id, mono16: a16.mono, mono22: a22.mono, duration: a16.duration, mode: song.mode },
        [a16.mono.buffer, a22.mono.buffer]);
    });
    const data = res.data;
    // Rehacer una cancion conserva los ajustes de tempo y compas.
    const prev = await store.getBlob(id + ":notes");
    if (prev?.settings) data.settings = prev.settings;
    data.title = song.title;
    await store.putBlob(id + ":notes", data);
    await store.update(id, {
      status: "ready", stage: "Listo", progress: 1, key: data.key.label, bpm: data.bpm,
      tracks: data.tracks.map(t => ({ id: t.id, label: t.label, count: t.notes.length })),
      elapsed: res.elapsed, backend: res.backend,
    });
  } catch (e) {
    console.error(e);
    await store.update(id, { status: "error", stage: "Error", error: e.message });
  }
  delete queue.live[id];
  refreshJobs();
}

// ---------------------------------------------------------------- lista
function jobMeta(j) {
  const meta = [(MODE_LABEL[j.mode] || j.mode) + (j.imported ? " · desde la PC" : "")];
  if (j.duration) meta.push(fmtTime(j.duration));
  if (j.status === "ready") {
    if (j.key) meta.push(j.key);
    if (j.bpm) meta.push(`${Math.round(j.bpm)} BPM`);
    (j.tracks || []).forEach(t => meta.push(`<span class="badge">${esc(t.label)} · ${t.count}</span>`));
  } else if (j.status === "queued" || j.status === "working") {
    const l = queue.live[j.id] || j;
    meta.push(`<b>${esc(l.stage)}</b> ${Math.round((l.progress || 0) * 100)}%`);
  }
  return meta.map(m => `<span>${m}</span>`).join("");
}

function updateJobRow(id) {
  const li = document.querySelector(`.job[data-id="${id}"]`);
  const l = queue.live[id];
  if (!li || !l) return;
  li.className = "job working";
  const meta = $(".job-meta", li);
  if (meta) meta.innerHTML = `<span>${esc(l.stage)}</span><span><b>${Math.round(l.progress * 100)}%</b></span>`;
  const bar = $(".bar i", li);
  if (bar) bar.style.width = Math.max(2, l.progress * 100) + "%";
}


/* =====================================================================
   Biblioteca: partituras libres ya cargadas (Mutopia, piano solo).
   Tocar una obra la agrega a «Mis canciones» y la abre para practicar.
   ===================================================================== */
const LEVELS = ["", "Fácil", "Media", "Difícil"];
const catalog = {
  items: null, level: 0, q: "", composer: "", kind: "", shown: 120,

  // Una sola carga aunque la pidan varios a la vez (inicio y explorar).
  load() { return this._p || (this._p = this._load()); },

  async _load() {
    try {
      this.items = await (await fetch("biblioteca/biblioteca.json")).json();
    } catch {
      this.items = [];
    }
    for (const o of this.items) o.kind = o.kind || "clasica";
    // Modernas (PDMX): solo existen en la PC; en el iPad no estan y no pasa nada.
    try {
      const r = await fetch("biblioteca/moderna.json");
      if (r.ok) {
        const mod = await r.json();
        for (const o of mod) o.kind = "moderna";
        this.items = mod.concat(this.items);
        $("#catKind").hidden = $("#catModNote").hidden = !mod.length;
      }
    } catch { /* sin modernas */ }
    // Latinas y argentinas (tango, folclore, bolero, rock nacional...), tambien de PDMX.
    try {
      const r = await fetch("biblioteca/latina.json");
      if (r.ok) {
        const lat = await r.json();
        for (const o of lat) o.kind = "latina";
        this.items = lat.concat(this.items);
        if (lat.length) $("#catKind").hidden = $("#catModNote").hidden = false;
      }
    } catch { /* sin latinas */ }
    await this.loadShared();
    $("#catCount").textContent = this.items.length ? `· ${this.items.length}` : "";
    const comps = [...new Set(this.items.map(o => o.composer))].sort((a, b) => a.localeCompare(b));
    $("#catComposer").innerHTML = `<option value="">Todos los compositores</option>` +
      comps.map(c => `<option>${esc(c)}</option>`).join("");
  },

  // Mandadas desde la PC (solo existen en la version de GitHub). Se vuelven a
  // buscar al volver a la app o al inicio: puede haber llegado una nueva.
  async loadShared() {
    let pc = [];
    try {
      const r = await fetch("compartidas/index.json", { cache: "no-store" });
      if (!r.ok) return false;
      pc = (await r.json()).map(x => ({ id: `pc-${x.id}-${x.sent}`, shared: x.id, sent: x.sent, kind: "pc",
        title: x.title, composer: "Desde tu PC", dur: x.duration || 0, level: 0, key: "", opus: "", style: "" }));
    } catch { return false; }
    const old = (this.items || []).filter(o => o.kind === "pc").map(o => o.id).join();
    if (old === pc.map(o => o.id).join()) return false;
    this.items = pc.concat((this.items || []).filter(o => o.kind !== "pc"));
    return true;
  },

  async refreshShared() {
    if (!this.items) return;
    if (!(await this.loadShared())) return;
    $("#catCount").textContent = `· ${this.items.length}`;
    if (!$("#libHome").hidden) shelves.render();
    if (!$("#libCat").hidden) this.render();
  },

  added() {
    try { return JSON.parse(localStorage.getItem("catAdded") || "{}"); } catch { return {}; }
  },

  render() {
    if (!this.items) return;
    const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const words = norm(this.q).split(/\s+/).filter(Boolean);
    const list = this.items.filter(o =>
      (!this.level || o.level === this.level) && (!this.composer || o.composer === this.composer) &&
      (!this.kind || o.kind === this.kind) &&
      words.every(w => norm(`${o.title} ${o.composer} ${o.opus} ${o.style}`).includes(w)));
    const added = this.added();
    const ul = $("#catList");
    if (!this.items.length) {
      ul.innerHTML = `<li class="cat-more">No se pudo cargar la biblioteca.</li>`;
      return;
    }
    progress.refreshMap();
    // Sin buscar nada, primero las mas conocidas.
    if (!words.length) list.sort((a, b) => popularity(b) - popularity(a));
    void added;
    ul.innerHTML = list.slice(0, this.shown).map(songCard).join("") + (list.length > this.shown
      ? `<li class="cat-more">… y ${list.length - this.shown} más. Buscá por nombre o elegí un compositor.</li>`
      : list.length ? "" : `<li class="cat-more">No hay obras con ese filtro.</li>`);
    this.bindCards(ul);
  },

  bindCards(root) {
    $$(".song-card[data-id]", root).forEach(b => (b.onclick = () => this.open(this.items.find(o => o.id === b.dataset.id), b)));
  },

  setFilter(kind, level) {
    this.kind = kind; this.level = level; this.q = ""; this.composer = "";
    $("#catSearch").value = ""; $("#catComposer").value = "";
    $$("#catKind button").forEach(x => x.classList.toggle("on", x.dataset.k === kind));
    $$("#catLevel button").forEach(x => x.classList.toggle("on", +x.dataset.l === level));
  },

  // Agrega la obra a «Mis canciones» (si no estaba) y la abre.
  async open(o, btn) {
    const added = this.added();
    if (added[o.id] && home.songIds && home.songIds.has(added[o.id])) {
      location.hash = `#/cancion/${added[o.id]}`;
      return;
    }
    btn.disabled = true;
    btn.classList.add("busy");
    try {
      let id;
      if (o.kind === "pc") id = await importShared(o);
      else {
        const blob = await (await fetch("biblioteca/" + o.file)).blob();
        const name = `${o.composer} - ${o.title}`.replace(/[\\/:*?"<>|]+/g, " ").trim();
        id = await addCatalogSong(new File([blob], name + ".mid", { type: "audio/midi" }), name);
      }
      added[o.id] = id;
      try { localStorage.setItem("catAdded", JSON.stringify(added)); } catch { /* nada */ }
      location.hash = `#/cancion/${id}`;
    } catch (e) {
      toast("No se pudo agregar: " + e.message);
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  },

  init() {
    $$("#libTabs button").forEach(b => (b.onclick = () => libTab(b.dataset.lib)));
    let last = "home";
    try { last = localStorage.getItem("libTab") || "home"; } catch { /* nada */ }
    libTab(["home", "mine", "cat"].includes(last) ? last : "home");
    $("#mineAll").onclick = () => libTab("mine");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !$("#home").hidden) this.refreshShared();
    });
    let t;
    $("#catSearch").oninput = e => { clearTimeout(t); t = setTimeout(() => { this.q = e.target.value; this.shown = 120; this.render(); }, 150); };
    $$("#catLevel button").forEach(b => (b.onclick = () => {
      $$("#catLevel button").forEach(x => x.classList.toggle("on", x === b));
      this.level = +b.dataset.l;
      this.render();
    }));
    $("#catComposer").onchange = e => { this.composer = e.target.value; this.render(); };
    $$("#catKind button").forEach(b => (b.onclick = () => {
      $$("#catKind button").forEach(x => x.classList.toggle("on", x === b));
      this.kind = b.dataset.k;
      this.render();
    }));
    this.load();
  },
};

// iPad: se lee en el navegador, como cualquier MIDI.
async function addCatalogSong(file) {
  return (await importScoreFile(file)).id;
}

/* =====================================================================
   Inicio: estantes como en las apps de piano (populares, para empezar,
   clásicos...) con portadas. Las portadas se dibujan aca mismo (colores y
   notas segun el nombre): no hay que bajar imagenes y andan sin internet.
   ===================================================================== */
/* =====================================================================
   Progreso: mejor puntaje de cada cancion, dias practicados (racha) y
   favoritas. Queda guardado en este aparato.
   ===================================================================== */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const progress = {
  data: null,
  load() {
    if (!this.data) {
      let v = null;
      try { v = JSON.parse(localStorage.getItem("progress") || "null"); } catch { /* nada */ }
      this.data = Object.assign({ songs: {}, days: [], fav: [] }, v || {});
      // Los puntajes de antes (hasta el 25/10/2026) se guardaban tambien de
      // partes sueltas y sin saber con que manos o velocidad: quedan como
      // «anteriores», no como el mejor de la cancion.
      for (const s of Object.values(this.data.songs)) {
        if (!s.v) { if (s.best != null) s.old = s.best; delete s.best; s.v = 2; }
      }
    }
    return this.data;
  },
  save() {
    try { localStorage.setItem("progress", JSON.stringify(this.data)); } catch {
      if (!this.warned) {
        this.warned = true;
        toast("No se pudo guardar tu progreso en este aparato (¿navegación privada o sin espacio?).", 8000);
      }
    }
  },
  song(songId) { const D = this.load(); return D.songs[songId] || (D.songs[songId] = { plays: 0, v: 2 }); },
  // Practicaste (cuenta para la racha y para «seguí practicando»; no es puntaje).
  practiced(songId) {
    const D = this.load(), s = this.song(songId);
    s.plays++;
    s.last = Date.now();
    const t = dayKey(new Date());
    if (!D.days.includes(t)) D.days.push(t);
    if (D.days.length > 400) D.days = D.days.slice(-400);
    this.save();
    this.syncHead();
  },
  // r = { full: tocaste la cancion entera, acc: % de precision, cover: % de notas tocadas, ctx }.
  // Solo una cancion completa puede ser «tu mejor»; con que manos, nivel, velocidad y fuente.
  record(songId, r) {
    this.practiced(songId);
    if (!r.full) return;
    const s = this.song(songId);
    if (s.best == null || r.acc > s.best) { s.best = r.acc; s.bestCtx = r.ctx; s.bestAt = Date.now(); }
    this.save();
  },
  best(songId) { const s = this.load().songs[songId]; return s && s.best != null ? s.best : null; },
  oldBest(songId) { return this.load().songs[songId]?.old ?? null; },
  // Donde quedaste: posicion, manos, niveles, velocidad, vista y etapa de «Aprender».
  setResume(songId, data) { this.song(songId).resume = data; this.save(); },
  resume(songId) { return this.load().songs[songId]?.resume || null; },
  last(songId) { return this.load().songs[songId]?.last || 0; },
  // Dias seguidos practicando (si hoy todavia no, cuenta hasta ayer).
  streak() {
    const days = new Set(this.load().days), d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  },
  isFav(id) { return this.load().fav.includes(id); },
  toggleFav(id) {
    const D = this.load();
    D.fav = D.fav.includes(id) ? D.fav.filter(x => x !== id) : [id, ...D.fav];
    this.save();
    return D.fav.includes(id);
  },
  // Puntaje de una obra de la biblioteca (por la cancion que se agrego de ella).
  refreshMap() { this._map = catalog.added(); },
  catBest(catId) { const sid = (this._map || {})[catId]; return sid ? this.best(sid) : null; },
  syncHead() {
    const el = $("#streak");
    if (!el) return;
    const n = this.streak();
    el.hidden = !n;
    el.innerHTML = n === 1 ? `🔥 Practicaste <b>hoy</b>: ¡seguí mañana!` : `🔥 <b>${n}</b> días seguidos practicando`;
  },
};

// Clasicas mas conocidas, de la mas a la menos (parte del id de Mutopia).
const FAMOUS = ["fur_elise_woo59", "bergamesq_clair", "satiee-gymnopedie_1", "chopin_nocturne_op9_n2",
  "joplins-entertainer", "wtk1-prelude1", "rondoallaturca", "kv545-k545-1", "chopin_valse_op64_no1",
  "blue_danube", "debussy_arabesque_1", "joplins-maple", "gnossienne-no_1", "anna-magdalena-04",
  "fantaisie-impromptu", "roi_de_la_montagne", "pathetique-2", "bach-invention-01", "chop-28-4-chop",
  "lamortdase", "liszt-consolation-no3", "bizetg-prelude", "gymnopedie_2", "gymnopedie_3",
  "op68-02-marche", "kv397-fantasia", "bwvanh131-air", "muller-siciliano", "k545-2", "gnossienne-no_2",
  "debussy_arabesque_2", "chop-28-20", "woodensoldiers", "chop-28-6", "morningprayer", "bwv1006a_3",
  "chopin_nocturne_op9_n3", "nocturne_in_e_minor", "kv331_1_1_tema", "op68-09"];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Portadas sobrias (formas y colores apagados, sin texto encima: el titulo va
// abajo). Siempre la misma para cada cancion. Se dibujan aca: sin bajar imagenes.
const COVER_SETS = [
  ["#efe6d3", "#1d2b45", "#c8553d"], ["#1d2b45", "#efe6d3", "#d9a441"], ["#15161a", "#efe6d3", "#3a6ea5"],
  ["#c8553d", "#efe6d3", "#1d2b45"], ["#2f4a3e", "#e8dcc2", "#d9a441"], ["#e8dcc2", "#15161a", "#3a6ea5"],
  ["#3a6ea5", "#efe6d3", "#15161a"], ["#d9a441", "#15161a", "#efe6d3"], ["#283044", "#e8dcc2", "#c8553d"],
];

function coverArt(id) {
  let r = hashStr(id || "x");
  const rnd = () => ((r = Math.imul(r ^ (r >>> 15), 2246822507) >>> 0) % 1000) / 1000;
  const [bg, a, b] = COVER_SETS[r % COVER_SETS.length];
  const kind = Math.floor(rnd() * 6), x = 22 + rnd() * 56, y = 22 + rnd() * 26, s = 12 + rnd() * 10;
  let shapes;
  if (kind === 0) {          // sol sobre lomas
    shapes = `<circle cx="${x}" cy="${y}" r="${s}" fill="${b}"/>
      <path d="M0 ${70 + rnd() * 8} Q 30 ${52 + rnd() * 10} 60 ${66 + rnd() * 6} T 100 ${60 + rnd() * 8} V100 H0 Z" fill="${a}"/>`;
  } else if (kind === 1) {   // media luna grande y una linea
    shapes = `<circle cx="${rnd() < 0.5 ? 100 : 0}" cy="55" r="${40 + rnd() * 12}" fill="${a}"/>
      <circle cx="${x}" cy="${y}" r="${s * 0.7}" fill="${b}"/>
      <path d="M${10 + rnd() * 20} 100 C 30 60 50 50 ${60 + rnd() * 30} 0" stroke="${a}" stroke-width="1.6" fill="none"/>`;
  } else if (kind === 2) {   // arco
    const ax = 18 + rnd() * 30, w = 30 + rnd() * 14;
    shapes = `<path d="M${ax} 100 V${50 + rnd() * 10} A${w / 2} ${w / 2} 0 0 1 ${ax + w} ${50 + rnd() * 10} V100 Z" fill="${a}"/>
      <circle cx="${ax + w + 12}" cy="${y + 10}" r="${s * 0.6}" fill="${b}"/>`;
  } else if (kind === 3) {   // franjas y circulo
    shapes = `<rect x="16" y="0" width="5" height="100" fill="${a}"/><rect x="25" y="0" width="2.5" height="100" fill="${a}"/>
      <circle cx="${55 + rnd() * 20}" cy="${45 + rnd() * 20}" r="${24 + rnd() * 10}" fill="${b}"/>`;
  } else if (kind === 4) {   // luna sobre el agua
    shapes = `<circle cx="${x}" cy="${y + 4}" r="${s * 0.75}" fill="${a}"/>
      ${[0, 1, 2, 3].map(i => `<rect x="${x - 14 + i * 3}" y="${72 + i * 6}" width="${28 - i * 6}" height="1.6" fill="${a}" opacity="${0.9 - i * 0.2}"/>`).join("")}
      <rect x="0" y="66" width="100" height="34" fill="${b}" opacity=".35"/>`;
  } else {                   // hoja
    shapes = `<ellipse cx="${40 + rnd() * 20}" cy="58" rx="13" ry="34" transform="rotate(${-35 + rnd() * 70} 50 58)" fill="${a}"/>
      <circle cx="${x}" cy="${y}" r="${s * 0.55}" fill="${b}"/>`;
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="100" height="100" fill="${bg}"/>${shapes}</svg>`;
}

function coverHtml(o, opts = {}) {
  return `<div class="cover art">
      ${coverArt(o.id || o.title)}
      ${o.level ? `<span class="cv-lvl l${o.level}">${LEVELS[o.level]}</span>` : ""}
      ${opts.badge ? `<span class="cv-badge">${esc(opts.badge)}</span>` : ""}
      ${opts.score != null ? `<span class="cv-score">★ ${opts.score}%</span>` : ""}
      <span class="cv-play"><svg class="ic fill"><use href="#i-play"/></svg></span>
    </div>`;
}

// Titulo y autor de una cancion propia: de la biblioteca si vino de ahi (no se
// adivinan de un nombre como «Daisy Bell Song - Easy Piano Tutorial»).
function songInfo(j) {
  const added = catalog.added(), catId = Object.keys(added).find(k => added[k] === j.id);
  const o = catId && catalog.items && catalog.items.find(x => x.id === catId);
  return o ? { title: o.title, composer: o.composer, level: o.level } : { title: j.title, composer: "" };
}

// «Seguí practicando»: la ultima cancion con un punto guardado de verdad. Si
// todavia no practicaste nada, una facil y conocida para empezar (sin inventar progreso).
const hero = {
  render(list) {
    const box = $("#resumeCard");
    if (!box) return;
    const D = progress.load();
    const ready = (list || home.lastList || []).filter(j => j.status === "ready");
    const withRes = ready.filter(j => D.songs[j.id]?.resume).sort((a, b) => D.songs[b.id].resume.at - D.songs[a.id].resume.at);
    const j = withRes[0];
    if (j) {
      const r = D.songs[j.id].resume, info = songInfo(j);
      const hands = { derecha: "Mano derecha", izquierda: "Mano izquierda", ambas: "Las dos manos" }[r.hands] || "";
      const lv = r.levels || {}, LV = { 1: "fácil", 2: "media", 3: "difícil" };
      const lvl = r.hands === "derecha" ? LV[lv[1]] : r.hands === "izquierda" ? LV[lv[0]] : lv[0] === lv[1] ? LV[lv[0]] : "";
      $("#rcLabel").textContent = "Seguí practicando";
      $("#rcTitle").textContent = info.title;
      $("#rcComp").textContent = info.composer;
      $("#rcMeta").textContent = [hands, lvl ? `Nivel ${lvl}` : "", r.speed && r.speed < 1 ? `${Math.round(r.speed * 100)}% de velocidad` : "",
        r.learn ? `Aprender: parte ${r.learn.sec + 1}` : "", `quedaste en ${fmtTime(r.t || 0)}`].filter(Boolean).join(" · ");
      $("#rcCover").innerHTML = coverArt(j.id);
      $("#rcGo").lastChild.textContent = " Continuar práctica";
      $("#rcGo").onclick = () => {
        try { sessionStorage.setItem("resume", j.id); } catch { /* nada */ }
        location.hash = `#/cancion/${j.id}`;
      };
      $("#rcSee").hidden = false;
      $("#rcSee").onclick = () => (location.hash = `#/cancion/${j.id}`);
      box.hidden = false;
      return;
    }
    const o = catalog.items && catalog.items.filter(x => x.level === 1).sort((a, b) => popularity(b) - popularity(a))[0];
    if (!o) { box.hidden = true; return; }
    $("#rcLabel").textContent = "Para empezar";
    $("#rcTitle").textContent = o.title;
    $("#rcComp").textContent = o.composer;
    $("#rcMeta").textContent = `Nivel fácil · ${fmtTime(o.dur)}`;
    $("#rcCover").innerHTML = coverArt(o.id);
    $("#rcGo").lastChild.textContent = " Empezar";
    $("#rcGo").onclick = () => catalog.open(o, $("#rcGo"));
    $("#rcSee").hidden = true;
    box.hidden = false;
  },
};

// Al tocar «Continuar práctica»: la cancion se abre como la dejaste.
function applyResume() {
  const r = progress.resume(player.id);
  if (!r) return;
  intro.hide();
  if (r.levels) { player.levels = { ...player.levels, ...r.levels }; applyLevels(); }
  if (r.source) practice.source = r.source;
  if (r.learn) {
    learn.secs = learn.sections();
    learn.start(r.learn.sec, r.learn.stage);
    return;
  }
  applyHands(r.hands === "derecha" ? "1" : r.hands === "izquierda" ? "0" : "both");
  if (r.speed) setSpeed(r.speed);
  setView(r.view === "sheet" ? "sheet" : "roll");
  engine.seek(r.t || 0);
  practice.start();
}

function songCard(o) {
  return `<button class="song-card" data-id="${esc(o.id)}">
      ${coverHtml(o, { score: progress.catBest(o.id), badge: o.kind === "moderna" ? "Moderna" : o.kind === "latina" ? (o.style || "Latina") : o.kind === "pc" ? "Tuya" : "" })}
      <span class="sc-t">${esc(o.title)}</span>
      <span class="sc-m">${esc(o.composer)} · ${fmtTime(o.dur)}</span>
    </button>`;
}

// Que tan conocida es: las modernas por cuantas veces se vieron en MuseScore,
// las clasicas por la lista de arriba.
function popularity(o) {
  if (o.kind === "pc") return 1000 + o.sent / 1e10;      // las tuyas, primero
  if (o.kind === "moderna" || o.kind === "latina") return Math.log10((o.views || 0) + 10) * 10;
  const i = FAMOUS.findIndex(f => o.id.includes(f));
  return i < 0 ? 0 : 70 - i;
}

const shelves = {
  render() {
    progress.refreshMap();
    hero.render();
    const items = catalog.items || [];
    const box = $("#shelves");
    if (!box || !items.length) return;
    const byPop = [...items].sort((a, b) => popularity(b) - popularity(a));
    const mod = byPop.filter(o => o.kind === "moderna"), cla = byPop.filter(o => o.kind === "clasica" && popularity(o) > 0);
    // Populares: se intercalan las modernas mas vistas y las clasicas mas conocidas.
    const pop = [];
    for (let i = 0; pop.length < 16 && (i < mod.length || i < cla.length); i++) {
      if (mod[i]) pop.push(mod[i]);
      if (cla[i]) pop.push(cla[i]);
    }
    const easy = byPop.filter(o => o.level === 1).slice(0, 16);
    const pcs = items.filter(o => o.kind === "pc").sort((a, b) => b.sent - a.sent);
    const rows = [
      ...(pcs.length ? [["Desde tu PC", "Las que mandaste con el botón «iPad»", pcs.slice(0, 20), { kind: "pc" }]] : []),
      ["Populares", "Las que más se tocan", pop, { kind: "" }],
      ["Para empezar", "Fáciles y conocidas", easy, { level: 1 }],
      ["Clásicos imprescindibles", "Las obras que todos conocen", cla.slice(0, 16), { kind: "clasica" }],
    ];
    const lat = byPop.filter(o => o.kind === "latina");
    if (lat.length) {
      rows.push(["Latinas y argentinas", "Rock nacional, bolero, pop latino, cumbia…", lat.filter(o => !/Tango|Folclore/.test(o.style)).slice(0, 16), { kind: "latina" }]);
      const tf = lat.filter(o => /Tango|Folclore/.test(o.style));
      if (tf.length) rows.push(["Tango y folclore", "Piazzolla, Gardel, zambas, chacareras…", tf.slice(0, 16), { kind: "latina" }]);
    }
    if (mod.length) {
      rows.push(["Pop, películas y juegos", "Arreglos para piano", mod.filter(o => o.level <= 2).slice(0, 16), { kind: "moderna" }]);
    }
    rows.push(["Para desafiarte", "Nivel difícil", byPop.filter(o => o.level === 3).slice(0, 16), { level: 3 }]);
    box.innerHTML = rows.filter(r => r[2].length).map(([t, sub, list], i) => `
      <section class="shelf">
        <div class="shelf-head"><div><h3>${t}</h3><span>${sub}</span></div>
          <button class="link" data-row="${i}">Ver todo</button></div>
        <div class="shelf-row">${list.map(songCard).join("")}</div>
      </section>`).join("");
    $$(".shelf-head .link", box).forEach(b => (b.onclick = () => {
      const f = rows[+b.dataset.row][3];
      catalog.setFilter(f.kind ?? "", f.level ?? 0);
      libTab("cat");
    }));
    catalog.bindCards(box);
  },

  // «Seguí practicando»: las canciones propias listas, las ultimas primero.
  renderMine(list) {
    const box = $("#shelfMine");
    if (!box) return;
    // Las ultimas que practicaste primero.
    const when = j => progress.last(j.id) || j.created || 0;
    const all = list.filter(j => j.status === "ready").sort((a, b) => when(b) - when(a));
    home.lastList = list;
    const card = j => {
      const info = songInfo(j), best = progress.best(j.id);
      return `<button class="mini-card" data-song="${esc(j.id)}">
        <span class="mc-cover">${coverArt(j.id)}</span>
        <span class="mc-txt"><b>${esc(info.title)}</b><span>${esc(info.composer || (j.mode === "partitura" ? "Partitura" : "Transcripta"))}</span>
          <small>${j.duration ? fmtTime(j.duration) : ""}${best != null ? ` · ★ ${best}%` : ""}</small></span>
        <span class="mc-play"><svg class="ic fill"><use href="#i-play"/></svg></span>
      </button>`;
    };
    const fill = (el, items) => {
      el.hidden = !items.length;
      $(".shelf-row", el).innerHTML = items.map(card).join("");
      $$(".mini-card", el).forEach(b => (b.onclick = () => (location.hash = `#/cancion/${b.dataset.song}`)));
    };
    fill(box, all.slice(0, 6));
    hero.render(list);
    const fav = $("#shelfFav");
    if (fav) fill(fav, all.filter(j => progress.isFav(j.id)));
    progress.syncHead();
  },
};

function libTab(name) {
  $$("#libTabs button").forEach(x => x.classList.toggle("on", x.dataset.lib === name));
  $("#libHome").hidden = name !== "home";
  $("#libMine").hidden = name !== "mine";
  $("#libCat").hidden = name !== "cat";
  if (name === "cat") catalog.load().then(() => catalog.render());
  if (name === "home") catalog.load().then(() => shelves.render());
  try { localStorage.setItem("libTab", name); } catch { /* nada */ }
}

// «Agregar canción»: transcribir un audio, abrir una partitura o grabar, en
// una ventana aparte (antes ocupaba media pantalla de inicio).
const newSheet = {
  open() { $("#newModal").hidden = false; },
  close() { $("#newModal").hidden = true; },
  init() {
    $("#newBtn").onclick = () => this.open();
    $("#newClose").onclick = () => this.close();
    $("#newModal").addEventListener("pointerdown", e => { if (e.target.id === "newModal") this.close(); });
    // Al mandar algo: se cierra y se ve en «Mis canciones» (o se abre).
    $("#goBtn").addEventListener("click", () => {
      const before = $("#jobs").children.length, hash = location.hash;
      const t0 = Date.now();
      const watch = setInterval(() => {
        if (location.hash !== hash || $("#jobs").children.length > before) {
          clearInterval(watch);
          this.close();
          if (location.hash === hash) libTab("mine");
        } else if (Date.now() - t0 > 120000) clearInterval(watch);
      }, 300);
    });
  },
};

/* =====================================================================
   Copia de respaldo del progreso. El progreso vive en este aparato: mandar
   una cancion al iPad NO lleva el progreso. Con esto se guarda en un archivo
   y se recupera (en este aparato o en otro). Las canciones se reconocen por
   la obra de la biblioteca o por el nombre (el codigo interno cambia).
   ===================================================================== */
const backup = {
  PREFS: ["src", "latin", "fx", "fingers", "sheetNames", "chords", "easy"],
  isKey(k) { return k === "progress" || k.startsWith("learn:") || k.startsWith("lvl:") || this.PREFS.includes(k); },

  // Para reconocer cada cancion en otro aparato: titulo y obra de la biblioteca.
  songsMeta() {
    const added = catalog.added(), inv = {};
    for (const [cat, sid] of Object.entries(added)) inv[sid] = cat;
    const meta = {};
    for (const j of home.lastList || []) meta[j.id] = { title: j.title, cat: inv[j.id] || null };
    return meta;
  },

  build(data) {
    return { app: "transcriptor", kind: "progreso", v: 1, at: new Date().toISOString(), songs: this.songsMeta(), data };
  },

  async save() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (this.isKey(k)) data[k] = localStorage.getItem(k);
      }
    } catch { toast("No se pudo leer el progreso de este aparato."); return; }
    const out = this.build(data);
    const d = new Date(), name = `transcriptor-progreso-${dayKey(d)}.json`;
    const file = new File([JSON.stringify(out)], name, { type: "application/json" });
    if (typeof saveFile === "function") { try { await saveFile(file); } catch (e) { if (e.name !== "AbortError") toast(e.message); } return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Copia guardada: " + name, 5000);
  },

  async load(file) {
    let b;
    try { b = JSON.parse(await file.text()); } catch { toast("Ese archivo no es una copia del Transcriptor."); return; }
    if (!b || b.app !== "transcriptor" || b.kind !== "progreso" || typeof b.data !== "object") {
      toast("Ese archivo no es una copia de progreso del Transcriptor."); return;
    }
    if (!confirm("Esto reemplaza el progreso de este aparato por el de la copia (lo actual queda guardado por las dudas). ¿Seguir?")) return;
    // Codigo de cada cancion de la copia -> codigo de la misma cancion aca.
    const added = catalog.added(), mine = home.lastList || [], map = {};
    for (const [oldId, m] of Object.entries(b.songs || {})) {
      const byCat = m.cat && added[m.cat];
      const byTitle = mine.find(j => j.title === m.title);
      map[oldId] = byCat || (byTitle && byTitle.id) || oldId;
    }
    const remapKey = k => {
      const m = k.match(/^(learn|lvl):(.+)$/);
      return m && map[m[2]] ? `${m[1]}:${map[m[2]]}` : k;
    };
    try {
      // Lo de ahora, por si se arrepiente (se recupera con la consola o pidiendolo).
      const prev = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (this.isKey(k)) prev[k] = localStorage.getItem(k); }
      localStorage.setItem("progreso-anterior", JSON.stringify({ at: new Date().toISOString(), data: prev }));
      let n = 0, matched = 0;
      for (const [k, v] of Object.entries(b.data)) {
        if (!this.isKey(k) || typeof v !== "string") continue;
        if (k === "progress") {
          const p = JSON.parse(v);
          const songs = {};
          for (const [id, s] of Object.entries(p.songs || {})) { songs[map[id] || id] = s; if (map[id] && map[id] !== id) matched++; }
          p.songs = songs;
          p.fav = (p.fav || []).map(id => map[id] || id);
          localStorage.setItem("progress", JSON.stringify(p));
        } else localStorage.setItem(remapKey(k), v);
        n++;
      }
      progress.data = null;
      progress.syncHead();
      refreshJobs();
      toast(`Progreso recuperado (${n} datos${matched ? `, ${matched} ${matched === 1 ? "canción reconocida" : "canciones reconocidas"} en este aparato` : ""}).`, 7000);
    } catch (e) {
      toast("No se pudo recuperar: " + e.message);
    }
  },

  init() {
    $$("[data-backup=save]").forEach(b => (b.onclick = () => this.save()));
    $$("[data-backup=load]").forEach(b => (b.onclick = () => $("#backupInput").click()));
    $("#backupInput").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) this.load(f); };
  },
};

async function refreshJobs() {
  const list = await store.list();
  home.songIds = new Set(list.map(j => j.id));
  shelves.renderMine(list);
  const ul = $("#jobs");
  $("#emptyLib").hidden = list.length > 0;
  ul.innerHTML = list.map(j => {
    const busy = j.status === "queued" || j.status === "working";
    const l = queue.live[j.id] || j;
    return `
      <li class="job ${j.status}" data-id="${j.id}">
        <div class="job-title">${esc(j.title)}</div>
        <div class="job-actions">
          ${(j.status === "error" || j.status === "ready") && j.mode === "piano" ? `<button class="ghost retry" title="Volver a transcribir"><svg class="ic"><use href="#i-restart"/></svg></button>` : ""}
          <button class="icon del" title="Borrar"><svg class="ic"><use href="#i-x"/></svg></button>
        </div>
        <div class="job-meta">${jobMeta(j)}</div>
        ${busy ? `<div class="bar"><i style="width:${Math.max(2, (l.progress || 0) * 100)}%"></i></div>` : ""}
        ${j.status === "error" ? `<div class="err">${esc(j.error || "Error")}</div>` : ""}
      </li>`;
  }).join("");

  $$(".job", ul).forEach(li => {
    const id = li.dataset.id;
    li.onclick = e => {
      if (e.target.closest("button, select")) return;
      if (li.classList.contains("ready")) location.hash = `#/cancion/${id}`;
    };
    $(".del", li).onclick = async () => {
      if (queue.live[id]) { toast("Esperá a que termine de procesarse."); return; }
      if (!confirm("¿Borrar esta transcripción?")) return;
      queue.items = queue.items.filter(x => x !== id);
      await store.remove(id);
      refreshJobs();
    };
    const retry = $(".retry", li);
    if (retry) retry.onclick = async () => {
      await store.update(id, { status: "queued", stage: "En cola", progress: 0, error: null });
      enqueue(id);
      refreshJobs();
    };
  });
}

/* =====================================================================
   Motor de audio: original + notas sintetizadas + metronomo
   ===================================================================== */
const SF_FILES = {
  0: "acoustic_grand_piano", 33: "electric_bass_finger", 25: "acoustic_guitar_nylon",
  48: "string_ensemble_1", 73: "flute", 53: "voice_oohs",
};

/* =====================================================================
   Piano de verdad: muestras del Salamander Grand Piano (Yamaha C5, Alexander
   Holm, CC BY 3.0), en 4 intensidades y cada tercera menor; las notas del medio
   se afinan desde la muestra mas cercana. Con caida natural al soltar la
   tecla, ubicacion estereo segun la altura y el eco de una sala.
   Mientras carga (o si no carga) suena el piano anterior (soundfont).
   ===================================================================== */
// En el iPad, solo las 2 intensidades del medio: las 4 ocupan 127 MB de memoria
// (medido) y el iPad tambien necesita memoria para transcribir.
const PIANO_LAYERS = [8, 12];
const PIANO_NAMES = { 9: "A", 0: "C", 3: "Ds", 6: "Fs" };
const PIANO_SAMPLES = [];
for (let m = 21; m <= 108; m++) if (m % 12 in PIANO_NAMES) PIANO_SAMPLES.push(m);

const piano = {
  buffers: {}, layersReady: new Set(), loading: false, bus: null, held: new Map(),

  file(m, v) { return `vendor/piano/${PIANO_NAMES[m % 12]}${Math.floor(m / 12) - 1}v${v}.mp3`; },

  // Sala: un eco corto y calido generado en el momento (ruido que se apaga).
  impulse(ctx) {
    const len = Math.floor(ctx.sampleRate * 2.2), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        lp += 0.35 * ((Math.random() * 2 - 1) - lp);        // ruido suavizado: sala calida
        d[i] = t < 0.012 ? 0 : lp * Math.exp(-t / 0.55);
      }
    }
    return buf;
  },

  nodes(ctx, dest) {
    if (this.bus) return this.bus;
    const bus = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), rev = ctx.createConvolver();
    rev.buffer = this.impulse(ctx);
    dry.gain.value = 1;
    wet.gain.value = 0.22;
    bus.connect(dry).connect(dest);
    bus.connect(rev).connect(wet).connect(dest);
    return (this.bus = bus);
  },

  // Donde empieza a sonar de verdad cada muestra (el mp3 trae unos ms de silencio).
  onset(buf) {
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < Math.min(d.length, 8000); i++) peak = Math.max(peak, Math.abs(d[i]));
    const th = peak * 0.05;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > th) return Math.max(0, i - 16) / buf.sampleRate;
    return 0;
  },

  async load(ctx) {
    if (this.loading) return;
    this.loading = true;
    ui.sfStatus("Cargando el piano…");
    for (const v of PIANO_LAYERS) {
      const todo = PIANO_SAMPLES.slice();
      const worker = async () => {
        while (todo.length) {
          const m = todo.shift();
          try {
            const ab = await (await fetch(this.file(m, v))).arrayBuffer();
            const buf = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
            this.buffers[`${m}v${v}`] = { buf, off: this.onset(buf) };
          } catch { /* esa muestra falla: se usa otra intensidad */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (PIANO_SAMPLES.every(m => this.buffers[`${m}v${v}`])) this.layersReady.add(v);
      if (this.layersReady.size === 1) ui.sfStatus("");
    }
    if (!this.layersReady.size) ui.sfStatus("No se pudo cargar el piano; uso el sonido simple.");
  },

  ready() { return this.layersReady.size > 0; },

  // Intensidad grabada mas cercana a la fuerza con que se toca la nota.
  layerFor(vel) {
    const want = vel < 42 ? 4 : vel < 72 ? 8 : vel < 100 ? 12 : 16;
    if (this.layersReady.has(want)) return want;
    return [...this.layersReady].sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
  },

  /**
   * Toca una nota. Devuelve un objeto con stop(t) (corte rapido, para pausas y
   * saltos). Si dur es null, suena hasta que se llame a release(t).
   */
  play(ctx, dest, pitch, when, dur, vel) {
    const v = this.layerFor(vel);
    let m0 = PIANO_SAMPLES[0];
    for (const m of PIANO_SAMPLES) if (Math.abs(m - pitch) < Math.abs(m0 - pitch)) m0 = m;
    const s = this.buffers[`${m0}v${v}`];
    if (!s) return null;
    const bus = this.nodes(ctx, dest);
    const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.buffer = s.buf;
    src.playbackRate.value = Math.pow(2, (pitch - m0) / 12);
    // Dentro de cada intensidad grabada, un poco mas fuerte o mas suave.
    const lo = { 4: 0, 8: 42, 12: 72, 16: 100 }[v], hi = { 4: 42, 8: 72, 12: 100, 16: 128 }[v];
    const amp = 0.68 * (0.75 + 0.5 * Math.min(1, Math.max(0, (vel - lo) / (hi - lo))));
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.004);
    src.connect(g);
    if (pan) { pan.pan.value = Math.max(-0.6, Math.min(0.6, (pitch - 64) / 50)); g.connect(pan).connect(bus); } else g.connect(bus);
    src.start(when, s.off);
    // Al soltar la tecla el apagador frena la cuerda: rapido en los agudos,
    // un poco mas lento en los graves (como un piano real).
    const tau = 0.06 + 0.1 * Math.max(0, (72 - pitch) / 48);
    const release = t => {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, tau);
      try { src.stop(t + tau * 8); } catch { /* ya se freno */ }
    };
    if (dur != null) release(when + dur);
    // Volver a tocar la misma tecla apaga la anterior.
    const prev = this.held.get(pitch);
    if (prev && prev.when <= when) prev.release(when);
    const voice = {
      when, release,
      stop: t => {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.02);
        try { src.stop(t + 0.15); } catch { /* ya se freno */ }
      },
    };
    this.held.set(pitch, voice);
    return voice;
  },
};

// iPad: el modo «playback» hace que suene aunque este en silencio, pero apaga
// el microfono. Mientras se usa el microfono (practica o grabar) hace falta
// «play-and-record», que tambien suena en silencio. Sin esto el microfono no
// andaba en el iPad (14/10/2026).
function setAudioMode(record) {
  try { if (navigator.audioSession) navigator.audioSession.type = record ? "play-and-record" : "playback"; } catch { /* no lo soporta */ }
}

const engine = {
  ctx: null, audio: null, origGain: null, synthGain: null, metroGain: null,
  playing: false, speed: 1, anchorCtx: 0, anchorMedia: 0,
  // media: el reloj sigue a la grabacion original (solo si se escucha). Si no,
  // el tiempo lo lleva el reloj del AudioContext: preciso y sin demoras. En el
  // iPad el reproductor de la grabacion tarda 0,1-0,3 s en arrancar y da su
  // posicion a saltos: con la practica (que frena y sigue en cada nota) y las
  // partituras (audio en silencio) las notas "saltaban" y no iba fluido.
  media: false, vt: 0,
  scheduledUntil: 0, voices: [], timer: null,
  instruments: {}, loading: {}, noise: null,

  init() {
    if (this.ctx) return;
    // En el iPad: que suene aunque este en modo silencio (es musica, no un aviso).
    setAudioMode(!!practice.mic);
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
    const src = this.ctx.createMediaElementSource(this.audio);
    const master = this.ctx.createDynamicsCompressor();
    master.threshold.value = -10;
    master.ratio.value = 6;
    master.connect(this.ctx.destination);
    this.origGain = this.ctx.createGain();
    this.synthGain = this.ctx.createGain();
    this.metroGain = this.ctx.createGain();
    src.connect(this.origGain).connect(master);
    this.synthGain.connect(master);
    this.metroGain.connect(master);
    piano.load(this.ctx);   // el piano de verdad se carga en segundo plano
    this.audio.addEventListener("ended", () => this.pause());
    // Ruido blanco para la bateria sintetizada.
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  },

  load(url) {
    this.init();
    this.pause();
    this.audio.src = url;
    this.anchorMedia = 0;
    this.vt = 0;
    this.scheduledUntil = 0;
  },

  // ¿Hace falta escuchar la grabacion original? (si no, no se usa su reloj)
  wantsMedia() {
    return !!(player.data && player.data.source !== "partitura" && this.origGain && this.origGain.gain.value > 0.001);
  },

  // Tiempo de la grabacion. El reloj del AudioContext es mucho mas fino que
  // audio.currentTime, asi que se interpola desde el ultimo punto de anclaje.
  time() {
    if (!this.audio) return 0;
    if (!this.playing) return this.vt;
    return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx) * this.speed;
  },

  anchor() {
    this.anchorCtx = this.ctx.currentTime;
    this.anchorMedia = this.audio.currentTime;
  },

  async play() {
    this.init();
    await this.ctx.resume();
    this.media = this.wantsMedia();
    if (this.media) {
      if (Math.abs(this.audio.currentTime - this.vt) > 0.05) this.audio.currentTime = this.vt;
      try { await this.audio.play(); } catch (e) { toast("No se pudo reproducir: " + e.message); return; }
      this.playing = true;
      this.anchor();
    } else {
      this.playing = true;
      this.anchorMedia = this.vt;
      this.anchorCtx = this.ctx.currentTime;
    }
    this.scheduledUntil = this.anchorMedia;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 25);
    ui.onPlayState(true);
  },

  pause() {
    if (!this.audio) return;
    if (this.playing) this.vt = this.time();
    this.audio.pause();
    this.playing = false;
    clearInterval(this.timer);
    this.stopVoices();
    ui.onPlayState(false);
  },

  toggle() { this.playing ? this.pause() : this.play(); },

  seek(t) {
    if (!this.audio) return;
    const dur = this.audio.duration || player.data?.duration || 0;
    t = Math.max(0, Math.min(dur - 0.05, t));
    this.stopVoices();
    this.vt = t;
    if (this.media || !this.playing) this.audio.currentTime = t;
    this.anchorCtx = this.ctx ? this.ctx.currentTime : 0;
    this.anchorMedia = t;
    this.scheduledUntil = t;
    practice.sync();
  },

  setSpeed(s) {
    this.speed = s;
    if (!this.audio) return;
    const t = this.time();
    if (!this.playing) this.vt = t;
    this.audio.playbackRate = s;
    this.stopVoices();
    this.anchorMedia = t;
    this.anchorCtx = this.ctx.currentTime;
    this.scheduledUntil = t;
  },

  setMix(v) {
    this.init();
    const m = v / 100;
    this.origGain.gain.value = Math.min(1, 2 * (1 - m));
    this.synthGain.gain.value = Math.min(1, 2 * m) * 0.9;
    // Si mientras suena se empieza (o se deja) de escuchar la grabacion, se
    // cambia de reloj sin cortar.
    if (this.playing && this.wantsMedia() !== this.media) {
      const t = this.time();
      this.media = !this.media;
      if (this.media) {
        this.audio.currentTime = t;
        this.audio.play().then(() => this.anchor()).catch(() => {});
      } else {
        this.audio.pause();
      }
      this.anchorMedia = t;
      this.anchorCtx = this.ctx.currentTime;
    }
  },

  stopVoices() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.voices) { try { v.stop(now); } catch { /* ya termino */ } }
    this.voices = [];
  },

  tick() {
    let now = this.time();
    if (this.media) {
      // Corrige la deriva contra la grabacion: de a poco (un salto de golpe se
      // ve como un tiron de las notas); de golpe solo si se fue lejos.
      const drift = this.audio.currentTime - now;
      if (!this.audio.seeking && !this.audio.paused) {
        if (Math.abs(drift) > 0.3) { this.anchor(); now = this.time(); }
        else if (Math.abs(drift) > 0.03) this.anchorMedia += drift * 0.1;
      }
    } else if (player.data && now >= player.data.duration) {
      this.pause();           // sin grabacion, nadie avisa que termino
      return;
    }
    const L = player.loop;
    if (L.a != null && L.b != null && now >= L.b) {
      if (learn.on && practice.on) learn.onEnd();
      else this.seek(L.a);
      return;
    }
    if (practice.check(now)) return;
    const horizon = now + (player.view === "sheet" ? 0.6 : 0.18) * this.speed;
    const from = this.scheduledUntil;
    if (horizon <= from) return;
    const base = this.ctx.currentTime;
    const at = t => base + Math.max(0, (t - now) / this.speed);

    for (const tr of player.tracks) {
      if (!player.audible(tr)) continue;
      if (practice.on && (tr.practice ? !practice.hearMine : !practice.accompanies(tr))) continue;
      const notes = tr.notes;
      for (let i = lowerBound(notes, from); i < notes.length && notes[i][0] < horizon; i++) {
        const [s, e, p, v] = notes[i];
        this.playNote(tr, p, at(s), Math.max(0.05, (e - s) / this.speed), v);
      }
    }
    if (player.metronome) {
      const beats = player.data.beats, downs = player.downSet;
      for (let i = lowerBound(beats, from, x => x); i < beats.length && beats[i] < horizon; i++) {
        this.click(at(beats[i]), downs.has(i));
      }
    }
    this.scheduledUntil = horizon;
    if (this.voices.length > 400) this.voices = this.voices.slice(-300);
  },

  instrumentFor(tr) {
    const prog = player.sound === "piano" ? 0 : tr.program;
    const name = SF_FILES[prog] || SF_FILES[0];
    if (this.instruments[name]) return this.instruments[name];
    if (!this.loading[name] && window.Soundfont) {
      this.loading[name] = true;
      ui.sfStatus(`Cargando sonido: ${name.replace(/_/g, " ")}…`);
      Soundfont.instrument(this.ctx, `vendor/sf/${name}-mp3.js`, { destination: this.synthGain })
        .then(inst => { this.instruments[name] = inst; ui.sfStatus(""); })
        .catch(() => ui.sfStatus("No se pudieron cargar los sonidos; uso un sintetizador simple."));
    }
    return null;
  },

  playNote(tr, pitch, when, dur, vel) {
    if (tr.id === "drums") return this.drum(pitch, when, vel);
    pitch += player.transpose;
    if (pitch < 12 || pitch > 120) return;
    // Lo que toca la app (acompañamiento): el microfono no lo tiene que
    // confundir con lo que tocás vos.
    const outs = this.outs || (this.outs = []);
    outs.push([pitch, when]);
    if (outs.length > 128) outs.splice(0, 64);
    // Piano: muestras del piano de cola (si ya cargaron).
    if ((player.sound === "piano" || (tr.program ?? 0) < 8) && piano.ready() && pitch >= 21 && pitch <= 108) {
      const voice = piano.play(this.ctx, this.synthGain, pitch, when, dur, vel);
      if (voice) { this.voices.push(voice); return; }
    }
    const gain = 0.25 + (vel / 127) * 0.9;
    const inst = this.instrumentFor(tr);
    if (inst) {
      const node = inst.play(pitch, when, { duration: dur + 0.05, gain });
      if (node) this.voices.push(node);
      return;
    }
    // Sintetizador de respaldo mientras cargan (o si no cargan) los sonidos.
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "triangle";
    o.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.18 * gain, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.06 * gain, when + Math.min(dur, 0.4));
    g.gain.linearRampToValueAtTime(0, when + dur + 0.08);
    o.connect(g).connect(this.synthGain);
    o.start(when);
    o.stop(when + dur + 0.1);
    this.voices.push(o);
  },

  // Lo que se toca en el teclado MIDI, para teclados sin sonido propio.
  playLive(pitch) {
    this.init();
    this.ctx.resume();
    this.stopLive(pitch);
    if (piano.ready()) {
      const voice = piano.play(this.ctx, this.synthGain, pitch, this.ctx.currentTime, null, 96);
      if (voice) { practice.live.set(pitch, voice); return; }
    }
    const inst = this.instrumentFor({ program: 0 });
    if (!inst) return;
    const node = inst.play(pitch, this.ctx.currentTime, { gain: 1.1, duration: 8 });
    if (node) practice.live.set(pitch, node);
  },

  stopLive(pitch) {
    const node = practice.live.get(pitch);
    // El piano nuevo se apaga como un piano (al soltar la tecla), no de golpe.
    if (node && node.release) node.release(this.ctx.currentTime);
    else if (node) { try { node.stop(this.ctx.currentTime + 0.05); } catch { /* ya termino */ } }
    practice.live.delete(pitch);
  },

  drum(pitch, when, vel) {
    const ctx = this.ctx, g = ctx.createGain(), amp = 0.2 + (vel / 127) * 0.6;
    g.connect(this.synthGain);
    if (pitch === 36) { // bombo
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(amp, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
      o.connect(g); o.start(when); o.stop(when + 0.3);
      this.voices.push(o);
      return;
    }
    const n = ctx.createBufferSource(), f = ctx.createBiquadFilter();
    n.buffer = this.noise;
    const hat = pitch === 42;
    f.type = hat ? "highpass" : "bandpass";
    f.frequency.value = hat ? 7000 : 1800;
    const len = hat ? 0.05 : 0.16;
    g.gain.setValueAtTime(amp * (hat ? 0.5 : 0.9), when);
    g.gain.exponentialRampToValueAtTime(0.001, when + len);
    n.connect(f).connect(g);
    n.start(when, Math.random() * 0.5); n.stop(when + len + 0.02);
    this.voices.push(n);
  },

  click(when, accent) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(accent ? 0.5 : 0.3, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g).connect(this.metroGain);
    o.start(when); o.stop(when + 0.06);
  },
};

/* =====================================================================
   Estado del reproductor
   ===================================================================== */
const player = {
  id: null, job: null, data: null, tracks: [],
  transpose: 0, sound: "piano", metronome: false, view: "roll",
  loop: { a: null, b: null, stage: 0 },
  downSet: new Set(),
  range: [21, 108],

  audible(tr) {
    const anySolo = this.tracks.some(t => t.solo);
    return anySolo ? tr.solo : !tr.mute;
  },

  // Ids del servidor (las dos manos del piano son la misma pista "piano").
  visibleIds() {
    return [...new Set(this.tracks.filter(t => t.visible && t.id !== "drums").map(t => t.id))];
  },

  allIds() {
    return [...new Set(this.tracks.filter(t => t.id !== "drums").map(t => t.id))];
  },

  // Segundos <-> posicion en pulsos, siguiendo los pulsos detectados.
  timeToBeat(t) {
    const b = this.data.beats, n = b.length;
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
    const i = lowerBound(b, t, x => x) - 1;
    return i + (t - b[i]) / (b[i + 1] - b[i]);
  },

  beatToTime(x) {
    const b = this.data.beats, n = b.length;
    if (x <= 0) return b[0] + x * (b[1] - b[0]);
    if (x >= n - 1) return b[n - 1] + (x - (n - 1)) * (b[n - 1] - b[n - 2]);
    const i = Math.floor(x);
    return b[i] + (x - i) * (b[i + 1] - b[i]);
  },

  // Mismo desplazamiento que usa el servidor al armar los compases.
  barShift() { return this.data.bar_shift || 0; },

  keyNow() {
    const k = this.data.key;
    return keyInfo(k.tonic + this.transpose, k.mode);
  },

  computeRange() {
    // Practicando: el piano entero (88 teclas), como el de verdad.
    if ($("#optFull").checked || (practice.on && focusMode.on)) { this.range = [21, 108]; return; }
    let lo = 127, hi = 0;
    for (const t of this.tracks) {
      if (!t.visible || t.id === "drums") continue;
      for (const n of t.notes) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); }
    }
    if (lo > hi) { lo = 48; hi = 84; }
    lo += this.transpose; hi += this.transpose;
    lo -= 2; hi += 2;
    while (hi - lo < 24) { lo--; hi++; }
    // Empieza y termina en tecla blanca.
    const black = p => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    if (black(lo)) lo--;
    if (black(hi)) hi++;
    this.range = [Math.max(12, lo), Math.min(120, hi)];
  },
};

async function openSong(id) {
  engine.pause();
  if (practice.on) practice.stop();
  player.id = id;
  $("#pTitle").textContent = "Cargando…";
  $("#pChips").innerHTML = "";
  const job = await store.get(id);
  const raw = await store.getBlob(id + ":notes");
  const audio = await store.getBlob(id + ":audio");
  if (!job || !raw || !audio) {
    toast("No se encontró esa canción");
    location.hash = "#/";
    return;
  }
  player.raw = raw;
  const data = songData(raw);
  player.job = job;
  player.transpose = 0;
  player.loop = { a: null, b: null, stage: 0 };
  $("#trVal").textContent = "0";
  $("#loopBtn").classList.remove("on");
  setData(data);
  player.tracks = buildTracks(data.tracks);
  loadLevels();
  applyLevels();
  renderTracks();
  syncHands();
  syncSpeed();
  player.computeRange();
  if (player.audioUrl) URL.revokeObjectURL(player.audioUrl);
  player.audioUrl = URL.createObjectURL(audio);
  engine.load(player.audioUrl);
  // Partitura importada: el audio es silencio, lo que suena son las notas.
  const fromScore = data.source === "partitura";
  $(".ctl.mix").hidden = fromScore;
  engine.setMix(fromScore ? 100 : +$("#mix").value);
  engine.setSpeed(+$("#speedSel").value);
  $("#tEnd").textContent = fmtTime(data.duration);
  sheet.invalidate();
  setView(player.view);
  intro.show();
  checkResume(id);
}

// ¿Se pidio «Continuar práctica» para esta cancion?
function checkResume(id) {
  let pend = null;
  try { pend = sessionStorage.getItem("resume"); sessionStorage.removeItem("resume"); } catch { /* nada */ }
  if (pend === id) applyResume();
}

// Datos listos para mostrar: ajustes de tempo aplicados y manos del piano.
function songData(raw) {
  const data = applyRhythm(raw);
  for (const t of data.tracks) if (t.id === "piano" && !t.hands) t.hands = assignHands(t.notes);
  return data;
}

// El piano se divide en dos pistas, una por mano, cada una con su color: asi se
// distinguen a simple vista y se pueden silenciar, ocultar o practicar por separado.
const HANDS = [
  { hand: 1, label: "Mano derecha", color: "#4f8cff" },
  { hand: 0, label: "Mano izquierda", color: "#ff8a3d" },
];

function buildTracks(tracks) {
  const out = [];
  const add = (t, extra) => out.push({
    ...t, ...extra, mute: false, solo: false, visible: true, practice: false,
    maxDur: extra.notes.reduce((m, n) => Math.max(m, n[1] - n[0]), 0),
  });
  for (const t of tracks) {
    if (t.id === "piano" && t.hands) {
      for (const h of HANDS) {
        const notes = t.notes.filter((_, i) => t.hands[i] === h.hand);
        if (notes.length) add(t, { key: `piano${h.hand}`, hand: h.hand, label: h.label, color: h.color, notes });
      }
    } else {
      add(t, { key: t.id, notes: t.notes });
    }
  }
  return out;
}

/* =====================================================================
   Niveles por mano, como en Artie: la misma cancion en Facil, Media y
   Dificil (la original). Se arman de las notas: en cada acorde se deja la
   nota de afuera (la melodia arriba en la derecha, el bajo en la izquierda).
   ===================================================================== */
const LEVEL_NAMES = ["", "Fácil", "Media", "Difícil"];

function simplifyHand(notes, hand, level) {
  if (level >= 3) return notes;
  const out = [];
  for (let i = 0; i < notes.length;) {
    let j = i;
    const group = [];
    while (j < notes.length && notes[j][0] - notes[i][0] < 0.06) group.push(notes[j++]);
    group.sort((a, b) => (hand === 1 ? b[2] - a[2] : a[2] - b[2]));   // la de afuera primero
    out.push(group[0]);
    // Media: acordes de hasta dos notas (la de afuera y la del otro extremo).
    if (level === 2 && group.length > 1) out.push(group[group.length - 1]);
    i = j;
  }
  out.sort((a, b) => a[0] - b[0]);
  if (level === 2 && hand === 1) return out;
  // Facil: la derecha, la melodia sin adornos ni notas mas rapidas que una
  // semicorchea; la izquierda, el bajo: una nota por pulso (en Media, cada
  // medio pulso). Los acordes de un mismo golpe se quedan juntos.
  const beat = 60 / (player.data?.bpm || 100);
  const gap = hand === 1 ? Math.max(0.15, beat * 0.2) : beat * (level === 2 ? 0.45 : 0.9);
  const easy = [];
  let last = -Infinity;
  for (const n of out) {
    if (n[0] - last >= gap) { easy.push(n); last = n[0]; }
    else if (n[0] - last < 0.06) easy.push(n);
  }
  return easy;
}

function loadLevels() {
  player.levels = { 0: 3, 1: 3 };
  try {
    const v = JSON.parse(localStorage.getItem("lvl:" + player.id) || "null");
    if (v && v[0] && v[1]) player.levels = v;
  } catch { /* nada */ }
}

function applyLevels() {
  for (const t of player.tracks) {
    if (t.hand == null) continue;
    t.allNotes = t.allNotes || t.notes;
    t.notes = simplifyHand(t.allNotes, t.hand, player.levels[t.hand] || 3);
    t.maxDur = t.notes.reduce((m, n) => Math.max(m, n[1] - n[0]), 0);
  }
  try { localStorage.setItem("lvl:" + player.id, JSON.stringify(player.levels)); } catch { /* nada */ }
  computeFingers();
  engine.stopVoices();
  engine.scheduledUntil = engine.time();
  if (practice.on) practice.build();
}

/* =====================================================================
   Ficha de la cancion (como en Artie): antes de practicar se elige que
   mano tocás y en que nivel, y un boton grande para empezar.
   ===================================================================== */
/* =====================================================================
   Aprender paso a paso (como los planetas de Artie): la cancion en partes
   de 4 compases; cada parte, primero cada mano lento, despues las dos
   juntas lento y al final a tempo. Se pasa de etapa con 90% de aciertos.
   ===================================================================== */
const learn = {
  on: false, sec: 0, stage: 0, secs: [], savedSpeed: null,

  stages() {
    const hands = player.tracks.filter(t => t.hand != null).map(t => t.hand);
    const S = [];
    if (hands.includes(1)) S.push({ hand: "1", speed: 0.7, name: "Mano derecha, lento", short: "Der." });
    if (hands.includes(0)) S.push({ hand: "0", speed: 0.7, name: "Mano izquierda, lento", short: "Izq." });
    S.push({ hand: "both", speed: 0.7, name: hands.length > 1 ? "Las dos manos, lento" : "Lento", short: hands.length > 1 ? "Juntas" : "Lento" });
    S.push({ hand: "both", speed: 1, name: "A tempo", short: "A tempo" });
    return S;
  },

  sections() {
    const d = player.data, db = d.downbeats && d.downbeats.length ? d.downbeats : [0];
    const has = (a, b) => player.tracks.some(t => t.id !== "drums" && (t.allNotes || t.notes).some(n => n[0] >= a && n[0] < b));
    const out = [];
    for (let i = 0; i < db.length; i += 4) {
      const a = db[i], b = i + 4 < db.length ? db[i + 4] : d.duration - 0.1;
      if (b - a < 0.5 || !has(a, b)) continue;
      out.push({ a, b, from: summary.barAt(a), to: summary.barAt(b - 0.01) });
    }
    return out;
  },

  load() { try { return JSON.parse(localStorage.getItem("learn:" + player.id) || "{}"); } catch { return {}; } },
  saveDone(i, n, skipped = false) {
    const s = this.load();
    s[i] = Math.max(s[i] || 0, n);
    if (skipped) (s.skipped || (s.skipped = {}))[`${i}:${n - 1}`] = true;
    try { localStorage.setItem("learn:" + player.id, JSON.stringify(s)); } catch { /* nada */ }
  },
  nextTodo() {
    const s = this.load(), n = this.stages().length;
    for (let i = 0; i < this.secs.length; i++) if ((s[i] || 0) < n) return [i, s[i] || 0];
    return [0, 0];
  },

  open() {
    this.secs = this.sections();
    const S = this.stages(), done = this.load();
    const [ni] = this.nextTodo();
    const total = this.secs.length * S.length;
    const ok = this.secs.reduce((m, _, i) => m + Math.min(S.length, done[i] || 0), 0);
    $("#lnSub").textContent = `${this.secs.length} partes · ${ok} de ${total} etapas hechas`;
    $("#lnPath").innerHTML = this.secs.map((sec, i) => {
      const n = Math.min(S.length, done[i] || 0);
      const cls = n >= S.length ? "done" : i === ni ? "cur" : "";
      return `<li class="ln-sec ${cls}" data-i="${i}">
        <span class="ln-dot">${n >= S.length ? "✓" : i + 1}</span>
        <div class="ln-txt"><b>Parte ${i + 1}</b><small>Compases ${sec.from}–${sec.to}</small></div>
        <div class="ln-stages">${S.map((st, k) => `<span class="${k < n ? "ok" : k === n && cls === "cur" ? "now" : ""}">${st.short}</span>`).join("")}</div>
      </li>`;
    }).join("");
    $$("#lnPath .ln-sec").forEach(li => (li.onclick = () => {
      const i = +li.dataset.i, n = Math.min(S.length - 1, done[i] || 0);
      this.start(i, (done[i] || 0) >= S.length ? 0 : n);
    }));
    const [i, st] = this.nextTodo();
    $("#lnGo").onclick = () => this.start(i, st);
    $("#lnGo").lastChild.textContent = ok ? " Seguir" : " Empezar";
    intro.hide();
    $("#learnPanel").hidden = false;
  },

  start(i, st) {
    const S = this.stages()[st], sec = this.secs[i];
    if (!S || !sec) return;
    $("#learnPanel").hidden = true;
    intro.hide();
    applyLevels();
    if (this.savedSpeed == null) this.savedSpeed = +$("#speedSel").value;
    this.on = true;
    this.sec = i;
    this.stage = st;
    applyHands(S.hand);
    setSpeed(S.speed);
    const L = player.loop;
    L.a = Math.max(0, sec.a - 0.3);
    L.b = sec.b;
    L.stage = 2;
    $("#loopBtn").classList.add("on");
    $("span", $("#loopBtn")).textContent = "Quitar bucle";
    if (player.view !== "roll") setView("roll");
    engine.pause();
    engine.seek(L.a);
    if (!practice.on) practice.start();
    practice.hits = practice.misses = 0;
    practice.finished = false;
    this.label(`Parte ${i + 1} de ${this.secs.length} · ${S.name}`);
    syncLoopBtn();
    ui.practiceStatus();
  },

  label(t) {
    $("#fLearn").textContent = t;
    $("#fLearn").hidden = !t;
    $("#poMsg").textContent = t;
  },

  // Llego al final de la parte: se mira como fue y se sigue (o se repite).
  onEnd() {
    const P = practice, tot = P.hits + P.misses, L = player.loop;
    // Notas de esta parte para la mano elegida: cuantas tocaste (cobertura) y
    // con cuantos errores (precision). Sin tocar nada no se aprueba.
    const secSteps = P.steps.filter(st => st.t >= L.a && st.t < L.b);
    const cover = secSteps.length ? secSteps.filter(st => st.ok).length / secSteps.length : 0;
    const acc = tot ? P.hits / tot : 0;
    const pct = Math.min(cover, acc);
    engine.pause();
    engine.seek(L.a);
    const S = this.stages();
    const empty = !secSteps.length;
    if (empty || (cover >= 0.9 && acc >= 0.9)) {
      if (empty) toast("Esta parte no tiene notas para esa mano: se saltea (no cuenta como aprendida).", 5000);
      else progress.practiced(player.id);
      this.saveDone(this.sec, this.stage + 1, empty);
      practice.saveResume();
      let i = this.sec, st = this.stage + 1;
      if (st >= S.length) { i++; st = 0; }
      if (i >= this.secs.length) {
        toast("¡Aprendiste la canción entera! 🎉", 7000);
        practice.stop(false);
        return;
      }
      if (!empty) toast(`¡Bien! ${Math.round(pct * 100)}% · Ahora: ${i !== this.sec ? `parte ${i + 1}, ` : ""}${S[st].name.toLowerCase()}`, 5000);
      this.start(i, st);
    } else {
      toast(tot ? `Tocaste ${Math.round(cover * 100)}% de las notas con ${Math.round(acc * 100)}% de precisión: otra vez (hace falta 90%)`
        : "No se registró ninguna nota: otra vez.", 5000);
      for (const st of secSteps) { st.ok = false; st.errors = 0; }
      P.hits = P.misses = 0;
      ui.practiceStatus();
    }
  },

  stop() {
    if (!this.on) return;
    this.on = false;
    const L = player.loop;
    L.a = L.b = null;
    L.stage = 0;
    $("#loopBtn").classList.remove("on");
    $("span", $("#loopBtn")).textContent = "Bucle";
    if (this.savedSpeed != null) setSpeed(this.savedSpeed);
    this.savedSpeed = null;
    this.label("");
    syncLoopBtn();
  },
};

function setSpeed(v) {
  const sel = $("#speedSel");
  let best = 0;
  [...sel.options].forEach((o, i) => { if (Math.abs(+o.value - v) < Math.abs(+sel.options[best].value - v)) best = i; });
  sel.selectedIndex = best;
  engine.setSpeed(+sel.value);
  syncSpeed();
}

const intro = {
  sel: new Set([0, 1]),

  show() {
    const hands = player.tracks.filter(t => t.hand != null);
    const d = player.data;
    $("#siCover").innerHTML = coverHtml({ id: player.id, title: d.title, composer: "" });
    $("#siTitle").textContent = d.title;
    const best = progress.best(player.id), old = progress.oldBest(player.id), bc = progress.load().songs[player.id]?.bestCtx;
    const ctx = bc ? ` (${[bc.hands, bc.speed < 1 ? Math.round(bc.speed * 100) + "%" : "", bc.source === "mic" ? "micrófono" : ""].filter(Boolean).join(", ")})` : "";
    $("#siMeta").textContent = [fmtTime(d.duration), `${Math.round(d.bpm)} BPM`,
      best != null ? `tu mejor: ${best}%${ctx}` : old != null ? `antes: ${old}%` : ""].filter(Boolean).join(" · ");
    $("#siFav").classList.toggle("on", progress.isFav(player.id));
    // ¿Como te escucho? (antes habia que ir a «Más»): se recuerda la eleccion.
    $("#siSrc").innerHTML = $$("#pSrc button").map(b =>
      `<button data-src="${b.dataset.src}" class="${b.dataset.src === practice.source ? "on" : ""}">${b.textContent}</button>`).join("");
    $$("#siSrc button").forEach(b => (b.onclick = () => {
      practice.source = b.dataset.src;
      try { localStorage.setItem("src", practice.source); } catch { /* nada */ }
      $$("#siSrc button").forEach(x => x.classList.toggle("on", x === b));
    }));
    $("#siHandsBox").hidden = hands.length < 2;
    this.sel = new Set(hands.filter(t => t.practice).map(t => t.hand));
    if (!this.sel.size) this.sel = new Set(hands.map(t => t.hand));
    this.render();
    $("#songIntro").hidden = false;
  },

  hide() { $("#songIntro").hidden = true; },

  render() {
    $$("#siHands .si-hand").forEach(b => {
      const h = +b.dataset.h;
      b.classList.toggle("on", this.sel.has(h));
      $$(".si-lvl button", b).forEach(x => x.classList.toggle("on", +x.dataset.l === (player.levels[h] || 3)));
      const tr = player.tracks.find(t => t.hand === h);
      $(".si-n", b).textContent = tr ? `${simplifyHand(tr.allNotes || tr.notes, h, player.levels[h] || 3).length} notas` : "";
    });
    const both = this.sel.size === 2;
    $("#siWho").textContent = both ? "Tocás con las dos manos" : this.sel.has(1) ? "Tocás la derecha; la app toca la izquierda" : "Tocás la izquierda; la app toca la derecha";
  },

  init() {
    $$("#siHands .si-hand").forEach(b => (b.onclick = e => {
      const h = +b.dataset.h;
      const lv = e.target.closest(".si-lvl button");
      if (lv) {
        player.levels[h] = +lv.dataset.l;
        this.sel.add(h);
      } else if (this.sel.has(h) && this.sel.size > 1) this.sel.delete(h);
      else this.sel.add(h);
      this.render();
    }));
    $("#siGo").onclick = () => {
      applyLevels();
      const hands = player.tracks.filter(t => t.hand != null);
      if (hands.length) applyHands(this.sel.size === 2 ? "both" : String([...this.sel][0]));
      this.hide();
      if (player.view !== "roll") setView("roll");
      practice.start();
    };
    $("#siListen").onclick = () => { this.hide(); engine.play(); };
    $("#siLearn").onclick = () => learn.open();
    $("#siFav").onclick = () => $("#siFav").classList.toggle("on", progress.toggleFav(player.id));
    $("#lnClose").onclick = () => { $("#learnPanel").hidden = true; intro.show(); };
    $("#siClose").onclick = () => this.hide();
  },
};

function setData(data) {
  player.data = data;
  player.downSet = new Set(data.downbeats.map(d => lowerBound(data.beats, d - 1e-3, x => x)));
  $("#pTitle").textContent = data.title;
  $$("#tempoSeg button").forEach(b => b.classList.toggle("on", +b.dataset.f === (data.settings?.tempo_factor || 1)));
  $("#meterSel").value = data.settings?.beats_per_bar || "";
  renderChips();
}

function renderChips() {
  const d = player.data, k = player.keyNow();
  const latin = $("#optLatin").checked;
  const keyName = `${pcName(k.tonic, k.fifths, latin)} ${k.mode === "major" ? "mayor" : "menor"}`;
  const chips = [
    `Tonalidad <b>${esc(keyName)}</b>${player.transpose ? ` (${player.transpose > 0 ? "+" : ""}${player.transpose})` : ""}`,
    `<b>${Math.round(d.bpm)}</b> BPM`,
    `Compás <b>${d.beats_per_bar}/4</b>`,
  ];
  if (d.source === "partitura") chips.unshift(`<b>Partitura</b> importada`);
  if (Math.abs(d.tuning_cents) >= 8) {
    chips.push(`Afinación <b>${d.tuning_cents > 0 ? "+" : ""}${d.tuning_cents}</b> cents <span title="La grabación no está en La 440; se corrigió al transcribir">ⓘ</span>`);
  }
  $("#pChips").innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join("");
}

// Manos: «Izq.», «Der.» o «Ambas» es la parte que tocás vos en la practica
// (lo mismo que «Qué tocás vos» en «Más»). Solo se muestra si hay dos manos.
function applyHands(mode) {
  for (const t of player.tracks) if (t.hand != null) t.practice = mode === "both" || String(t.hand) === mode;
  syncHands();
  if (practice.on) { practice.build(); ui.practicePanel(); }
}

function syncHands() {
  const hs = player.tracks.filter(t => t.hand != null);
  $("#handsBox").hidden = hs.length < 2;
  $("#fHands").hidden = hs.length < 2;
  const on = hs.filter(t => t.practice).map(t => String(t.hand));
  const mode = on.length === 2 || (!on.length && !practice.on) ? "both" : on.length === 1 ? on[0] : "";
  $$("#handSeg button, #fHands button").forEach(b => b.classList.toggle("on", b.dataset.h === mode));
}

// «Repetir parte» refleja si hay una parte repitiendose.
function syncLoopBtn() {
  const on = player.loop.a != null && player.loop.b != null;
  $("#fLoop").classList.toggle("on", on);
  $("span", $("#fLoop")).textContent = on ? "Dejar de repetir" : "Repetir parte";
}

function syncSpeed() {
  $("#spVal").textContent = $("#fSpeed").textContent = Math.round(+$("#speedSel").value * 100) + "%";
}

// Numeros de dedo de cada mano (fingering.js). Dependen de la altura real
// (teclas negras), asi que se recalculan al transponer.
function computeFingers() {
  if (!window.Fingering) return;
  for (const t of player.tracks) {
    if (t.hand == null) continue;
    try {
      t.fingers = Fingering.assign(t.notes.map(n => [n[0], n[1], n[2] + player.transpose]), t.hand);
    } catch { t.fingers = null; }
  }
}

function renderTracks() {
  const ul = $("#tracks");
  ul.innerHTML = player.tracks.map((t, i) => `
    <li class="track ${t.visible ? "" : "hidden"}" data-i="${i}">
      <span class="dot" style="background:${t.color}"></span>
      <span class="name">${esc(t.label)}<small>${t.hand != null ? "Piano · " : ""}${t.notes.length} notas</small></span>
      ${t.id === "drums" ? "" : `<button class="tbtn v ${t.visible ? "" : "off-v"}" title="Mostrar / ocultar"><svg class="ic"><use href="#i-eye"/></svg></button>`}
      <button class="tbtn m ${t.mute ? "on-m" : ""}" title="Silenciar las notas de esta pista">M</button>
      <button class="tbtn s ${t.solo ? "on-s" : ""}" title="Escuchar solo esta pista">S</button>
    </li>`).join("");
  $$(".track", ul).forEach(li => {
    const t = player.tracks[+li.dataset.i];
    const v = $(".v", li);
    if (v) v.onclick = () => {
      t.visible = !t.visible;
      player.computeRange();
      renderTracks();
      sheet.invalidate();
      if (player.view === "sheet") sheet.show();
    };
    $(".m", li).onclick = () => { t.mute = !t.mute; engine.stopVoices(); engine.scheduledUntil = engine.time(); renderTracks(); };
    $(".s", li).onclick = () => { t.solo = !t.solo; engine.stopVoices(); engine.scheduledUntil = engine.time(); renderTracks(); };
  });
}

function setView(v) {
  player.view = v;
  $$("#viewTabs button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  $("#roll").hidden = v !== "roll";
  $("#sheetWrap").hidden = v !== "sheet";
  if (v !== "sheet") $("#sheetNav").hidden = true;
  $("#sheetNamesBtn").hidden = $("#sheetChordsBtn").hidden = $("#sheetEasyBtn").hidden = v !== "sheet";
  if (v === "sheet") sheet.show();
  syncSheetPractice();
}

// Practicando en la partitura (como Simply Piano / Flowkey): la partitura
// arriba siguiendo lo que hay que tocar y el teclado abajo, con las teclas
// que se esperan y las que tocás.
function syncSheetPractice() {
  const on = player.view === "sheet";
  document.body.classList.toggle("sheet-practice", on);
  $("#roll").hidden = player.view !== "roll" && !on;
  requestAnimationFrame(() => roll.resize());
}

/* =====================================================================
   Notas cayendo
   ===================================================================== */
// Colores "#rrggbb": mezclas y transparencias, con cache (se piden en cada cuadro).
const _rgb = {}, _mix = {};
function hexRgb(c) {
  if (!_rgb[c]) { const n = parseInt(c.slice(1), 16); _rgb[c] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  return _rgb[c];
}
function rgba(c, a) { const [r, g, b] = hexRgb(c); return `rgba(${r},${g},${b},${a})`; }
function mix(c, d, f) {
  const key = `${c}${d}${f}`;
  if (!_mix[key]) {
    const A = hexRgb(c), B = hexRgb(d);
    _mix[key] = "#" + A.map((v, i) => Math.round(v + (B[i] - v) * f).toString(16).padStart(2, "0")).join("");
  }
  return _mix[key];
}

// Color de lo que tocaste bien en la practica (notas y teclas), como en Artie.
const HIT_COLOR = "#22d3ee";

const roll = {
  canvas: null, g: null, w: 0, h: 0, dpr: 1,
  // Efectos: chispas cuando cada nota llega a la linea, haz de luz sobre las
  // teclas que suenan (se apaga de a poco al soltarse) y brillo en las notas activas.
  sparks: [], glow: new Map(), sprites: {}, prevT: 0, prevNow: 0, prevHeld: new Set(),

  init() {
    this.canvas = $("#roll");
    this.g = this.canvas.getContext("2d");
    const ro = new ResizeObserver(() => this.resize());
    ro.observe($("#stage"));
    ro.observe(this.canvas);          // practicando cambia su alto (franja de abajo, partitura)
    this.canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const pps = +$("#zoom").value;
      engine.seek(engine.time() - e.deltaY / pps * 0.6);
    }, { passive: false });
    // Arrastrar las notas con el dedo (o el mouse) para moverse en el tiempo:
    // hacia abajo avanza, como si tiraras de la partitura.
    let drag = null;
    this.canvas.addEventListener("pointerdown", e => {
      drag = { y: e.clientY, t: engine.time(), was: engine.playing };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) < 4 && !drag.moved) return;
      if (!drag.moved) { drag.moved = true; if (drag.was) engine.pause(); }
      engine.seek(drag.t + dy / +$("#zoom").value);
    });
    const end = () => {
      if (drag && drag.moved && drag.was) engine.play();
      // En pantalla completa, un toque (sin arrastrar) da play o pausa.
      else if (drag && !drag.moved && focusMode.on) {
        engine.toggle();
        if (focusMode.touch && !focusMode.fsElement()) focusMode.askFs();
      }
      drag = null;
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    const loop = () => { this.draw(); ui.updateTime(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  },

  // Distribucion de las teclas. Se calcula una vez por tamaño y rango (antes,
  // en cada cuadro: en el iPad tanto objeto descartable hacia tirones cuando
  // Safari los limpiaba). Junto con ella se guardan los degradés ya armados.
  keyLayout() {
    const [lo, hi] = player.range;
    const id = `${this.w}|${this.h}|${lo}|${hi}`;
    if (this._layout && this._layout.id === id) return this._layout;
    const isBlack = p => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    let whites = 0;
    for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites++;
    const ww = this.w / whites, keys = {}, list = [];
    let x = 0;
    for (let p = lo; p <= hi; p++) {
      if (isBlack(p)) keys[p] = { x: x - ww * 0.3, w: ww * 0.6, black: true };
      else { keys[p] = { x, w: ww, black: false }; x += ww; }
      list.push([p, keys[p]]);
    }
    this.gradCache = new Map();
    return (this._layout = { id, keys, ww, list });
  },

  // Degradé guardado (se arma una vez y se reusa en cada cuadro).
  grad(key, make) {
    let gr = this.gradCache.get(key);
    if (!gr) { gr = make(); this.gradCache.set(key, gr); }
    return gr;
  },

  // Fondo, carriles y teclado en reposo: cambian solo con el tamaño, el rango o
  // los nombres de las notas. Se dibujan una vez en una imagen aparte y en cada
  // cuadro se copian enteros (en el iPad, repintar 88 teclas con degradés 60
  // veces por segundo era mucho trabajo de mas).
  staticLayer(L, W, H, hit, kbH, latin) {
    const id = `${L.id}|${this.dpr}|${latin}`;
    if (this._static && this._static.id === id) return this._static.c;
    const c = (this._static && this._static.c) || document.createElement("canvas");
    c.width = Math.round(W * this.dpr);
    c.height = Math.round(H * this.dpr);
    const g = c.getContext("2d");
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, hit);
    bg.addColorStop(0, "#06070b");
    bg.addColorStop(1, "#10141f");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    for (const [p, k] of L.list) {
      if (k.black) { g.fillStyle = "rgba(255,255,255,0.018)"; g.fillRect(k.x, 0, k.w, hit); }
      if (p % 12 === 0) { g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(k.x, 0, 1, hit); }
    }
    const white = g.createLinearGradient(0, hit, 0, H);
    white.addColorStop(0, "#d4d8e0");
    white.addColorStop(0.08, "#f6f7fa");
    white.addColorStop(0.85, "#eceef3");
    white.addColorStop(1, "#c3c8d2");
    const bkH = kbH * 0.62;
    const black = g.createLinearGradient(0, hit, 0, hit + bkH);
    black.addColorStop(0, "#1a1d24");
    black.addColorStop(0.75, "#2b303b");
    black.addColorStop(0.9, "#3a404c");
    black.addColorStop(1, "#14161b");
    g.fillStyle = "#05060a";
    g.fillRect(0, hit, W, kbH);
    g.font = "600 10px system-ui";
    g.textAlign = "center";
    for (const [p, k] of L.list) {
      if (k.black) continue;
      roundRect(g, k.x + 0.5, hit, k.w - 1, kbH - 1, Math.min(4, k.w / 4));
      g.fillStyle = white;
      g.fill();
      if (p % 12 === 0 && k.w > 14) {
        g.fillStyle = "#8a93a6";
        g.fillText(noteName(p, 0, latin, true), k.x + k.w / 2, H - 7);
      }
    }
    for (const [, k] of L.list) {
      if (!k.black) continue;
      roundRect(g, k.x, hit - 1, k.w, bkH, Math.min(3, k.w / 4));
      g.fillStyle = black;
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.07)";
      g.fillRect(k.x + k.w * 0.2, hit + 2, k.w * 0.14, bkH * 0.72);
    }
    this._static = { id, c };
    return c;
  },

  // Halo redondo de un color, dibujado una sola vez y reusado (mucho mas
  // liviano que shadowBlur en cada cuadro).
  sprite(color) {
    let c = this.sprites[color];
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.85)");
    r.addColorStop(0.2, rgba(color, 0.7));
    r.addColorStop(0.55, rgba(color, 0.18));
    r.addColorStop(1, rgba(color, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return (this.sprites[color] = c);
  },

  burst(x, y, color, n, spread, power = 1) {
    if (this.sparks.length > 600) return;
    const light = mix(color, "#ffffff", 0.55);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
      const v = (90 + Math.random() * 230) * power;
      this.sparks.push({
        x: x + (Math.random() - 0.5) * spread, y: y - 1,
        vx: Math.cos(a) * v * 0.7, vy: Math.sin(a) * v,
        life: 0, max: 0.3 + Math.random() * 0.45, r: 0.7 + Math.random() * 1.5,
        color: Math.random() < 0.6 ? light : color,
      });
    }
  },

  draw() {
    const kbOnly = player.view === "sheet";
    if (!player.data || (player.view !== "roll" && !kbOnly) || $("#player").hidden) return;
    const g = this.g, W = this.w, H = this.h;
    if (!W || !H) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.prevNow) / 1000));
    this.prevNow = now;
    const fx = $("#optFx").checked;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const t = engine.time();
    const pps = +$("#zoom").value;
    if (focusMode.on && !kbOnly) {
      const kb = Math.max(90, Math.min(200, H * 0.22));
      if (this._needKb !== kb) { this._needKb = kb; $("#fNeed").style.bottom = (kb + 70) + "px"; }
    } else if (this._needKb) { this._needKb = 0; $("#fNeed").style.bottom = ""; }
    const kbH = kbOnly ? H - 4 : focusMode.on ? Math.max(90, Math.min(200, H * 0.22)) : Math.max(64, Math.min(130, H * 0.17));
    const hit = H - kbH;
    const L = this.keyLayout(), { keys, ww } = L;
    const tTop = t + hit / pps;
    const latin = $("#optLatin").checked, names = $("#optNames").checked;
    const fifths = player.keyNow().fifths;
    // Solo hay chispas si el tiempo avanzo normalmente (no al saltar o arrastrar).
    const flowing = engine.playing && t > this.prevT && t - this.prevT < 0.3;

    // Fondo, carriles y teclado en reposo (ya dibujados): se copian de una vez.
    g.drawImage(this.staticLayer(L, W, H, hit, kbH, latin), 0, 0, W, H);

    // Pulsos y compases.
    const beats = player.data.beats;
    const shift = player.barShift(), bpb = player.data.beats_per_bar;
    g.font = "600 11px system-ui";
    for (let i = lowerBound(beats, t, x => x); i < beats.length && beats[i] <= tTop; i++) {
      const y = hit - (beats[i] - t) * pps;
      const isDown = player.downSet.has(i);
      g.fillStyle = isDown ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.04)";
      g.fillRect(0, y, W, 1);
      if (isDown) {
        g.fillStyle = "rgba(255,255,255,0.3)";
        g.fillText(String(Math.floor((i + shift) / bpb) + 1), 6, y - 4);
      }
    }

    // Notas. Primero las de teclas blancas y despues las de negras, que quedan
    // encima; cada una con borde oscuro y un respiro arriba, para que un acorde
    // de teclas vecinas o la misma nota repetida no se vean como un solo bloque.
    const active = this._active || (this._active = new Map());
    active.clear();
    const items = [];
    for (const tr of player.tracks) {
      if (!tr.visible || tr.id === "drums") continue;
      const notes = tr.notes;
      const dim = !player.audible(tr) && !(practice.on && tr.practice);
      for (let i = lowerBound(notes, t - tr.maxDur); i < notes.length && notes[i][0] <= tTop; i++) {
        const [s, e, p0] = notes[i];
        if (e < t) continue;
        const p = p0 + player.transpose;
        const k = keys[p];
        if (!k) continue;
        const y1 = hit - (s - t) * pps, y0 = hit - (e - t) * pps;
        const on = s <= t && t < e;
        if (on) active.set(p, tr.color);
        if (fx && flowing && !dim && s > this.prevT && s <= t) {
          this.burst(k.x + k.w / 2, hit, tr.color, k.black ? 8 : 12, k.w * 0.6);
        }
        const top = Math.max(0, y0), bot = Math.min(hit, y1);
        if (bot - top < 1) continue;
        const isHit = practice.on && practice.hitNotes.has(notes[i]);
        items.push({ k, p, top, bot, on, dim, color: isHit ? HIT_COLOR : tr.color, clipped: y0 < 0,
          finger: tr.fingers ? tr.fingers[i] : 0 });
      }
    }
    items.sort((a, b) => a.k.black - b.k.black);
    const fs = Math.min(12, ww * 0.42);
    const fingers = $("#optFingers").checked;
    for (const it of items) {
      const { k } = it;
      // Aire entre notas vecinas (un acorde de teclas juntas no se ve como un
      // solo bloque) y entre la misma nota repetida.
      const pad = k.black ? Math.max(1, k.w * 0.08) : Math.max(2, ww * 0.1);
      const x = k.x + pad, w = k.w - pad * 2;
      const y = it.clipped ? it.top : it.top + 3;
      const h = it.bot - y;
      if (h < 1) continue;
      const r = Math.min(5, w / 3);
      g.globalAlpha = it.dim ? 0.35 : 1;
      if (fx && it.on && !it.dim) {
        // Halo alrededor de la nota que esta sonando.
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.4;
        g.drawImage(this.sprite(it.color), x - w * 0.45, y - 10, w * 1.9, h + 20);
        g.globalCompositeOperation = "source-over";
        g.globalAlpha = 1;
      }
      // Relleno con volumen: borde izquierdo claro, derecho oscuro.
      let base = k.black ? mix(it.color, "#000000", 0.22) : it.color;
      if (it.on) base = mix(base, "#ffffff", 0.22);
      g.fillStyle = this.grad(`n${it.p}|${base}`, () => {
        const gr = g.createLinearGradient(x, 0, x + w, 0);
        gr.addColorStop(0, mix(base, "#ffffff", 0.3));
        gr.addColorStop(0.4, base);
        gr.addColorStop(1, mix(base, "#000000", 0.32));
        return gr;
      });
      roundRect(g, x, y, w, h, r);
      g.fill();
      g.lineWidth = it.on ? 1.5 : 1.25;
      g.strokeStyle = it.on ? "rgba(255,255,255,0.85)" : "rgba(4,6,10,0.9)";
      g.stroke();
      if (!it.clipped && h > 6 && w > 6) {
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.fillRect(x + r, y + 1.5, w - r * 2, 1);
      }
      if (names && h > 16 && w > 11) {
        // El nombre se achica hasta entrar en la nota (Re♭ en una negra angosta).
        const label = noteName(it.p, fifths, latin);
        let size = k.black ? fs * 0.85 : fs;
        g.font = `700 ${size}px system-ui`;
        const tw = g.measureText(label).width;
        if (tw > w - 3) { size *= (w - 3) / tw; g.font = `700 ${size}px system-ui`; }
        if (size >= 7) {
          g.fillStyle = k.black ? "rgba(255,255,255,0.92)" : "rgba(10,13,19,0.85)";
          g.textAlign = "center";
          g.fillText(label, x + w / 2, it.bot - 5);
          g.textAlign = "left";
        }
      }
      // Numero de dedo debajo de la nota (1 = pulgar ... 5 = meñique).
      if (fingers && it.finger && it.bot + 14 < hit) {
        g.globalAlpha = it.dim ? 0.35 : 0.95;
        g.fillStyle = it.color === HIT_COLOR ? HIT_COLOR : mix(it.color, "#ffffff", 0.45);
        g.font = `800 ${Math.max(10, Math.min(13, ww * 0.5))}px system-ui`;
        g.textAlign = "center";
        g.fillText(String(it.finger), x + w / 2, it.bot + 12);
        g.textAlign = "left";
      }
      g.globalAlpha = 1;
    }

    // Luz de cada tecla: prendida mientras suena, se apaga suave al soltarse.
    for (const [p, c] of active) {
      const gl = this.glow.get(p);
      if (gl) { gl.c = c; gl.a = 1; } else this.glow.set(p, { c, a: 1 });
    }
    for (const [p, gl] of this.glow) {
      if (active.has(p)) continue;
      gl.a -= dt * 4;
      if (gl.a <= 0) this.glow.delete(p);
    }

    if (fx) {
      g.globalCompositeOperation = "lighter";
      const bh = Math.min(hit, 150);
      for (const [p, gl] of this.glow) {
        const k = keys[p];
        if (!k) continue;
        // Haz de luz que sube desde la tecla.
        g.fillStyle = this.grad(`b${gl.c}`, () => {
          const beam = g.createLinearGradient(0, hit - bh, 0, hit);
          beam.addColorStop(0, rgba(gl.c, 0));
          beam.addColorStop(1, rgba(gl.c, 0.3));
          return beam;
        });
        g.globalAlpha = gl.a;
        g.fillRect(k.x, hit - bh, k.w, bh);
        // Destello en el punto de golpe.
        const s = Math.max(ww * 2.2, 30);
        g.drawImage(this.sprite(gl.c), k.x + k.w / 2 - s / 2, hit - s / 2, s, s);
        g.globalAlpha = 1;
        // Chisporroteo suave mientras la nota sigue sonando.
        if (flowing && active.has(p) && Math.random() < dt * 10) this.burst(k.x + k.w / 2, hit, gl.c, 1, k.w * 0.7, 0.6);
      }
      g.globalCompositeOperation = "source-over";
    }

    // Linea de golpe (en practica, ambar mientras espera que toques).
    const lc = practice.waiting ? "#f2b544" : "#7b8cff";
    if (fx) {
      g.globalCompositeOperation = "lighter";
      g.fillStyle = this.grad(`h${lc}`, () => {
        const band = g.createLinearGradient(0, hit - 26, 0, hit);
        band.addColorStop(0, rgba(lc, 0));
        band.addColorStop(1, rgba(lc, practice.waiting ? 0.3 : 0.2));
        return band;
      });
      g.fillRect(0, hit - 26, W, 26);
      g.globalCompositeOperation = "source-over";
    }
    g.fillStyle = lc;
    g.fillRect(0, hit - 2, W, practice.waiting ? 3 : 2);
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.fillRect(0, hit - 1.5, W, 1);

    // Teclado. En practica: lo que tocas en verde, un error en rojo y las
    // teclas que se esperan con un recuadro que titila.
    const tint = p => {
      if (practice.flash.has(p) && practice.flash.get(p) > now) return { c: "#ff5d73", a: 1 };
      if (practice.held.has(p)) return { c: HIT_COLOR, a: 1 };
      return this.glow.get(p);
    };
    const bkH = kbH * 0.62;
    // El teclado en reposo ya se copio con el fondo: aca solo las teclas
    // encendidas. Una blanca encendida tapa el borde de sus negras vecinas, que
    // se vuelven a copiar del teclado en reposo.
    const stat = this._static.c, dpr = this.dpr, fix = this._fix || (this._fix = new Set());
    fix.clear();
    for (const [p, k] of L.list) {
      if (k.black) continue;
      const tn = tint(p);
      if (!tn) continue;
      // Tecla blanca hundida: el color entra desde arriba y se aclara hacia
      // abajo, con su sombra y una marca del color abajo (antes era un
      // rectangulo plano que tapaba el borde de las vecinas).
      const kr = Math.min(5, k.w / 4);
      g.globalAlpha = tn.a;
      roundRect(g, k.x + 1, hit, k.w - 2, kbH - 2, kr);
      g.fillStyle = this.grad(`k${tn.c}`, () => {
        const pg = g.createLinearGradient(0, hit, 0, H);
        pg.addColorStop(0, mix(tn.c, "#000000", 0.1));
        pg.addColorStop(0.45, mix(tn.c, "#ffffff", 0.35));
        pg.addColorStop(1, mix(tn.c, "#ffffff", 0.78));
        return pg;
      });
      g.fill();
      g.fillStyle = this.grad("kdepth", () => {
        const dg = g.createLinearGradient(0, hit, 0, hit + 16);
        dg.addColorStop(0, "rgba(0,0,0,0.4)");
        dg.addColorStop(1, "rgba(0,0,0,0)");
        return dg;
      });
      g.fillRect(k.x + 1, hit, k.w - 2, 16);
      roundRect(g, k.x + k.w * 0.22, H - 11, k.w * 0.56, 5, 2.5);
      g.fillStyle = tn.c;
      g.fill();
      g.globalAlpha = 1;
      if (p % 12 === 0 && k.w > 14 && tn.a > 0.5) {
        g.fillStyle = "#fff";
        g.font = "600 10px system-ui";
        g.textAlign = "center";
        g.fillText(noteName(p, 0, latin, true), k.x + k.w / 2, H - 7);
        g.textAlign = "left";
      }
      if (keys[p - 1] && keys[p - 1].black) fix.add(p - 1);
      if (keys[p + 1] && keys[p + 1].black) fix.add(p + 1);
    }
    for (const [p, k] of L.list) {
      if (!k.black) continue;
      const tn = tint(p);
      if (fix.has(p) || tn) {
        g.drawImage(stat, k.x * dpr, (hit - 1) * dpr, k.w * dpr, (bkH + 1) * dpr, k.x, hit - 1, k.w, bkH + 1);
      }
      if (tn) {
        roundRect(g, k.x + 0.5, hit - 1, k.w - 1, bkH, Math.min(3, k.w / 4));
        g.globalAlpha = tn.a;
        g.fillStyle = this.grad(`kb${tn.c}`, () => {
          const bg = g.createLinearGradient(0, hit, 0, hit + bkH);
          bg.addColorStop(0, mix(tn.c, "#000000", 0.45));
          bg.addColorStop(0.7, mix(tn.c, "#000000", 0.1));
          bg.addColorStop(1, mix(tn.c, "#ffffff", 0.25));
          return bg;
        });
        g.fill();
        g.globalAlpha = 1;
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.fillRect(k.x + k.w * 0.2, hit + 2, k.w * 0.14, bkH * 0.72);
      }
    }
    // Notas que tocaste y no eran: un cartelito rojo que sube desde la tecla.
    const gh = practice.ghosts;
    for (let i = gh.length - 1; i >= 0; i--) {
      const age = (now - gh[i].t) / 1000;
      if (age >= 1) { gh.splice(i, 1); continue; }
      const k = keys[gh[i].p];
      if (!k) continue;
      const bw = Math.max(k.w + 6, 30), y = hit - 30 - age * 50;
      g.globalAlpha = 1 - age;
      roundRect(g, k.x + k.w / 2 - bw / 2, y, bw, 22, 11);
      g.fillStyle = "#ff5d73";
      g.fill();
      g.fillStyle = "#fff";
      g.font = "700 12px system-ui";
      g.textAlign = "center";
      g.fillText(noteName(gh[i].p, fifths, latin, true), k.x + k.w / 2, y + 15);
      g.textAlign = "left";
      g.globalAlpha = 1;
    }

    // Sombra de la linea de golpe sobre las teclas.
    g.fillStyle = this.grad("sombra", () => {
      const sh = g.createLinearGradient(0, hit, 0, hit + 10);
      sh.addColorStop(0, "rgba(0,0,0,0.5)");
      sh.addColorStop(1, "rgba(0,0,0,0)");
      return sh;
    });
    g.fillRect(0, hit, W, 10);

    if (practice.waiting) {
      // Cada tecla que falta tocar: se ilumina suave y tiene un punto que
      // late (verde la que ya tocaste).
      const pulse = 0.55 + 0.45 * Math.sin(now / 160);
      for (const p of practice.required) {
        const k = keys[p];
        if (!k) continue;
        const ok = practice.got.has(p), c = ok ? "#43d17a" : "#f2b544";
        const kh = k.black ? bkH : kbH;
        if (!ok) {
          g.globalAlpha = 0.22 * pulse;
          roundRect(g, k.x + 1, hit, k.w - 2, kh - 2, Math.min(4, k.w / 4));
          g.fillStyle = c;
          g.fill();
        }
        const rr = Math.max(3, Math.min(8, k.w * 0.3));
        g.globalAlpha = ok ? 1 : 0.5 + 0.5 * pulse;
        g.beginPath();
        g.arc(k.x + k.w / 2, hit + kh - rr - (k.black ? 6 : 16), rr * (ok ? 1 : 0.85 + 0.15 * pulse), 0, Math.PI * 2);
        g.fillStyle = c;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = "rgba(0,0,0,0.35)";
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // Practica: cada tecla que tocas larga chispas verdes.
    if (fx && practice.on) {
      for (const p of practice.held.keys()) {
        const k = keys[p];
        if (k && !this.prevHeld.has(p)) this.burst(k.x + k.w / 2, hit, HIT_COLOR, 14, k.w * 0.6, 1.1);
      }
    }
    this.prevHeld = new Set(practice.held.keys());

    // Chispas: suben, la gravedad las frena y se apagan al caer sobre el teclado.
    const sp = this.sparks;
    if (sp.length) {
      g.globalCompositeOperation = "lighter";
      for (let i = sp.length - 1; i >= 0; i--) {
        const s = sp[i];
        s.life += dt;
        s.vy += 620 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.life >= s.max || (s.vy > 0 && s.y > hit + 4)) { sp[i] = sp[sp.length - 1]; sp.pop(); continue; }
        const a = 1 - s.life / s.max;
        g.globalAlpha = a;
        g.fillStyle = s.color;
        g.beginPath();
        g.arc(s.x, s.y, s.r * (0.6 + a * 0.4), 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
    }
    if (!fx) sp.length = 0;
    this.prevT = t;
  },
};

// Cifrado en Do-Re-Mi (Lam, Sol, Si♭): OSMD solo escribe la raiz en letras,
// asi que se traduce al dibujar. El archivo MusicXML queda con el cifrado estandar.
function latinChords() {
  const CS = window.opensheetmusicdisplay && opensheetmusicdisplay.ChordSymbolContainer;
  if (!CS || CS.latinPatched) return;
  const calc = CS.calculateChordText;
  CS.calculateChordText = function (...args) {
    const s = calc.apply(this, args);
    return $("#optLatin").checked ? s.replace(/^[A-G]/, c => LATIN[c]) : s;
  };
  CS.latinPatched = true;
}
latinChords();

function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, h / 2, w / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* =====================================================================
   Partitura (OpenSheetMusicDisplay) con cursor que sigue la reproduccion
   ===================================================================== */
const sheet = {
  osmd: null, key: null, times: [], idx: -1, loading: false, pending: false,

  invalidate() { this.key = null; },

  // Clave de lo que se esta mostrando: si cambia, se vuelve a dibujar.
  names() {
    return $("#optSheetNames").checked ? ($("#optLatin").checked ? "latin" : "letters") : null;
  },

  url() {
    return JSON.stringify([player.id, player.transpose, player.visibleIds(), player.data.settings, this.names(),
      $("#optChords").checked, $("#optEasy").checked, $("#optLatin").checked]);
  },

  xml() {
    const ids = player.visibleIds();
    return buildMusicXml(player.data, {
      transpose: player.transpose,
      trackIds: ids.length !== player.allIds().length ? ids : null,
      names: this.names(),
      chords: $("#optChords").checked,
      easy: $("#optEasy").checked,
    });
  },

  // En el iPad la partitura (MusicXML) se arma en el navegador.
  async getXml() {
    return this.xml();
  },

  // La partitura se dibuja por paginas: dibujar una obra entera tarda varios
  // segundos con la app congelada (medido: Für Elise 4,3 s; una pagina de 12
  // compases 0,2 s). Se dibuja la pagina que suena y se pasa sola a la siguiente.
  pages: [], page: -1, measureTimes: [], pageLead: 0,

  async show() {
    const url = this.url();
    if (this.key === url) { this.syncPage(true); return; }
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    const msg = $("#sheetMsg"), div = $("#sheet");
    msg.textContent = "Armando la partitura…";
    try {
      if (!player.visibleIds().length) throw new Error("No hay pistas visibles con notas para mostrar.");
      const xml = await this.getXml(url);
      if (!this.osmd) {
        this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(div, {
          autoResize: false, backend: "svg", drawTitle: false, drawSubtitle: false, drawComposer: false,
          drawPartNames: true, followCursor: true, drawingParameters: "default", autoBeam: true,
        });
        // Al cambiar el ancho (girar el iPad, abrir el panel) se redibuja solo la pagina.
        let rt;
        new ResizeObserver(() => {
          clearTimeout(rt);
          rt = setTimeout(() => {
            if (!this.key || player.view !== "sheet") return;
            this.measureMap();                     // otro tamaño: otras paginas
            this.page = -1;
            this.syncPage(true);
          }, 250);
        }).observe($("#sheetWrap"));
      }
      this.osmd.EngravingRules.ChordSymbolTextHeight = 2.4;
      await this.osmd.load(xml);
      this.measureMap();
      this.key = url;
      this.page = -1;
      msg.textContent = "";
      this.syncPage(true);
    } catch (e) {
      msg.textContent = e.message;
      $("#sheetNav").hidden = true;
    } finally {
      this.loading = false;
      if (this.pending) { this.pending = false; if (player.view === "sheet") this.show(); }
    }
  },

  // Tiempo (en segundos de la grabacion) en que empieza cada compas, y paginas.
  measureMap() {
    const ms = this.osmd.Sheet.SourceMeasures, shift = player.barShift();
    // Si el primer compas es una anacrusa, OSMD empieza a contar desde ahi,
    // pero en nuestra grilla ese compas empieza 'lead' pulsos mas tarde.
    const m0 = ms[0];
    let lead = 0;
    if (m0 && m0.Duration && m0.ActiveTimeSignature) {
      const actual = m0.Duration.RealValue * 4, full = m0.ActiveTimeSignature.RealValue * 4;
      if (actual < full - 1e-6) lead = full - actual;
    }
    this.pageLead = lead;
    this.measureTimes = ms.map(m => player.beatToTime(m.AbsoluteTimestamp.RealValue * 4 + lead - shift));
    const per = this.perPage();
    this.pages = [];
    for (let i = 0; i < ms.length; i += per) {
      this.pages.push({ from: i, to: Math.min(ms.length, i + per) - 1 });
    }
  },

  // Compases por renglon (4, o 3 si la musica es muy densa o la pantalla angosta)
  // y renglones que entran arriba del teclado: notas grandes y sin scroll.
  layout() {
    const wrap = $("#sheetWrap"), w = wrap.clientWidth || 900, h = wrap.clientHeight || 600;
    const ms = this.osmd.Sheet.SourceMeasures;
    const notes = player.tracks.reduce((n, t) => n + (t.allNotes || t.notes).length, 0);
    const dense = notes / Math.max(1, ms.length) > 14;
    const perLine = w < 600 ? 2 : w < 900 || dense ? 3 : 4;
    // Lo mas grande posible, pero que entren al menos dos renglones si se puede.
    let zoom = w < 600 ? 0.8 : w < 900 ? 0.95 : 1.1, lines = 1;
    for (; ; zoom -= 0.05) {
      lines = Math.max(1, Math.floor((h - 90) / (230 * zoom)));   // 230: alto medido de un renglon de piano con cifrado
      if (lines >= 2 || zoom <= 0.85) break;
    }
    // Si ni chiquitas entran dos, mejor un renglon grande.
    if (lines < 2) zoom = w < 600 ? 0.8 : w < 900 ? 0.95 : 1.1;
    return { perLine, zoom: Math.round(zoom * 100) / 100, lines };
  },

  perPage() {
    const L = this.layout();
    this.lay = L;
    return L.perLine * L.lines;
  },

  pageAt(t) {
    let p = 0;
    for (let i = 0; i < this.pages.length; i++) if (this.measureTimes[this.pages[i].from] <= t + 0.05) p = i;
    return p;
  },

  // Pone la pagina donde esta sonando la musica (si no es la que se ve).
  syncPage(force = false) {
    if (!this.pages.length) return;
    const p = this.pageAt(engine.time());
    if (p !== this.page || force) this.renderPage(p, force && p === this.page);
  },

  renderPage(p, keepScroll = false) {
    if (!this.osmd || !this.pages.length) return;
    p = Math.max(0, Math.min(this.pages.length - 1, p));
    const pg = this.pages[p], ms = this.osmd.Sheet.SourceMeasures;
    this.osmd.setOptions({
      drawFromMeasureNumber: ms[pg.from].MeasureNumber,
      drawUpToMeasureNumber: ms[pg.to].MeasureNumber,
    });
    const L = this.lay || this.layout();
    this.osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = L.perLine;
    this.osmd.EngravingRules.StretchLastSystemLine = true;     // todos los renglones del mismo ancho
    this.osmd.zoom = L.zoom;
    this.osmd.render();
    this.osmd.cursor.show();
    this.page = p;
    this.buildTimes();
    if (!keepScroll) $("#sheetWrap").scrollTop = 0;
    const nav = $("#sheetNav");
    nav.hidden = this.pages.length < 2;
    $("#pgInfo").textContent = `Compases ${ms[pg.from].MeasureNumber}–${ms[pg.to].MeasureNumber} · Página ${p + 1} de ${this.pages.length}`;
    $("#pgPrev").disabled = p === 0;
    $("#pgNext").disabled = p === this.pages.length - 1;
  },

  // Hojear: la musica va al comienzo de esa pagina (y el cursor con ella).
  goPage(d) {
    const p = Math.max(0, Math.min(this.pages.length - 1, this.page + d));
    if (p === this.page) return;
    engine.seek(this.measureTimes[this.pages[p].from] + 0.01);
    this.renderPage(p);
  },

  // Tiempo de cada posicion del cursor dentro de la pagina dibujada.
  buildTimes() {
    // Con una copia del recorrido: mover el cursor visible nota por nota
    // tardaba 0,3 s por pagina (medido), la copia 7 ms.
    const c = this.osmd.cursor, shift = player.barShift();
    c.reset();
    const it = c.iterator.clone();
    this.times = [];
    let guard = 0;
    while (!it.EndReached && guard++ < 20000) {
      this.times.push(player.beatToTime(it.currentTimeStamp.RealValue * 4 + this.pageLead - shift));
      it.moveToNext();
    }
    this.idx = 0;
  },

  follow() {
    if (!this.osmd || this.key == null || player.view !== "sheet" || this.loading) return;
    if (!this.times.length) return;
    const t = engine.time();
    // Termino la pagina (o se salto a otro lado): se dibuja la que corresponde.
    const p = this.pageAt(t);
    if (p !== this.page) { this.renderPage(p); return; }
    let target = lowerBound(this.times, t + 0.03, x => x) - 1;
    target = Math.max(0, Math.min(this.times.length - 1, target));
    if (target === this.idx) return;
    const c = this.osmd.cursor;
    if (target < this.idx) { c.reset(); this.idx = 0; }
    while (this.idx < target) { c.next(); this.idx++; }
  },
};

/* =====================================================================
   Practica con un piano real (teclado MIDI o microfono)
   ===================================================================== */
/* =====================================================================
   Resumen al terminar de practicar: precision, notas bien, errores, tiempo
   y las partes que mas costaron (con un boton para practicarlas en bucle).
   ===================================================================== */
const summary = {
  // Numero de compas de un momento de la cancion (igual que en las notas que caen).
  barAt(t) {
    const beats = player.data.beats, bpb = player.data.beats_per_bar;
    const i = Math.max(0, lowerBound(beats, t + 1e-3, x => x) - 1);
    return Math.floor((i + player.barShift()) / bpb) + 1;
  },

  show(finished) {
    const P = practice, tot = P.hits + P.misses;
    const okSteps = P.steps.filter(st => st.ok).length;
    const cover = P.steps.length ? okSteps / P.steps.length : 0;
    // Solo cuenta como la cancion entera si se llego al final, sin bucle y
    // tocando casi todas las notas (si se salto con la barra, no).
    const full = finished && player.loop.a == null && cover >= 0.9;
    if (tot) progress.record(player.id, { full, acc: Math.round((P.hits / tot) * 100), cover: Math.round(cover * 100), ctx: P.context() });
    $("#sumTitle").textContent = finished ? "¡Terminaste!" : "Así te fue";
    $("#sumPct").textContent = tot ? Math.round((P.hits / tot) * 100) + "%" : "–";
    $("#sumHits").textContent = P.hits;
    $("#sumMiss").textContent = P.misses;
    $("#sumHits").nextSibling.textContent = P.hits === 1 ? " nota bien" : " notas bien";
    $("#sumMiss").nextSibling.textContent = P.misses === 1 ? " error" : " errores";
    $("#sumTime").textContent = fmtTime((performance.now() - (P.startedAt || performance.now())) / 1000);
    // Partes de 4 compases, ordenadas por errores.
    const parts = new Map();
    for (const st of P.steps) {
      if (!st.ok && !st.errors) continue;
      const bar = this.barAt(st.t), key = Math.floor((bar - 1) / 4);
      const pt = parts.get(key) || { from: key * 4 + 1, to: key * 4 + 4, errors: 0, a: st.t, b: st.t };
      pt.errors += st.errors;
      pt.a = Math.min(pt.a, st.t);
      pt.b = Math.max(pt.b, st.t);
      parts.set(key, pt);
    }
    const worst = [...parts.values()].filter(p => p.errors > 0).sort((x, y) => y.errors - x.errors).slice(0, 3);
    this.worst = worst;
    $("#sumParts").innerHTML = worst.length
      ? `<h4>Lo que más te costó</h4>` + worst.map((p, i) => `
          <div class="sum-part"><span>Compases ${p.from}–${p.to} · <b>${p.errors} error${p.errors > 1 ? "es" : ""}</b></span>
          <button class="ghost" data-i="${i}"><svg class="ic"><use href="#i-loop"/></svg> Practicar esta parte</button></div>`).join("")
      : tot ? `<p class="sum-ok">Sin errores. ¡Muy bien!</p>` : "";
    $$("#sumParts button").forEach(b => (b.onclick = () => this.loopPart(this.worst[+b.dataset.i])));
    $("#summary").hidden = false;
  },

  hide() { $("#summary").hidden = true; },

  // Otra vez desde el principio (o desde el comienzo del bucle, si hay).
  again() {
    this.hide();
    engine.pause();
    engine.seek(player.loop.a ?? 0);
    practice.start();
  },

  // Bucle en la parte dificil y a practicarla.
  loopPart(p) {
    this.hide();
    const L = player.loop;
    L.a = Math.max(0, p.a - 0.4);
    L.b = p.b + 1.2;
    L.stage = 2;
    const btn = $("#loopBtn");
    btn.classList.add("on");
    $("span", btn).textContent = "Quitar bucle";
    engine.pause();
    engine.seek(L.a);
    practice.start();
  },
};

const practice = {
  on: false, wait: true, hearMine: false, echo: false,
  // Como te escucha: lo que elegiste la ultima vez; si no, teclado MIDI donde
  // el navegador lo tiene y si no (Safari del iPad) el microfono.
  source: (() => { try { return localStorage.getItem("src"); } catch { return null; } })()
    || (navigator.requestMIDIAccess ? "midi" : "mic"),
  ghosts: [], wrong: null,
  steps: [], idx: 0, waiting: false, hitNotes: new WeakSet(), startedAt: 0, finished: false,
  required: new Set(), got: new Set(), held: new Map(), flash: new Map(),
  recent: [], hits: 0, misses: 0, savedMix: null, feedback: "", device: "",
  midi: null, live: new Map(),
  mic: null, micSens: 18,

  tracks() { return player.tracks.filter(t => t.practice); },

  // Practicando, la app solo toca la OTRA mano cuando elegiste una sola; con
  // las dos manos no suena nada (solo te escucha a vos).
  accompanies(tr) {
    return tr.hand != null && !tr.practice && player.tracks.some(t => t.hand != null && t.practice);
  },

  // Pasos a tocar: las notas de las pistas elegidas, agrupadas en acordes
  // (lo que empieza con menos de 60 ms de diferencia se toca junto).
  build() {
    const all = [];
    for (const tr of this.tracks()) for (const n of tr.notes) all.push(n);
    all.sort((a, b) => a[0] - b[0]);
    const steps = [];
    for (const n of all) {
      const [s, , p] = n;
      const last = steps[steps.length - 1];
      if (last && s - last.t < 0.06) { last.pitches.add(p + player.transpose); last.notes.push(n); }
      else steps.push({ t: s, pitches: new Set([p + player.transpose]), notes: [n], errors: 0, ok: false });
    }
    this.steps = steps;
    this.hitNotes = new WeakSet();
    this.sync();
  },

  // Despues de moverse en la cancion: el proximo paso es el que sigue.
  sync() {
    this.idx = lowerBound(this.steps, engine.time() - 0.02, x => x.t);
    this.waiting = false;
    this.required = new Set();
    this.got = new Set();
    ui.practiceStatus();
  },

  recentMatching(pitches, ms) {
    const lim = performance.now() - ms;
    return this.recent.filter(r => r.t >= lim && pitches.has(r.p)).map(r => r.p);
  },

  complete() {
    for (const p of this.required) if (!this.got.has(p)) return false;
    return this.required.size > 0;
  },

  // Lo llama el motor cada 25 ms mientras suena. Devuelve true si freno.
  check(now) {
    if (!this.on || !this.steps.length) return false;
    const st = this.steps[this.idx];
    if (!st) return false;
    if (this.wait) {
      if (now < st.t) return false;
      engine.pause();
      engine.seek(st.t);            // deja las notas justo sobre la linea
      this.required = st.pitches;
      // Si se adelanto un poco, vale. Con el microfono el margen es menor: la
      // cola de la nota anterior puede parecerse a un ataque de la siguiente.
      this.got = new Set(this.recentMatching(st.pitches, this.source === "mic" ? 150 : 450));
      if (this.complete()) { this.pass(true); return true; }
      this.waiting = true;
      ui.practiceStatus();
      return true;
    }
    // Al tempo: cada paso tiene una ventana; si no llegaste, cuenta como error.
    if (this.required !== st.pitches && now >= st.t - 0.25) {
      this.required = st.pitches;
      this.got = new Set(this.recentMatching(st.pitches, 300));
      if (this.complete()) this.pass(false);
    } else if (now > st.t + 0.35) {
      this.misses++;
      st.errors++;
      for (const p of st.pitches) if (!this.got.has(p)) this.flash.set(p, performance.now() + 300);
      this.feedback = "Se pasó…";
      this.advance();
    }
    return false;
  },

  advance() {
    this.idx++;
    this.required = new Set();
    this.got = new Set();
    ui.practiceStatus();
    // Llego al final de la cancion: resumen.
    if (this.idx >= this.steps.length && this.steps.length && !this.finished && !learn.on) {
      this.finished = true;
      engine.pause();
      summary.show(true);
    }
  },

  pass(resume) {
    const st = this.steps[this.idx];
    if (st) { st.ok = true; for (const n of st.notes) this.hitNotes.add(n); }
    this.hits++;
    this.feedback = "¡Bien!";
    this.waiting = false;
    this.advance();
    if (resume) engine.play();
  },

  noteOn(p, fromMic = false) {
    const now = performance.now();
    this.held.set(p, now);
    this.recent.push({ p, t: now });
    if (this.recent.length > 64) this.recent.splice(0, this.recent.length - 64);
    if (this.echo && !fromMic) engine.playLive(p);
    if (!this.on) return;
    if (this.required.has(p)) {
      this.got.add(p);
      if (this.complete()) this.pass(this.waiting); else ui.practiceStatus();
      return;
    }
    // Una nota que no va. Con el microfono no se marca: un armonico o el eco
    // del acompanamiento darian errores falsos.
    const next = this.steps[this.idx + (this.required.size ? 1 : 0)];
    const early = next && next.pitches.has(p);
    if (!early) this.ghost(p);
    if (!fromMic && !early && (this.waiting || !this.wait)) {
      this.misses++;
      const cur = this.steps[this.idx];
      if (cur) cur.errors++;
      this.feedback = "Esa no";
      this.flash.set(p, now + 350);
      ui.practiceStatus();
    }
  },

  // Una nota que no era: se marca en el teclado (sube un cartelito rojo) y
  // se dice a cuanto quedo de la que habia que tocar.
  ghost(p) {
    const now = performance.now();
    this.ghosts.push({ p, t: now });
    if (this.ghosts.length > 12) this.ghosts.shift();
    this.flash.set(p, now + 350);
    const need = [...this.required].filter(q => !this.got.has(q));
    if (!need.length) return;
    const q = need.reduce((m, x) => (Math.abs(x - p) < Math.abs(m - p) ? x : m), need[0]);
    const d = q - p, a = Math.abs(d);
    const latin = $("#optLatin").checked, fifths = player.keyNow().fifths;
    const dist = a === 1 ? "medio tono" : a === 2 ? "un tono" : a === 12 ? "una octava" : a > 12 ? "más de una octava" : `${a} teclas`;
    this.wrong = { t: now, text: `tocaste ${noteName(p, fifths, latin, true)}: ${dist} más ${d > 0 ? "abajo" : "arriba"}` };
    ui.practiceStatus();
  },

  noteOff(p) {
    this.held.delete(p);
    engine.stopLive(p);
  },

  async start() {
    this.on = true;
    this.hits = this.misses = 0;
    this.startedAt = performance.now();
    this.finished = false;
    summary.hide();
    this.feedback = "";
    if (!this.tracks().length) {
      const hands = player.tracks.filter(t => t.hand != null);
      const first = player.tracks.find(t => t.id !== "drums");
      (hands.length ? hands : first ? [first] : []).forEach(t => (t.practice = true));
    }
    {
      // Practicando no suena la grabacion original (frenar y seguir la corta a
      // cada rato y el microfono la confundiria con lo que tocás): a lo sumo,
      // la otra mano con el piano de la app (ver accompanies).
      this.savedMix = +$("#mix").value;
      $("#mix").value = 100;
      engine.setMix(100);
    }
    this.build();
    // Como en las apps de piano: practicar es pantalla grande, solo las notas
    // y el teclado. Al terminar se vuelve a como estaba.
    this.autoFocus = !focusMode.on;
    if (this.autoFocus) focusMode.toggle(true);
    else focusMode.syncPractice();
    ui.practicePanel();
    await this.setSource(this.source);
  },

  // withSummary: al dejarla con el boton (no al cambiar de cancion), si ya
  // se toco un rato, se muestra el resumen.
  // Con que se practico (queda junto al puntaje).
  context() {
    const hs = player.tracks.filter(t => t.hand != null && t.practice).map(t => t.hand);
    return {
      hands: hs.length === 2 ? "ambas" : hs[0] === 1 ? "derecha" : hs[0] === 0 ? "izquierda" : "",
      levels: { ...(player.levels || {}) }, speed: +$("#speedSel").value, source: this.source, wait: this.wait,
    };
  },

  saveResume() {
    if (!player.id || !player.data) return;
    progress.setResume(player.id, {
      t: Math.round(engine.time() * 10) / 10, ...this.context(), view: player.view,
      learn: learn.on ? { sec: learn.sec, stage: learn.stage } : null, at: Date.now(),
    });
  },

  stop(withSummary = false) {
    if (this.on) this.saveResume();
    learn.stop();
    if (withSummary && !this.finished && this.hits + this.misses >= 8) summary.show(false);
    this.on = false;
    this.waiting = false;
    this.required = new Set();
    this.stopMic();
    if (this.savedMix != null) {
      $("#mix").value = this.savedMix;
      engine.setMix(this.savedMix);
      this.savedMix = null;
    }
    if (this.autoFocus && focusMode.on) focusMode.toggle(false);
    this.autoFocus = false;
    focusMode.syncPractice();
    syncSheetPractice();
    ui.practicePanel();
  },

  async setSource(src) {
    this.source = src;
    try { localStorage.setItem("src", src); } catch { /* nada */ }
    if (src === "midi") { this.stopMic(); await this.initMidi(); }
    else await this.initMic();
    ui.practicePanel();
  },

  // ---------------------------------------------------------------- MIDI
  async initMidi() {
    if (!navigator.requestMIDIAccess) {
      this.device = "Este navegador no tiene MIDI. En la PC usá Chrome o Edge; en el iPad, la app "
        + "Web MIDI Browser (o el micrófono).";
      return;
    }
    if (!this.midi) {
      try {
        this.midi = await navigator.requestMIDIAccess();
      } catch (e) {
        this.device = "El navegador bloqueó el MIDI. Tocá el candado 🔒 junto a la dirección, "
          + "permití «Dispositivos MIDI» y volvé a tocar «Teclado MIDI». "
          + `(${(e && (e.name || e.message)) || "sin detalle"})`;
        return;
      }
      this.midi.onstatechange = () => { this.bindMidi(); ui.practicePanel(); };
    }
    this.bindMidi();
  },

  // Lista de teclados. Algunos navegadores (Web MIDI Browser en el iPad) no
  // entregan un Map como Chrome: se aceptan las tres formas.
  midiInputs() {
    const ins = this.midi && this.midi.inputs;
    if (!ins) return [];
    if (typeof ins.values === "function") return [...ins.values()];
    if (typeof ins.forEach === "function") { const out = []; ins.forEach(i => out.push(i)); return out; }
    return Object.values(ins);
  },

  bindMidi() {
    const inputs = this.midiInputs();
    for (const inp of inputs) {
      if (inp.__transcriptor) continue;
      inp.__transcriptor = true;
      // Por las dos vias (propiedad y evento): cada navegador usa una; si
      // llegan las dos, onMidi descarta el repetido.
      const h = e => this.onMidi(e);
      inp.onmidimessage = h;
      try { if (inp.addEventListener) inp.addEventListener("midimessage", h); } catch { /* no lo soporta */ }
      try { if (inp.open) { const r = inp.open(); if (r && r.catch) r.catch(() => {}); } } catch { /* ya abierto */ }
    }
    this.midiCount = inputs.length;
    this.device = inputs.length
      ? "Conectado: " + inputs.map(i => i.name || "teclado MIDI").join(", ")
      : "No veo ningún teclado MIDI. Conectalo por USB: se detecta solo al enchufarlo.";
    // Si el navegador no avisa cuando se enchufa un teclado, se revisa solo.
    clearInterval(this.midiPoll);
    this.midiPoll = setInterval(() => {
      if (!this.on || this.source !== "midi") return clearInterval(this.midiPoll);
      if (this.midiInputs().length !== this.midiCount) { this.bindMidi(); ui.practicePanel(); }
    }, 2000);
  },

  onMidi(e) {
    if (e === this.lastMidiEvent) return;
    this.lastMidiEvent = e;
    const data = e.data || (e.detail && e.detail.data) || [];
    const [st, d1, d2] = data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) this.noteOn(d1);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.noteOff(d1);
    // Diagnostico: la ultima señal que llego del teclado (sin el reloj MIDI).
    if (st < 0xf8) {
      this.midiMsgs = (this.midiMsgs || 0) + 1;
      const hex = [...data].slice(0, 3).map(x => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
      const name = cmd === 0x90 || cmd === 0x80 ? ` (${noteName(d1, 0, $("#optLatin").checked, true)})` : "";
      const el = $("#pDev");
      if (el) el.textContent = `${this.device} · señales recibidas: ${this.midiMsgs} · última: ${hex}${name}`;
    }
  },

  // ---------------------------------------------------------------- microfono
  // No se transcribe lo que suena (con acordes seria poco confiable): se
  // verifica si aparecen las notas que se ESPERAN, mirando su fundamental y
  // sus primeros armonicos, y que hayan subido de golpe (un ataque nuevo).
  async initMic() {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.device = "El navegador no deja usar el micrófono en esta dirección (en iPad hace falta https).";
      return;
    }
    let stream;
    setAudioMode(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      setAudioMode(false);
      this.device = "No se pudo usar el micrófono: " + e.message;
      return;
    }
    engine.init();
    await engine.ctx.resume();
    this.attachDetector(engine.ctx.createMediaStreamSource(stream), stream);
    this.device = "Micrófono activo. Con auriculares anda mejor: el acompañamiento no se cuela.";
  },

  attachDetector(node, stream = null) {
    const an = engine.ctx.createAnalyser();
    an.fftSize = 16384;
    an.smoothingTimeConstant = 0;
    node.connect(an);
    // Se sigue el nivel de las 88 teclas todo el tiempo (no solo de las que se
    // esperan): asi un "ataque" se mide contra lo que venia sonando de verdad.
    this.mic = { an, node, stream, buf: new Float32Array(an.frequencyBinCount),
      sal: new Float32Array(128).fill(-200), hist: [], last: new Map() };
    this.mic.timer = setInterval(() => this.detect(), 30);
  },

  stopMic() {
    if (!this.mic) return;
    clearInterval(this.mic.timer);
    try { this.mic.node.disconnect(this.mic.an); } catch { /* ya desconectado */ }
    if (this.mic.stream) this.mic.stream.getTracks().forEach(t => t.stop());
    this.mic = null;
    setAudioMode(false);
  },

  detect() {
    const m = this.mic, buf = m.buf;
    m.an.getFloatFrequencyData(buf);
    const binHz = engine.ctx.sampleRate / m.an.fftSize;
    // Piso de ruido: mediana del espectro entre 60 Hz y 5 kHz.
    const lo = Math.floor(60 / binHz), hi = Math.floor(5000 / binHz), sample = [];
    let mx = -200;
    for (let i = lo; i < hi; i += 3) { sample.push(buf[i]); if (buf[i] > mx) mx = buf[i]; }
    sample.sort((a, b) => a - b);
    const floor = sample[sample.length >> 1];
    const peak = f => {
      const a = Math.floor(f * 0.985 / binHz), b = Math.ceil(f * 1.015 / binHz);
      let v = -200;
      for (let i = a; i <= b && i < buf.length; i++) if (buf[i] > v) v = buf[i];
      return v;
    };
    // Nivel de cada tecla: los dos armonicos mas fuertes de los tres primeros
    // (los graves del piano casi no tienen fundamental).
    const sal = new Float32Array(128).fill(-200), fund = new Float32Array(128).fill(-200);
    for (let p = 21; p <= 108; p++) {
      const f0 = 440 * Math.pow(2, (p - 69) / 12);
      const hs = [fund[p] = peak(f0), peak(2 * f0), peak(3 * f0)].sort((a, b) => b - a);
      sal[p] = (hs[0] + hs[1]) / 2;
    }
    m.hist.push(sal);
    if (m.hist.length > 13) m.hist.shift();
    (m.fhist || (m.fhist = [])).push(fund);
    if (m.fhist.length > 7) m.fhist.shift();

    // Se escucha lo que se espera ahora y, si todavia no llego a la linea, el
    // paso siguiente (por si se toca un poquito antes).
    const cand = new Set(this.required);
    const next = this.steps[this.idx + (this.required.size ? 1 : 0)];
    if (next && !this.waiting && next.t - engine.time() < 0.2) next.pitches.forEach(p => cand.add(p));
    const now = performance.now();
    // Los graves tardan mas en aparecer en el analisis (la ventana es de 1/3 s):
    // para ellos se compara con lo que sonaba hace mas tiempo.
    const back = p => (p < 48 ? 12 : 6);
    const attacked = p => {
      let prevMin = Infinity;
      for (let i = Math.max(0, m.hist.length - 1 - back(p)); i < m.hist.length - 1; i++) prevMin = Math.min(prevMin, m.hist[i][p]);
      // Fuerte: sobre el ruido de fondo, o entre lo mas fuerte que suena (los
      // graves reparten su energia en muchos armonicos y levantan el "fondo").
      const loud = sal[p] - floor > this.micSens || (sal[p] > mx - 20 && sal[p] - floor > this.micSens / 2);
      return isFinite(prevMin) && sal[p] - prevMin > 8 && loud;
    };
    // ¿Lo explica otro sonido? La app acaba de tocar esa nota o una que la
    // tiene de armonico (octava, quinta...), o sono a la vez una nota mas
    // grave que no se esperaba (su armonico parece esta tecla). Sin esto la
    // practica a veces avanzaba sola con el acompañamiento.
    const ct = engine.ctx.currentTime, HARM = [0, 12, 19, 24, 28];
    const byApp = p => (engine.outs || []).some(([q, at]) => at <= ct + 0.03 && ct - at < 0.25 && HARM.includes(p - q));
    // (la nota grave tiene que sonar con su propia fundamental: su nivel
    // "sal" incluye sus armonicos, o sea esta misma tecla)
    const fundAttack = q => {
      let prevMin = Infinity;
      for (let i = 0; i < m.fhist.length - 1; i++) prevMin = Math.min(prevMin, m.fhist[i][q]);
      return isFinite(prevMin) && fund[q] - prevMin > 8 && fund[q] - floor > this.micSens;
    };
    // (y fuerte: el golpe de cualquier tecla levanta un poco todos los graves)
    const byLower = p => [12, 19, 24].some(d => p - d >= 21 && !cand.has(p - d) && fundAttack(p - d)
      && fund[p - d] > sal[p] - 10);
    let hit = false;
    const okSet = new Set();
    let salMax = -Infinity;
    for (let p = 21; p <= 108; p++) if (sal[p] > salMax) salMax = sal[p];
    for (const p of cand) {
      if (p < 21 || p > 108) continue;
      const v = sal[p];
      const own = v > Math.max(sal[p - 1], sal[p + 1]) + 3;      // es esta tecla y no la de al lado
      // De Do3 para arriba el piano tiene fundamental: tiene que sonar ella (si
      // no, un armonico compartido con otra nota parecia esta tecla).
      const fundOk = p < 48 || fundAttack(p);
      // Dos cuadros seguidos (el piano se queda en la tecla; la voz pasa de largo).
      const okNow = attacked(p) && own && fundOk && !byApp(p) && !byLower(p);
      const okBefore = p < 48 || (m.okPrev && m.okPrev.has(p));   // los graves tardan: alcanza con uno
      if (okNow) okSet.add(p);
      if (okNow && okBefore && now - (m.last.get(p) || 0) > (p < 48 ? 450 : 250)) {
        m.last.set(p, now);
        this.noteOn(p, true);
        setTimeout(() => this.held.delete(p), 220);
        hit = true;
      }
    }
    // Ninguna de las esperadas: ¿sono otra nota clara? Se muestra (no cuenta
    // como error: con el microfono podria ser un armonico).
    m.okPrev = okSet;
    // Exigente, para que la voz o el ruido no aparezcan como notas: tiene que
    // ser lo mas fuerte que suena, bien por encima del ruido, cerca (menos de
    // una octava) de la que habia que tocar y quedarse en la misma tecla
    // varios cuadros seguidos (la voz cambia de altura todo el tiempo).
    if (!hit && this.waiting && this.required.size) {
      const req = [...this.required];
      let bestP = 0, bestV = -Infinity;
      for (let p = 21; p <= 108; p++) {
        if (cand.has(p) || sal[p] - floor < this.micSens + 14 || sal[p] < salMax - 3 || sal[p] <= bestV) continue;
        if (!req.some(q => Math.abs(q - p) <= 12)) continue;
        if (!(sal[p] > Math.max(sal[p - 1], sal[p + 1]) + 6)) continue;
        if (!(p < 48 || fund[p] - floor > this.micSens + 6) || byApp(p) || byLower(p)) continue;
        bestP = p; bestV = sal[p];
      }
      const pend = m.pend;
      if (bestP && pend && pend.p === bestP) pend.n++;
      else m.pend = bestP ? { p: bestP, n: 1, attack: attacked(bestP) } : null;
      const P2 = m.pend;
      if (m.lock && sal[m.lock] - floor < this.micSens + 4) m.lock = 0;   // ya se apago: puede volver a marcarse
      if (P2 && P2.n >= 4 && P2.attack && P2.p !== m.lock && now - (m.last.get(P2.p) || 0) > 600) {
        m.last.set(P2.p, now);
        m.lock = P2.p;
        m.pend = null;
        this.ghost(P2.p);
      }
    } else m.pend = null;
    ui.micLevel(mx - floor);
  },
};

/* =====================================================================
   Controles
   ===================================================================== */
const ui = {
  onPlayState(p) {
    $("#playBtn").innerHTML = $("#fPlay").innerHTML = p ? '<svg class="ic fill"><use href="#i-pause"/></svg>' : '<svg class="ic fill play-ic"><use href="#i-play"/></svg>';
    this.practiceStatus();
  },

  sfStatus(t) { $("#sfStatus").textContent = t; },

  practicePanel() {
    const P = practice;
    // La configuracion de la practica vive en «Más»; mientras se practica,
    // lo que hay que tocar y como vas se ve arriba de las notas.
    $("#hud").hidden = !P.on;
    $("#pClose").hidden = !P.on;
    $("#practiceBtn").classList.toggle("on", P.on);
    $("#practiceBtn").lastChild.textContent = P.on ? " Dejar de practicar" : " Practicar";
    $$("#pSrc button").forEach(b => b.classList.toggle("on", b.dataset.src === P.source));
    $("#pDev").textContent = P.device || "";
    // Lo que de verdad esta pasando con la entrada (no «conectado» si no se comprobo).
    const st = P.source === "mic" ? (P.mic ? [true, "Micrófono activo"] : [false, "Micrófono sin permiso"])
      : P.source === "pc" ? (/^Teclado en la PC/.test(P.device || "") ? [true, "Teclado en la PC"] : [false, "Buscando la PC…"])
      : (P.midiCount > 0 ? [true, "Teclado conectado"] : [false, "Sin teclado MIDI"]);
    $("#fSrc").innerHTML = `<i class="sdot ${st[0] ? "ok" : "warn"}"></i><svg class="ic"><use href="#i-${P.source === "mic" ? "mic" : "piano"}"/></svg> ${st[1]}`;
    $("#fSrc").title = (P.device || "") + " · tocá para cambiar";
    $("#pMicRow").hidden = P.source !== "mic";
    $("#pEchoRow").hidden = P.source !== "midi";
    $("#pWait").checked = P.wait;
    $("#pHear").checked = P.hearMine;
    $("#pEcho").checked = P.echo;
    $("#pParts").innerHTML = player.tracks.filter(t => t.id !== "drums").map((t, i) => `
      <span class="p-part ${t.practice ? "on" : ""}" data-k="${esc(t.key)}" style="color:${t.color}">
        <i style="background:${t.color}"></i><span style="color:var(--text)">${esc(t.label)}</span></span>`).join("");
    $$("#pParts .p-part").forEach(el => (el.onclick = () => {
      const t = player.tracks.find(x => x.key === el.dataset.k);
      t.practice = !t.practice;
      P.build();
      this.practicePanel();
    }));
    syncHands();
    this.practiceStatus();
  },

  practiceStatus() {
    if (!practice.on) return;
    const P = practice;
    $("#pHits").textContent = P.hits;
    $("#pMiss").textContent = P.misses;
    const tot = P.hits + P.misses;
    $("#pPct").textContent = tot ? Math.round((P.hits / tot) * 100) + "%" : "–";
    $("#fScore").innerHTML = `<b>${P.hits}</b> bien · <b>${P.misses}</b> errores`;
    const latin = $("#optLatin").checked, fifths = player.keyNow().fifths;
    let html = "";
    if (!P.tracks().length) html = "Elegí arriba qué parte vas a tocar.";
    else if (P.waiting) {
      const need = [...P.required].filter(p => !P.got.has(p)).sort((a, b) => a - b)
        .map(p => noteName(p, fifths, latin, true));
      html = `Tocá: <span class="need">${need.join(" + ")}</span>`;
      if (P.wrong && performance.now() - P.wrong.t < 2500) html += ` <span class="bad">· ${P.wrong.text}</span>`;
    } else if (P.idx >= P.steps.length && P.steps.length) {
      html = `<span class="ok">¡Terminaste!</span>`;
    } else if (P.feedback) {
      html = `<span class="${P.feedback === "¡Bien!" ? "ok" : "bad"}">${P.feedback}</span>`;
    } else if (!engine.playing) {
      html = focusMode.touch ? "Tocá ▶ (o la pantalla) y tocá las notas cuando lleguen a la línea."
        : "Dale ▶ (o espacio) y tocá las notas cuando lleguen a la línea.";
    }
    $("#pStatus").innerHTML = $("#fStatus").innerHTML = html;
    $("#fNeed").innerHTML = html;
    $("#fNeed").hidden = !html;
  },

  micLevel(db) {
    const el = $("#pMeter");
    if (el) el.style.width = Math.max(0, Math.min(100, (db / 50) * 100)) + "%";
  },

  updateTime() {
    if (!player.data || $("#player").hidden) return;
    const t = engine.time(), d = player.data.duration || 1;
    $("#tNow").textContent = fmtTime(t);
    if (focusMode.on) {
      $("#fTime").textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
      $("#fNow").textContent = fmtTime(t);
    }
    const pct = Math.min(100, (t / d) * 100);
    $("#seekFill").style.width = pct + "%";
    $("#seekHead").style.left = pct + "%";
    const L = player.loop, sl = $("#seekLoop");
    if (L.a != null) {
      const b = L.b ?? t;
      sl.hidden = false;
      sl.style.left = (Math.min(L.a, b) / d) * 100 + "%";
      sl.style.width = (Math.abs(b - L.a) / d) * 100 + "%";
    } else sl.hidden = true;
    sheet.follow();
    if (focusMode.on) {
      $("#fProgFill").style.width = pct + "%";
      // Practicando y en pausa (no esperando una nota): pantalla oscura con
      // un play grande en el medio, como en Artie.
      const paused = practice.on && !engine.playing && !practice.waiting && $("#summary").hidden;
      if (paused !== !$("#pauseOv").hidden) $("#pauseOv").hidden = !paused;
    } else if (!$("#pauseOv").hidden) $("#pauseOv").hidden = true;
  },
};

/* =====================================================================
   Pantalla completa: solo las notas (o la partitura), sin menus
   ===================================================================== */
const focusMode = {
  on: false, timer: null,
  // iPad y celulares: Safari puede cerrar su pantalla completa al tocar la
  // pantalla; entonces este modo NO se cierra con ella (antes si, y se salia
  // de la practica) y el proximo toque la vuelve a pedir.
  touch: matchMedia("(hover: none) and (pointer: coarse)").matches
    || (navigator.maxTouchPoints > 1 && /iPad|Macintosh/.test(navigator.userAgent)),

  fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; },

  // Pedirle al navegador la pantalla completa (sin la barra de Safari).
  askFs() {
    const el = document.documentElement;
    try {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      if (r && r.catch) r.catch(() => {});
    } catch { /* el navegador no lo permite */ }
  },

  toggle(v = !this.on) {
    this.on = v;
    document.body.classList.toggle("focus", v);
    document.body.classList.remove("idle");
    $("#focusBtn").innerHTML = `<svg class="ic"><use href="#i-${v ? "shrink" : "expand"}"/></svg>`;
    $("#side").classList.remove("open");
    // Ademas se pide al navegador la pantalla completa de verdad (sin barras).
    // En la app instalada del iPad no hace falta: ya no tiene barras.
    const el = document.documentElement;
    try {
      if (v && !this.fsElement()) {
        const r = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
        if (r && r.catch) r.catch(() => {});
      } else if (!v && this.fsElement()) {
        const r = (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        if (r && r.catch) r.catch(() => {});
      }
    } catch { /* el navegador no lo permite: igual quedan ocultos los menus */ }
    this.syncView();
    this.syncPractice();
    this.poke();
    requestAnimationFrame(() => roll.resize());
  },

  // Practicando, la barra de arriba queda siempre a la vista (lo que hay que
  // tocar, cómo vas, velocidad) y el cartel flotante no hace falta.
  syncPractice() {
    document.body.classList.toggle("practicing", this.on && practice.on);
    if (player.data) {
      // Titulo y autor: de la biblioteca si la cancion vino de ahi (no se adivinan de un nombre).
      const added = catalog.added(), catId = Object.keys(added).find(k => added[k] === player.id);
      const o = catId && catalog.items && catalog.items.find(x => x.id === catId);
      $("#fTitle").textContent = o ? o.title : player.data.title;
      $("#fSub").textContent = o ? o.composer : "Tu canción";
      $("#fDur").textContent = fmtTime(player.data.duration);
    }
    $("#fExit").lastChild.textContent = practice.on ? " Terminar" : " Salir";
    if (player.data) player.computeRange();
  },

  // Muestra los controles y los vuelve a esconder si no se toca nada.
  poke() {
    if (!this.on || practice.on) return;
    document.body.classList.remove("idle");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => document.body.classList.add("idle"), 2600);
  },

  syncView() {
    $$("#fView button").forEach(b => b.classList.toggle("on", b.dataset.view === player.view));
  },

  init() {
    $("#focusBtn").onclick = () => this.toggle();
    $("#fExit").onclick = () => (practice.on ? practice.stop(true) : this.toggle(false));
    $("#fPlay").onclick = () => engine.toggle();
    $("#fSpDown").onclick = () => $("#spDown").click();
    $$("#fHands button").forEach(b => (b.onclick = () => applyHands(b.dataset.h)));
    // Repetir parte: la parte de 4 compases donde estas (otra vez = dejar de repetir).
    $("#fLoop").onclick = () => {
      const L = player.loop;
      if (L.a != null) {
        L.a = L.b = null; L.stage = 0;
      } else {
        const t = engine.time(), secs = learn.sections();
        const s = secs.find(x => t >= x.a - 0.05 && t < x.b) || secs[0];
        if (!s) return;
        L.a = Math.max(0, s.a - 0.3); L.b = s.b; L.stage = 2;
        if (t < L.a || t >= L.b) engine.seek(L.a);
      }
      $("#loopBtn").classList.toggle("on", L.a != null);
      $("span", $("#loopBtn")).textContent = L.a != null ? "Quitar bucle" : "Bucle";
      syncLoopBtn();
    };
    const prog = $(".f-prog");
    const seekTo = e => {
      const r = prog.getBoundingClientRect();
      engine.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (player.data?.duration || 0));
    };
    prog.onpointerdown = e => {
      e.stopPropagation();
      this.wasPlaying = engine.playing;
      engine.pause();
      seekTo(e);
      try { prog.setPointerCapture(e.pointerId); } catch { /* nada */ }
      prog.onpointermove = seekTo;
    };
    prog.onpointerup = () => { prog.onpointermove = null; if (this.wasPlaying) engine.play(); };
    $("#fSrc").onclick = () => {
      const all = $$("#pSrc button").map(b => b.dataset.src);
      practice.setSource(all[(all.indexOf(practice.source) + 1) % all.length]);
    };
    const resume = e => { e.stopPropagation(); engine.play(); if (this.touch && !this.fsElement()) this.askFs(); };
    $("#poPlay").onclick = resume;
    $("#poExit").onclick = e => { e.stopPropagation(); practice.stop(true); };
    $("#pauseOv").onclick = resume;
    $("#fSpUp").onclick = () => $("#spUp").click();
    $$("#fView button").forEach(b => (b.onclick = () => { setView(b.dataset.view); this.syncView(); }));
    // Si se sale con Esc o el gesto del sistema, salir tambien del modo.
    const onFs = () => { if (this.on && !this.fsElement() && !this.touch) this.toggle(false); };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      document.addEventListener(ev, () => this.poke(), { passive: true });
    }
    document.addEventListener("keydown", e => {
      if ($("#player").hidden || e.target.closest("input[type=text], input[type=url], select, textarea")) return;
      if (e.code === "Escape" && this.on) this.toggle(false);
      // La F tambien es una tecla del piano de la compu en la practica.
      else if (e.code === "KeyF" && !practice.on && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
    });
  },
};

function initPlayer() {
  roll.init();
  focusMode.init();
  $("#playBtn").onclick = () => engine.toggle();

  const seek = $("#seek");
  const seekTo = e => {
    const r = seek.getBoundingClientRect();
    engine.seek(((e.clientX - r.left) / r.width) * (player.data?.duration || 0));
  };
  seek.onpointerdown = e => {
    seekTo(e);
    seek.setPointerCapture(e.pointerId);
    seek.onpointermove = seekTo;
  };
  seek.onpointerup = () => (seek.onpointermove = null);

  $("#speedSel").onchange = e => { engine.setSpeed(+e.target.value); syncSpeed(); };
  const stepSpeed = d => {
    const sel = $("#speedSel"), i = sel.selectedIndex + d;
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    engine.setSpeed(+sel.value);
    syncSpeed();
  };
  $("#spDown").onclick = () => stepSpeed(-1);
  $("#spUp").onclick = () => stepSpeed(1);
  $("#mix").oninput = e => engine.setMix(+e.target.value);

  const setTr = d => {
    player.transpose = Math.max(-12, Math.min(12, player.transpose + d));
    computeFingers();
    $("#trVal").textContent = (player.transpose > 0 ? "+" : "") + player.transpose;
    $("#transposeNote").hidden = player.transpose === 0 || +$("#mix").value >= 90;
    engine.stopVoices();
    engine.scheduledUntil = engine.time();
    player.computeRange();
    renderChips();
    if (practice.on) practice.build();
    sheet.invalidate();
    if (player.view === "sheet") sheet.show();
  };
  $("#trUp").onclick = () => setTr(1);
  $("#trDown").onclick = () => setTr(-1);
  $("#mix").addEventListener("change", () => {
    $("#transposeNote").hidden = player.transpose === 0 || +$("#mix").value >= 90;
  });

  $("#metroBtn").onclick = e => {
    player.metronome = !player.metronome;
    e.currentTarget.classList.toggle("on", player.metronome);
    $("span", e.currentTarget).textContent = player.metronome ? "Encendido" : "Apagado";
    engine.scheduledUntil = engine.time();
  };

  $("#loopBtn").addEventListener("click", () => setTimeout(syncLoopBtn));
  $("#loopBtn").onclick = e => {
    const L = player.loop, btn = e.currentTarget;
    if (L.stage === 0) {
      L.a = engine.time(); L.b = null; L.stage = 1;
      btn.classList.add("on"); $("span", btn).textContent = "Marcar fin";
      toast("Inicio del bucle marcado. Tocá de nuevo para marcar el final.");
    } else if (L.stage === 1) {
      let b = engine.time();
      if (b < L.a) [L.a, b] = [b, L.a];
      if (b - L.a < 0.3) b = L.a + 2;
      L.b = b; L.stage = 2;
      $("span", btn).textContent = "Quitar bucle";
      engine.seek(L.a);
    } else {
      L.a = L.b = null; L.stage = 0;
      btn.classList.remove("on"); $("span", btn).textContent = "Bucle";
    }
  };

  $$("#viewTabs button").forEach(b => (b.onclick = () => setView(b.dataset.view)));
  $("#pgPrev").onclick = () => sheet.goPage(-1);
  $("#pgNext").onclick = () => sheet.goPage(1);

  $("#sideBtn").onclick = e => { e.stopPropagation(); $("#side").classList.toggle("open"); };
  $("#sideClose").onclick = () => $("#side").classList.remove("open");

  // Manos: cual tocás vos (la otra suena sola).
  $$("#handSeg button").forEach(b => (b.onclick = () => applyHands(b.dataset.h)));
  $("#stage").addEventListener("pointerdown", () => $("#side").classList.remove("open"));

  $("#practiceBtn").onclick = () => {
    if (practice.on) practice.stop(true);
    else {
      $("#side").classList.remove("open");
      intro.show();
    }
  };
  intro.init();
  $("#pClose").onclick = () => practice.stop(true);
  $("#sumClose").onclick = () => summary.hide();
  $("#sumAgain").onclick = () => summary.again();
  $$("#pSrc button").forEach(b => (b.onclick = () => practice.setSource(b.dataset.src)));
  $("#pSens").oninput = e => (practice.micSens = 38 - +e.target.value);
  $("#pWait").onchange = e => {
    practice.wait = e.target.checked;
    practice.sync();
  };
  $("#pHear").onchange = e => {
    practice.hearMine = e.target.checked;
    engine.stopVoices();
    engine.scheduledUntil = engine.time();
  };
  $("#pEcho").onchange = e => (practice.echo = e.target.checked);
  $("#pRestart").onclick = () => {
    practice.hits = practice.misses = 0;
    practice.feedback = "";
    engine.pause();
    engine.seek(player.loop.a ?? 0);
  };
  // Tocar con el teclado de la compu tambien sirve para probar sin piano:
  // la fila A S D F G H J K son las teclas blancas desde el Do central.
  const PC_KEYS = { KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66, KeyG: 67,
    KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71, KeyK: 72, KeyO: 73, KeyL: 74 };
  document.addEventListener("keydown", e => {
    if (!practice.on || e.repeat || !(e.code in PC_KEYS)) return;
    if (e.target.closest("input[type=text], input[type=url], textarea")) return;
    practice.noteOn(PC_KEYS[e.code] + player.transpose);
  });
  document.addEventListener("keyup", e => {
    if (practice.on && e.code in PC_KEYS) practice.noteOff(PC_KEYS[e.code] + player.transpose);
  });

  $$("#soundSeg button").forEach(b => (b.onclick = () => {
    player.sound = b.dataset.s;
    $$("#soundSeg button").forEach(x => x.classList.toggle("on", x === b));
    engine.stopVoices();
    engine.scheduledUntil = engine.time();
  }));

  $("#optFull").onchange = () => player.computeRange();
  // Nombres en la partitura: en el panel y como boton rapido arriba.
  const syncNamesBtn = () => $("#sheetNamesBtn").classList.toggle("on", $("#optSheetNames").checked);
  const refreshSheet = () => { syncNamesBtn(); if (player.view === "sheet") sheet.show(); };
  const remember = () => {
    try {
      localStorage.setItem("sheetNames", $("#optSheetNames").checked ? "1" : "0");
      localStorage.setItem("latin", $("#optLatin").checked ? "1" : "0");
      localStorage.setItem("fx", $("#optFx").checked ? "1" : "0");
      localStorage.setItem("fingers", $("#optFingers").checked ? "1" : "0");
    } catch { /* sin almacenamiento local */ }
  };
  $("#optFx").onchange = remember;
  $("#optFingers").onchange = remember;
  try {
    if (localStorage.getItem("sheetNames") === "1") $("#optSheetNames").checked = true;
    if (localStorage.getItem("latin") === "0") $("#optLatin").checked = false;
    if (localStorage.getItem("fx") === "0") $("#optFx").checked = false;
    if (localStorage.getItem("fingers") === "0") $("#optFingers").checked = false;
  } catch { /* sin almacenamiento local */ }
  syncNamesBtn();
  $("#optSheetNames").onchange = () => { remember(); refreshSheet(); };
  $("#sheetNamesBtn").onclick = () => {
    $("#optSheetNames").checked = !$("#optSheetNames").checked;
    remember();
    refreshSheet();
  };
  $("#optLatin").onchange = () => {
    remember();
    renderChips();
    if ($("#optSheetNames").checked || $("#optChords").checked || $("#optEasy").checked) refreshSheet();
  };
  // Acordes y partitura facil: en el panel y como botones arriba de la partitura.
  for (const [opt, btn, key] of [["optChords", "sheetChordsBtn", "chords"], ["optEasy", "sheetEasyBtn", "easy"]]) {
    try { const v = localStorage.getItem(key); if (v != null) $("#" + opt).checked = v === "1"; } catch { /* nada */ }
    const sync = () => $("#" + btn).classList.toggle("on", $("#" + opt).checked);
    const changed = () => {
      sync();
      try { localStorage.setItem(key, $("#" + opt).checked ? "1" : "0"); } catch { /* nada */ }
      if (player.view === "sheet") sheet.show();
    };
    $("#" + opt).addEventListener("change", changed);
    $("#" + btn).onclick = () => { $("#" + opt).checked = !$("#" + opt).checked; changed(); };
    sync();
  }

  const setRhythm = async (body) => {
    try {
      const factor = [0.5, 1, 2].includes(body.tempo_factor) ? body.tempo_factor : 1;
      const bpb = body.beats_per_bar >= 2 && body.beats_per_bar <= 7 ? body.beats_per_bar : null;
      player.raw.settings = { tempo_factor: factor, beats_per_bar: bpb };
      await store.putBlob(player.id + ":notes", player.raw);
      const data = songData(player.raw);
      data.tracks = player.data.tracks;
      setData(data);
      sheet.invalidate();
      if (player.view === "sheet") sheet.show();
    } catch (e) { toast(e.message); }
  };
  $$("#tempoSeg button").forEach(b => (b.onclick = () =>
    setRhythm({ tempo_factor: +b.dataset.f, beats_per_bar: +$("#meterSel").value || null })));
  $("#meterSel").onchange = e => setRhythm({
    tempo_factor: player.data.settings?.tempo_factor || 1, beats_per_bar: +e.target.value || null,
  });

  // Exportar es una lista fija dentro de «Más» (antes era un menu que se escondia).
  const menu = {};
  $$("#exportMenu button").forEach(b => (b.onclick = async () => {
    menu.hidden = true;
    try {
      const ids = [...new Set(player.tracks.filter(t => t.visible).map(t => t.id))];
      const base = slug(player.data.title) + (player.transpose ? `_${player.transpose > 0 ? "+" : ""}${player.transpose}` : "");
      let file;
      if (b.dataset.exp === "pdf") {
        if (!player.visibleIds().length) throw new Error("no hay pistas visibles con notas");
        toast("Armando el PDF…", 60000);
        file = new File([await sheetToPdf(sheet.xml())], base + ".pdf", { type: "application/pdf" });
        toast("PDF listo");
      } else if (b.dataset.exp === "xml") {
        file = new File([sheet.xml()], base + ".musicxml", { type: "application/vnd.recordare.musicxml+xml" });
      } else {
        const bytes = buildMidi(player.data, { transpose: player.transpose, aligned: b.dataset.exp === "midi", trackIds: ids });
        file = new File([bytes], base + ".mid", { type: "audio/midi" });
      }
      await saveFile(file);
    } catch (e) { if (e.name !== "AbortError") toast("No se pudo exportar: " + e.message); }
  }));

  document.addEventListener("keydown", e => {
    if ($("#player").hidden || e.target.closest("input[type=text], input[type=url], select, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); engine.toggle(); }
    else if (e.code === "ArrowLeft") engine.seek(engine.time() - 5);
    else if (e.code === "ArrowRight") engine.seek(engine.time() + 5);
    else if (e.code === "Home") engine.seek(0);
  });
}

/* =====================================================================
   Navegacion
   ===================================================================== */
function route() {
  const m = location.hash.match(/^#\/cancion\/([\w-]+)/);
  if (m) {
    $("#home").hidden = true;
    $("#player").hidden = false;
    if (player.id !== m[1]) openSong(m[1]);
    else checkResume(m[1]);                // la misma que ya estaba abierta
    requestAnimationFrame(() => roll.resize());
  } else {
    engine.pause();
    if (focusMode.on) focusMode.toggle(false);
    intro.hide();
    $("#player").hidden = true;
    $("#home").hidden = false;
    refreshJobs();
    catalog.refreshShared();
  }
}

// Para la prueba de humo (humo.js) y para diagnosticar desde la consola.
window.__app = { player, engine, sheet, practice, roll, setView, focusMode, piano, summary, progress, learn, backup, catalog };

(async function main() {
  initPlayer();
  // Service worker: la app y los modelos quedan guardados y anda sin internet.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker:", e));
  }
  try { await initHome(); } catch (e) { toast("No se pudo abrir la biblioteca: " + e.message); }
  window.addEventListener("hashchange", route);
  route();
  // El piano se prepara en segundo plano apenas abre la app: asi la primera
  // cancion ya suena con el piano bueno y sin tirones mientras carga.
  setTimeout(() => { try { engine.init(); } catch { /* sin audio */ } }, 1200);
})();
