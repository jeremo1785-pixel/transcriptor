import { store } from "./js/store.js";
import { applyRhythm, assignHands } from "./js/analysis.js";
import { buildMusicXml, buildMidi } from "./js/notation.js";

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
const MODE_LABEL = { piano: "Piano solo", melodia: "Melodía", banda: "Banda completa" };

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
  });

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

  // Lo que quedo a medias (se cerro la app mientras procesaba) se retoma solo.
  for (const s of await store.list()) {
    if (s.status === "queued" || s.status === "working") enqueue(s.id);
  }
}

function setFile(f) {
  home.file = f || null;
  $("#fileName").textContent = f ? `✓ ${f.name}` : "";
}

async function toggleRecording() {
  const btn = $("#recBtn");
  if (home.recorder) {
    home.recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
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
  return meta.title;
}

async function submitNew() {
  const mode = ($("input[name=mode]:checked") || {}).value || "piano";
  const msg = $("#newMsg"), btn = $("#goBtn");
  msg.className = "msg";
  msg.textContent = "";
  btn.disabled = true;
  try {
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

async function refreshJobs() {
  const list = await store.list();
  const ul = $("#jobs");
  $("#emptyLib").hidden = list.length > 0;
  ul.innerHTML = list.map(j => {
    const busy = j.status === "queued" || j.status === "working";
    const l = queue.live[j.id] || j;
    return `
      <li class="job ${j.status}" data-id="${j.id}">
        <div class="job-title">${esc(j.title)}</div>
        <div class="job-actions">
          ${(j.status === "error" || j.status === "ready") && j.mode === "piano" ? `<button class="ghost retry" title="Volver a transcribir">↻</button>` : ""}
          <button class="icon del" title="Borrar">✕</button>
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

const engine = {
  ctx: null, audio: null, origGain: null, synthGain: null, metroGain: null,
  playing: false, speed: 1, anchorCtx: 0, anchorMedia: 0,
  scheduledUntil: 0, voices: [], timer: null,
  instruments: {}, loading: {}, noise: null,

  init() {
    if (this.ctx) return;
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
    this.scheduledUntil = 0;
  },

  // Tiempo de la grabacion. El reloj del AudioContext es mucho mas fino que
  // audio.currentTime, asi que se interpola desde el ultimo punto de anclaje.
  time() {
    if (!this.audio) return 0;
    if (!this.playing) return this.audio.currentTime;
    return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx) * this.speed;
  },

  anchor() {
    this.anchorCtx = this.ctx.currentTime;
    this.anchorMedia = this.audio.currentTime;
  },

  async play() {
    this.init();
    await this.ctx.resume();
    try { await this.audio.play(); } catch (e) { toast("No se pudo reproducir: " + e.message); return; }
    this.playing = true;
    this.anchor();
    this.scheduledUntil = this.audio.currentTime;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 25);
    ui.onPlayState(true);
  },

  pause() {
    if (!this.audio) return;
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
    this.audio.currentTime = t;
    this.anchorCtx = this.ctx ? this.ctx.currentTime : 0;
    this.anchorMedia = t;
    this.scheduledUntil = t;
    practice.sync();
  },

  setSpeed(s) {
    this.speed = s;
    if (!this.audio) return;
    const t = this.time();
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
  },

  stopVoices() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.voices) { try { v.stop(now); } catch { /* ya termino */ } }
    this.voices = [];
  },

  tick() {
    const now = this.time();
    // Corrige la deriva contra la posicion real del reproductor.
    if (Math.abs(this.audio.currentTime - now) > 0.12 && !this.audio.seeking) {
      this.anchor();
    }
    if (practice.check(now)) return;
    const L = player.loop;
    if (L.a != null && L.b != null && now >= L.b) {
      this.seek(L.a);
      return;
    }
    const horizon = now + 0.18 * this.speed;
    const from = this.scheduledUntil;
    if (horizon <= from) return;
    const base = this.ctx.currentTime;
    const at = t => base + Math.max(0, (t - now) / this.speed);

    for (const tr of player.tracks) {
      if (!player.audible(tr)) continue;
      if (practice.on && tr.practice && !practice.hearMine) continue; // esa parte la tocas vos
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
    const inst = this.instrumentFor({ program: 0 });
    if (!inst) return;
    this.stopLive(pitch);
    const node = inst.play(pitch, this.ctx.currentTime, { gain: 1.1, duration: 8 });
    if (node) practice.live.set(pitch, node);
  },

  stopLive(pitch) {
    const node = practice.live.get(pitch);
    if (node) { try { node.stop(this.ctx.currentTime + 0.05); } catch { /* ya termino */ } }
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
    if ($("#optFull").checked) { this.range = [21, 108]; return; }
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
  renderTracks();
  player.computeRange();
  if (player.audioUrl) URL.revokeObjectURL(player.audioUrl);
  player.audioUrl = URL.createObjectURL(audio);
  engine.load(player.audioUrl);
  engine.setMix(+$("#mix").value);
  engine.setSpeed(+$("#speedSel").value);
  $("#tEnd").textContent = fmtTime(data.duration);
  sheet.invalidate();
  setView(player.view);
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
  if (Math.abs(d.tuning_cents) >= 8) {
    chips.push(`Afinación <b>${d.tuning_cents > 0 ? "+" : ""}${d.tuning_cents}</b> cents <span title="La grabación no está en La 440; se corrigió al transcribir">ⓘ</span>`);
  }
  $("#pChips").innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join("");
}

function renderTracks() {
  const ul = $("#tracks");
  ul.innerHTML = player.tracks.map((t, i) => `
    <li class="track ${t.visible ? "" : "hidden"}" data-i="${i}">
      <span class="dot" style="background:${t.color}"></span>
      <span class="name">${esc(t.label)}<small>${t.hand != null ? "Piano · " : ""}${t.notes.length} notas</small></span>
      ${t.id === "drums" ? "" : `<button class="tbtn v ${t.visible ? "" : "off-v"}" title="Mostrar / ocultar">👁</button>`}
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
  $("#sheetNamesBtn").hidden = v !== "sheet";
  if (v === "sheet") sheet.show();
}

/* =====================================================================
   Notas cayendo
   ===================================================================== */
const roll = {
  canvas: null, g: null, w: 0, h: 0, dpr: 1,

  init() {
    this.canvas = $("#roll");
    this.g = this.canvas.getContext("2d");
    new ResizeObserver(() => this.resize()).observe($("#stage"));
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
      drag = null;
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    const loop = () => { this.draw(); ui.updateTime(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },

  resize() {
    const r = $("#stage").getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  },

  keyLayout() {
    const [lo, hi] = player.range;
    const isBlack = p => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    let whites = 0;
    for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites++;
    const ww = this.w / whites, keys = {};
    let x = 0;
    for (let p = lo; p <= hi; p++) {
      if (isBlack(p)) keys[p] = { x: x - ww * 0.3, w: ww * 0.6, black: true };
      else { keys[p] = { x, w: ww, black: false }; x += ww; }
    }
    return { keys, ww };
  },

  draw() {
    if (!player.data || player.view !== "roll" || $("#player").hidden) return;
    const g = this.g, W = this.w, H = this.h;
    if (!W || !H) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = "#0a0d13";
    g.fillRect(0, 0, W, H);

    const t = engine.time();
    const pps = +$("#zoom").value;
    const kbH = Math.max(64, Math.min(130, H * 0.17));
    const hit = H - kbH;
    const { keys, ww } = this.keyLayout();
    const tTop = t + hit / pps;
    const latin = $("#optLatin").checked, names = $("#optNames").checked;
    const fifths = player.keyNow().fifths;

    // Carriles: una linea tenue en cada Do y fondo algo mas claro en las negras.
    for (const [p, k] of Object.entries(keys)) {
      if (k.black) { g.fillStyle = "rgba(255,255,255,0.018)"; g.fillRect(k.x, 0, k.w, hit); }
      if (+p % 12 === 0) { g.fillStyle = "rgba(255,255,255,0.07)"; g.fillRect(k.x, 0, 1, hit); }
    }

    // Pulsos y compases.
    const beats = player.data.beats;
    const shift = player.barShift(), bpb = player.data.beats_per_bar;
    g.font = "11px system-ui";
    for (let i = lowerBound(beats, t, x => x); i < beats.length && beats[i] <= tTop; i++) {
      const y = hit - (beats[i] - t) * pps;
      const isDown = player.downSet.has(i);
      g.fillStyle = isDown ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.045)";
      g.fillRect(0, y, W, 1);
      if (isDown) {
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.fillText(String(Math.floor((i + shift) / bpb) + 1), 4, y - 3);
      }
    }

    // Notas. Primero las de teclas blancas y despues las de negras, que quedan
    // encima; cada una con borde oscuro y un respiro arriba, para que un acorde
    // de teclas vecinas o la misma nota repetida no se vean como un solo bloque.
    const active = {};
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
        if (on) active[p] = tr.color;
        const top = Math.max(0, y0), bot = Math.min(hit, y1);
        if (bot - top < 1) continue;
        items.push({ k, p, top, bot, on, dim, color: tr.color, clipped: y0 < 0 });
      }
    }
    items.sort((a, b) => a.k.black - b.k.black);
    const fs = Math.min(12, ww * 0.42);
    for (const it of items) {
      const { k } = it;
      const pad = k.black ? 1 : 2;
      const x = k.x + pad, w = k.w - pad * 2;
      const y = it.clipped ? it.top : it.top + 2;
      const h = it.bot - y;
      if (h < 1) continue;
      const r = Math.min(4, w / 3);
      g.globalAlpha = it.dim ? 0.4 : 1;
      if (it.on) { g.shadowColor = it.color; g.shadowBlur = 12; }
      g.fillStyle = it.color;
      roundRect(g, x, y, w, h, r);
      g.fill();
      g.shadowBlur = 0;
      if (k.black) { g.fillStyle = "rgba(0,0,0,0.3)"; g.fill(); }
      g.lineWidth = it.on ? 2 : 1.5;
      g.strokeStyle = it.on ? "rgba(255,255,255,0.9)" : "rgba(6,8,12,0.95)";
      g.stroke();
      if (names && h > 16 && w > 11) {
        g.fillStyle = k.black ? "rgba(255,255,255,0.92)" : "rgba(10,13,19,0.85)";
        g.font = `600 ${k.black ? fs * 0.85 : fs}px system-ui`;
        g.textAlign = "center";
        g.fillText(noteName(it.p, fifths, latin), x + w / 2, it.bot - 5);
        g.textAlign = "left";
      }
      g.globalAlpha = 1;
    }

    // Linea de golpe (en practica, ambar mientras espera que toques).
    g.fillStyle = practice.waiting ? "rgba(242,181,68,0.95)" : "rgba(108,140,255,0.8)";
    g.fillRect(0, hit - 2, W, practice.waiting ? 3 : 2);

    // Teclado. En practica: lo que tocas en verde, un error en rojo y las
    // teclas que se esperan con un recuadro que titila.
    const now = performance.now();
    const keyFill = (p, base) => {
      if (practice.flash.has(p) && practice.flash.get(p) > now) return "#ff5d73";
      if (practice.held.has(p)) return "#43d17a";
      return active[p] || base;
    };
    for (const [p, k] of Object.entries(keys)) {
      if (k.black) continue;
      g.fillStyle = keyFill(+p, "#eef0f4");
      g.fillRect(k.x + 0.5, hit, k.w - 1, kbH);
      if (+p % 12 === 0 && k.w > 14) {
        g.fillStyle = active[p] ? "#fff" : "#8a93a6";
        g.font = "10px system-ui";
        g.textAlign = "center";
        g.fillText(noteName(+p, 0, latin, true), k.x + k.w / 2, H - 6);
        g.textAlign = "left";
      }
    }
    for (const [p, k] of Object.entries(keys)) {
      if (!k.black) continue;
      g.fillStyle = keyFill(+p, "#1b1f27");
      g.fillRect(k.x, hit, k.w, kbH * 0.62);
    }
    if (practice.waiting) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 160);
      g.lineWidth = 3;
      for (const p of practice.required) {
        const k = keys[p];
        if (!k) continue;
        g.strokeStyle = practice.got.has(p) ? "rgba(67,209,122,0.95)" : `rgba(242,181,68,${pulse})`;
        g.strokeRect(k.x + 2, hit + 2, k.w - 4, (k.black ? kbH * 0.62 : kbH) - 4);
      }
    }
  },
};

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
    return JSON.stringify([player.id, player.transpose, player.visibleIds(), player.data.settings, this.names()]);
  },

  xml() {
    const ids = player.visibleIds();
    return buildMusicXml(player.data, {
      transpose: player.transpose,
      trackIds: ids.length !== player.allIds().length ? ids : null,
      names: this.names(),
    });
  },

  async show() {
    const url = this.url();
    if (this.key === url) return;
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    const msg = $("#sheetMsg"), div = $("#sheet");
    msg.textContent = "Armando la partitura…";
    try {
      if (!player.visibleIds().length) throw new Error("No hay pistas visibles con notas para mostrar.");
      const xml = this.xml();
      if (!this.osmd) {
        this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(div, {
          autoResize: true, backend: "svg", drawTitle: true, drawSubtitle: false, drawComposer: false,
          drawPartNames: true, followCursor: true, drawingParameters: "default", autoBeam: true,
        });
      }
      await this.osmd.load(xml);
      msg.textContent = "Dibujando…";
      await new Promise(r2 => setTimeout(r2, 20));
      this.osmd.render();
      this.osmd.cursor.show();
      this.buildTimes();
      this.key = url;
      msg.textContent = "";
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      this.loading = false;
      if (this.pending) { this.pending = false; if (player.view === "sheet") this.show(); }
    }
  },

  // Tiempo (en segundos de la grabacion) de cada posicion del cursor.
  buildTimes() {
    const c = this.osmd.cursor, shift = player.barShift();
    // Si el primer compas es una anacrusa, OSMD empieza a contar desde ahi,
    // pero en nuestra grilla ese compas empieza 'lead' pulsos mas tarde.
    const m0 = this.osmd.Sheet.SourceMeasures[0];
    let lead = 0;
    if (m0 && m0.Duration && m0.ActiveTimeSignature) {
      const actual = m0.Duration.RealValue * 4, full = m0.ActiveTimeSignature.RealValue * 4;
      if (actual < full - 1e-6) lead = full - actual;
    }
    this.osmd.FollowCursor = false;   // si no, recorrerlo scrollea hasta el final
    c.reset();
    this.times = [];
    let guard = 0;
    while (!c.iterator.EndReached && guard++ < 100000) {
      const quarters = c.iterator.currentTimeStamp.RealValue * 4;
      this.times.push(player.beatToTime(quarters + lead - shift));
      c.next();
    }
    c.reset();
    this.idx = 0;
    this.osmd.FollowCursor = true;
    $("#sheetWrap").scrollTop = 0;
  },

  follow() {
    if (!this.osmd || this.key == null || player.view !== "sheet" || !this.times.length) return;
    const t = engine.time();
    let target = lowerBound(this.times, t + 0.03, x => x) - 1;
    target = Math.max(0, target);
    if (target === this.idx) return;
    const c = this.osmd.cursor;
    if (target < this.idx) { c.reset(); this.idx = 0; }
    while (this.idx < target) { c.next(); this.idx++; }
  },
};

/* =====================================================================
   Practica con un piano real (teclado MIDI o microfono)
   ===================================================================== */
const practice = {
  on: false, wait: true, hearMine: false, echo: false, source: "midi",
  steps: [], idx: 0, waiting: false,
  required: new Set(), got: new Set(), held: new Map(), flash: new Map(),
  recent: [], hits: 0, misses: 0, savedMix: null, feedback: "", device: "",
  midi: null, live: new Map(),
  mic: null, micSens: 18,

  tracks() { return player.tracks.filter(t => t.practice); },

  // Pasos a tocar: las notas de las pistas elegidas, agrupadas en acordes
  // (lo que empieza con menos de 60 ms de diferencia se toca junto).
  build() {
    const all = [];
    for (const tr of this.tracks()) for (const n of tr.notes) all.push(n);
    all.sort((a, b) => a[0] - b[0]);
    const steps = [];
    for (const [s, , p] of all) {
      const last = steps[steps.length - 1];
      if (last && s - last.t < 0.06) last.pitches.add(p + player.transpose);
      else steps.push({ t: s, pitches: new Set([p + player.transpose]) });
    }
    this.steps = steps;
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
  },

  pass(resume) {
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
    if (!fromMic && !early && (this.waiting || !this.wait)) {
      this.misses++;
      this.feedback = "Esa no";
      this.flash.set(p, now + 350);
      ui.practiceStatus();
    }
  },

  noteOff(p) {
    this.held.delete(p);
    engine.stopLive(p);
  },

  async start() {
    this.on = true;
    this.hits = this.misses = 0;
    this.feedback = "";
    if (!this.tracks().length) {
      const hands = player.tracks.filter(t => t.hand != null);
      const first = player.tracks.find(t => t.id !== "drums");
      (hands.length ? hands : first ? [first] : []).forEach(t => (t.practice = true));
    }
    if (this.wait) {
      // Frenar y seguir en cada nota corta la grabacion original a cada rato:
      // en la practica se escucha solo el acompanamiento sintetizado.
      this.savedMix = +$("#mix").value;
      $("#mix").value = 100;
      engine.setMix(100);
    }
    this.build();
    ui.practicePanel();
    await this.setSource(this.source);
  },

  stop() {
    this.on = false;
    this.waiting = false;
    this.required = new Set();
    this.stopMic();
    if (this.savedMix != null) {
      $("#mix").value = this.savedMix;
      engine.setMix(this.savedMix);
      this.savedMix = null;
    }
    ui.practicePanel();
  },

  async setSource(src) {
    this.source = src;
    if (src === "midi") { this.stopMic(); await this.initMidi(); }
    else await this.initMic();
    ui.practicePanel();
  },

  // ---------------------------------------------------------------- MIDI
  async initMidi() {
    if (!navigator.requestMIDIAccess) {
      this.device = "Este navegador no tiene MIDI. En la PC usá Chrome o Edge; en iPad, el micrófono.";
      return;
    }
    if (!this.midi) {
      try {
        this.midi = await navigator.requestMIDIAccess();
      } catch (e) {
        this.device = "El navegador bloqueó el MIDI. Tocá el candado 🔒 junto a la dirección, "
          + "permití «Dispositivos MIDI» y volvé a tocar «Teclado MIDI».";
        return;
      }
      this.midi.onstatechange = () => { this.bindMidi(); ui.practicePanel(); };
    }
    this.bindMidi();
  },

  bindMidi() {
    const inputs = [...this.midi.inputs.values()];
    for (const inp of inputs) inp.onmidimessage = e => this.onMidi(e);
    this.device = inputs.length
      ? "Conectado: " + inputs.map(i => i.name).join(", ")
      : "No veo ningún teclado MIDI. Conectalo por USB: se detecta solo al enchufarlo.";
  },

  onMidi(e) {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) this.noteOn(d1);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.noteOff(d1);
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
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
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
    const sal = new Float32Array(128).fill(-200);
    for (let p = 21; p <= 108; p++) {
      const f0 = 440 * Math.pow(2, (p - 69) / 12);
      const hs = [peak(f0), peak(2 * f0), peak(3 * f0)].sort((a, b) => b - a);
      sal[p] = (hs[0] + hs[1]) / 2;
    }
    m.hist.push(sal);
    if (m.hist.length > 7) m.hist.shift();

    // Se escucha lo que se espera ahora y, si todavia no llego a la linea, el
    // paso siguiente (por si se toca un poquito antes).
    const cand = new Set(this.required);
    const next = this.steps[this.idx + (this.required.size ? 1 : 0)];
    if (next && !this.waiting && next.t - engine.time() < 0.2) next.pitches.forEach(p => cand.add(p));
    const now = performance.now();
    for (const p of cand) {
      if (p < 21 || p > 108) continue;
      let prevMin = Infinity;
      for (let i = 0; i < m.hist.length - 1; i++) prevMin = Math.min(prevMin, m.hist[i][p]);
      if (!isFinite(prevMin)) continue;
      const v = sal[p];
      const attack = v - prevMin > 8;                          // golpe nuevo, no algo que ya sonaba
      const loud = v - floor > this.micSens;                    // por encima del ruido
      const own = v > Math.max(sal[p - 1], sal[p + 1]) + 3;      // es esta tecla y no la de al lado
      if (attack && loud && own && now - (m.last.get(p) || 0) > 250) {
        m.last.set(p, now);
        this.noteOn(p, true);
        setTimeout(() => this.held.delete(p), 220);
      }
    }
    ui.micLevel(mx - floor);
  },
};

/* =====================================================================
   Controles
   ===================================================================== */
const ui = {
  onPlayState(p) {
    $("#playBtn").textContent = p ? "❚❚" : "▶";
    this.practiceStatus();
  },

  sfStatus(t) { $("#sfStatus").textContent = t; },

  practicePanel() {
    const P = practice;
    $("#practicePanel").hidden = !P.on;
    $("#practiceBtn").classList.toggle("on", P.on);
    if (!P.on) return;
    $$("#pSrc button").forEach(b => b.classList.toggle("on", b.dataset.src === P.source));
    $("#pDev").textContent = P.device || "";
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
    this.practiceStatus();
  },

  practiceStatus() {
    if (!practice.on) return;
    const P = practice;
    $("#pHits").textContent = P.hits;
    $("#pMiss").textContent = P.misses;
    const tot = P.hits + P.misses;
    $("#pPct").textContent = tot ? Math.round((P.hits / tot) * 100) + "%" : "–";
    const latin = $("#optLatin").checked, fifths = player.keyNow().fifths;
    let html = "";
    if (!P.tracks().length) html = "Elegí arriba qué parte vas a tocar.";
    else if (P.waiting) {
      const need = [...P.required].filter(p => !P.got.has(p)).sort((a, b) => a - b)
        .map(p => noteName(p, fifths, latin, true));
      html = `Tocá: <span class="need">${need.join(" + ")}</span>`;
    } else if (P.idx >= P.steps.length && P.steps.length) {
      html = `<span class="ok">¡Terminaste!</span>`;
    } else if (P.feedback) {
      html = `<span class="${P.feedback === "¡Bien!" ? "ok" : "bad"}">${P.feedback}</span>`;
    } else if (!engine.playing) {
      html = "Dale ▶ (o espacio) y tocá las notas cuando lleguen a la línea.";
    }
    $("#pStatus").innerHTML = html;
  },

  micLevel(db) {
    const el = $("#pMeter");
    if (el) el.style.width = Math.max(0, Math.min(100, (db / 50) * 100)) + "%";
  },

  updateTime() {
    if (!player.data || $("#player").hidden) return;
    const t = engine.time(), d = player.data.duration || 1;
    $("#tNow").textContent = fmtTime(t);
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
  },
};

function initPlayer() {
  roll.init();
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

  $("#speedSel").onchange = e => engine.setSpeed(+e.target.value);
  $("#mix").oninput = e => engine.setMix(+e.target.value);

  const setTr = d => {
    player.transpose = Math.max(-12, Math.min(12, player.transpose + d));
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
    engine.scheduledUntil = engine.time();
  };

  $("#loopBtn").onclick = e => {
    const L = player.loop, btn = e.currentTarget;
    if (L.stage === 0) {
      L.a = engine.time(); L.b = null; L.stage = 1;
      btn.classList.add("on"); btn.textContent = "🔁 Marcar fin";
      toast("Inicio del bucle marcado. Tocá de nuevo para marcar el final.");
    } else if (L.stage === 1) {
      let b = engine.time();
      if (b < L.a) [L.a, b] = [b, L.a];
      if (b - L.a < 0.3) b = L.a + 2;
      L.b = b; L.stage = 2;
      btn.textContent = "🔁 Quitar bucle";
      engine.seek(L.a);
    } else {
      L.a = L.b = null; L.stage = 0;
      btn.classList.remove("on"); btn.textContent = "🔁 Bucle";
    }
  };

  $$("#viewTabs button").forEach(b => (b.onclick = () => setView(b.dataset.view)));

  $("#sideBtn").onclick = e => { e.stopPropagation(); $("#side").classList.toggle("open"); };
  $("#stage").addEventListener("pointerdown", () => $("#side").classList.remove("open"));

  $("#practiceBtn").onclick = () => {
    if (practice.on) practice.stop();
    else {
      if (player.view !== "roll") setView("roll");
      $("#side").classList.add("open");
      $("#side").scrollTop = 0;
      practice.start();
    }
  };
  $("#pClose").onclick = () => practice.stop();
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
    } catch { /* sin almacenamiento local */ }
  };
  try {
    if (localStorage.getItem("sheetNames") === "1") $("#optSheetNames").checked = true;
    if (localStorage.getItem("latin") === "0") $("#optLatin").checked = false;
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
    if ($("#optSheetNames").checked) refreshSheet();
  };

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

  const menu = $("#exportMenu");
  $("#exportBtn").onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", () => (menu.hidden = true));
  $$("#exportMenu button").forEach(b => (b.onclick = async () => {
    menu.hidden = true;
    try {
      const ids = [...new Set(player.tracks.filter(t => t.visible).map(t => t.id))];
      const base = slug(player.data.title) + (player.transpose ? `_${player.transpose > 0 ? "+" : ""}${player.transpose}` : "");
      let file;
      if (b.dataset.exp === "xml") {
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
    requestAnimationFrame(() => roll.resize());
  } else {
    engine.pause();
    $("#player").hidden = true;
    $("#home").hidden = false;
    refreshJobs();
  }
}

(async function main() {
  initPlayer();
  // Service worker: la app y los modelos quedan guardados y anda sin internet.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker:", e));
  }
  try { await initHome(); } catch (e) { toast("No se pudo abrir la biblioteca: " + e.message); }
  window.addEventListener("hashchange", route);
  route();
})();
