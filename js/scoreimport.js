// Importar partituras en el iPad: MusicXML (.musicxml, .xml, .mxl) y MIDI (.mid).
// Misma logica que scoreimport.py de la version de PC: las notas exactas de la
// partitura se pasan al formato de una transcripcion (segundos, pistas, pulsos,
// compas, tonalidad) y la app hace lo de siempre. Los PDF necesitan Audiveris,
// que corre en la PC: desde ahi se mandan al iPad ya convertidos.
import { detectKey, keyInfo, MAJOR, MINOR } from "./analysis.js";

export const SCORE_EXTS = [".musicxml", ".xml", ".mxl", ".mid", ".midi"];
const DEFAULT_BPM = 100;
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TRACK_INFO = {
  piano: { label: "Piano", color: "#4f8cff", program: 0 },
  vocals: { label: "Voz", color: "#ff5d73", program: 53 },
  melodia: { label: "Melodía", color: "#ff5d73", program: 73 },
  guitar: { label: "Guitarra", color: "#2ecc8f", program: 25 },
  bass: { label: "Bajo", color: "#a970ff", program: 33 },
  other: { label: "Otros", color: "#f2b544", program: 48 },
  drums: { label: "Batería", color: "#9aa4b2", program: 0 },
};
const TRACK_ORDER = ["vocals", "melodia", "piano", "guitar", "other", "bass", "drums"];
const r4 = x => Math.round(x * 1e4) / 1e4;

// ------------------------------------------------------------------ pistas
export function instrumentTrack(name, program, staves = 1, drums = false) {
  const n = (name || "").toLowerCase();
  const has = (...ws) => ws.some(w => n.includes(w));
  if (drums || has("drum", "percus", "batería", "bateria")) return "drums";
  if (staves >= 2 || has("piano", "organ", "órgano", "organo", "keyboard", "teclado", "klavier", "harpsi", "clave", "celesta")) return "piano";
  if (has("voice", "voz", "vocal", "canto", "soprano", "alto", "tenor", "bariton", "barítono", "mezzo", "choir", "coro") || [52, 53, 54].includes(program)) return "vocals";
  if (has("guitar", "guitarra") || (program != null && program >= 24 && program < 32)) return "guitar";
  if (has("bass", "bajo") || (program != null && program >= 32 && program < 40)) return "bass";
  if (program != null && (program < 8 || (program >= 16 && program < 24))) return "piano";
  if (has("otros", "other")) return "other";
  return "melodia";
}

function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}
const roll = (arr, k) => arr.map((_, i) => arr[(i - k + 12 * 4) % 12]);

// Tonalidad: la de la armadura (y su modo); si falta el modo, mayor o su
// relativa menor segun las notas; si no hay armadura, se detecta.
function histKey(notes, fifths, mode) {
  if (fifths == null) return detectKey([{ id: "x", notes }]);
  const major = (((fifths * 7) % 12) + 12) % 12;
  if (mode === "major" || mode === "minor") return keyInfo(mode === "major" ? major : (major + 9) % 12, mode);
  const hist = new Array(12).fill(0);
  for (const [s, e, p] of notes) hist[p % 12] += Math.min(e - s, 2);
  if (!hist.some(Boolean)) return keyInfo(major, "major");
  const rMaj = corr(hist, roll(MAJOR, major)), rMin = corr(hist, roll(MINOR, (major + 9) % 12));
  return rMaj >= rMin ? keyInfo(major, "major") : keyInfo((major + 9) % 12, "minor");
}

// ------------------------------------------------------------------ armado comun
// parts: [{track, newMelody, notes: [[q0, q1, nota, vel, mano|null]]}] en negras.
export function buildData(title, parts, tempos, bpb, pickup, fifths, mode) {
  const lead = pickup > 0 ? Math.ceil(pickup) - pickup : 0;
  const ts = tempos.filter(([, b]) => b > 0).map(([q, b]) => [q + lead, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const at0 = ts.find(([q]) => q <= lead + 1e-6);
  const first = at0 ? at0[1] : ts.length ? ts[0][1] : DEFAULT_BPM;
  const tmap = [[0, first], ...ts.filter(([q]) => q > lead + 1e-6)];
  const starts = [];
  let acc = 0;
  tmap.forEach(([q], i) => { if (i) acc += (q - tmap[i - 1][0]) * 60 / tmap[i - 1][1]; starts.push(acc); });
  const sec = q => {
    let i = 0;
    for (let k = 0; k < tmap.length; k++) if (tmap[k][0] <= q) i = k;
    return starts[i] + (q - tmap[i][0]) * 60 / tmap[i][1];
  };

  const byId = {};
  for (const part of parts) {
    let tid = part.track;
    if (tid === "melodia" && byId.melodia && part.newMelody) tid = "other";
    (byId[tid] = byId[tid] || []).push(...part.notes);
  }
  let lastQ = 1;
  const tracks = [];
  for (const tid of Object.keys(byId).sort((a, b) => TRACK_ORDER.indexOf(a) - TRACK_ORDER.indexOf(b))) {
    const rows = [...byId[tid]].sort((x, y) => x[0] - y[0] || x[2] - y[2]);
    if (!rows.length) continue;
    lastQ = Math.max(lastQ, Math.max(...rows.map(n => n[1])) + lead);
    const info = TRACK_INFO[tid];
    const t = { id: tid, label: info.label, color: info.color, program: info.program,
      notes: rows.map(([a, b, p, v]) => [r4(sec(a + lead)), r4(sec(b + lead)), p, v]) };
    if (tid === "piano" && rows.every(n => n[4] != null)) t.hands = rows.map(n => n[4]);
    tracks.push(t);
  }
  if (!tracks.length) throw new Error("La partitura no tiene notas");

  const nBeats = Math.ceil(lastQ) + 2;
  const beats = Array.from({ length: nBeats }, (_, k) => r4(sec(k)));
  const fd = pickup > 0 ? Math.ceil(pickup) : 0;
  bpb = Math.max(2, Math.min(7, Math.round(bpb)));
  const rhythm = { beats, downbeats: beats.filter((_, i) => i >= fd && (i - fd) % bpb === 0),
    bpm: Math.round(first * 10) / 10, beats_per_bar: bpb, first_downbeat: fd };
  const all = tracks.filter(t => t.id !== "drums").flatMap(t => t.notes);
  return {
    title, duration: Math.round((sec(lastQ) + 1) * 100) / 100, mode: "partitura", source: "partitura",
    tuning_cents: 0, ...rhythm, rhythm_raw: rhythm, settings: { tempo_factor: 1, beats_per_bar: null },
    key: histKey(all, fifths, mode), tracks,
  };
}

// ------------------------------------------------------------------ MusicXML
// Un .mxl es un zip: se busca el archivo de la partitura y se descomprime.
async function unzipEntry(buf, wanted) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("El .mxl no es un zip válido");
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];
  for (let k = 0; k < n; k++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    entries.push({ name: dec.decode(new Uint8Array(buf, p + 46, nl)), method, size, off });
    p += 46 + nl + el + cl;
  }
  const read = async e => {
    const lnl = v.getUint16(e.off + 26, true), lel = v.getUint16(e.off + 28, true);
    const data = new Uint8Array(buf, e.off + 30 + lnl + lel, e.size);
    if (e.method === 0) return dec.decode(data);
    const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return dec.decode(await new Response(ds).arrayBuffer());
  };
  let name = null;
  const cont = entries.find(e => e.name === "META-INF/container.xml");
  if (cont) { const m = (await read(cont)).match(/full-path="([^"]+)"/); if (m) name = m[1]; }
  const e = entries.find(x => x.name === (name || wanted)) ||
    entries.find(x => /\.(xml|musicxml)$/i.test(x.name) && !x.name.startsWith("META-INF"));
  if (!e) throw new Error("El .mxl no tiene una partitura adentro");
  return read(e);
}

export async function readMusicXml(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x50 && head[1] === 0x4b) return unzipEntry(buf);   // "PK": zip
  return new TextDecoder().decode(buf);
}

const num = (t, d = 0) => { const x = parseFloat(t); return Number.isFinite(x) ? x : d; };
const kids = (el, tag) => [...el.children].filter(c => c.localName === tag);
const kid = (el, tag) => [...el.children].find(c => c.localName === tag) || null;
// Texto de un camino de hijos directos ("key/fifths"), como findtext de Python.
function text(el, path) {
  let cur = el;
  for (const t of path.split("/")) { cur = cur && kid(cur, t); }
  return cur ? cur.textContent : null;
}

export function parseMusicXml(xmlText, fallbackTitle = "Partitura") {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("El archivo MusicXML está dañado");
  const root = doc.documentElement;
  if (root.localName === "score-timewise") throw new Error("Este MusicXML está «por tiempos» (timewise); exportalo «por partes» (partwise)");
  const title = ((text(root, "work/work-title") || text(root, "movement-title") || "").trim()) || fallbackTitle;
  const infos = {};
  const plist = kid(root, "part-list");
  for (const sp of plist ? kids(plist, "score-part") : []) {
    const prog = text(sp, "midi-instrument/midi-program");
    infos[sp.getAttribute("id")] = [(text(sp, "part-name") || "").trim(), prog ? Math.trunc(num(prog)) - 1 : null,
      (text(sp, "midi-instrument/midi-channel") || "") === "10"];
  }
  const tempos = [];
  let fifths = null, mode = null, timeSig = null, measures = null;
  const parts = [];
  for (const part of kids(root, "part")) {
    let div = 1, pos = 0, staves = 1;
    const notes = [], openTies = new Map(), meas = [];
    for (const m of kids(part, "measure")) {
      const start = pos;
      let maxpos = pos, last = pos;
      for (const el of m.children) {
        const tag = el.localName;
        if (tag === "attributes") {
          if (text(el, "divisions")) div = num(text(el, "divisions"), 1) || 1;
          if (text(el, "staves")) staves = Math.max(staves, Math.trunc(num(text(el, "staves"), 1)));
          if (fifths === null && text(el, "key/fifths") !== null) {
            fifths = Math.trunc(num(text(el, "key/fifths")));
            mode = (text(el, "key/mode") || "").trim().toLowerCase() || null;
          }
          if (timeSig === null && text(el, "time/beats")) {
            const beats = text(el, "time/beats").split("+").reduce((a, x) => a + num(x, 0), 0);
            timeSig = [beats, num(text(el, "time/beat-type"), 4) || 4];
          }
        } else if (tag === "direction" || tag === "sound") {
          const snd = tag === "sound" ? el : kid(el, "sound");
          const off = tag === "direction" ? num(text(el, "offset")) / div : 0;
          let bpm = snd ? num(snd.getAttribute("tempo")) : 0;
          if (!bpm && tag === "direction") {
            const dt = kid(el, "direction-type"), met = dt && kid(dt, "metronome");
            if (met && text(met, "per-minute")) {
              let unit = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 }[text(met, "beat-unit") || "quarter"] || 1;
              if (kid(met, "beat-unit-dot")) unit *= 1.5;
              const mm = text(met, "per-minute").match(/[\d.]+/);
              bpm = mm ? num(mm[0]) * unit : 0;
            }
          }
          if (bpm > 0) tempos.push([pos + off, bpm]);
        } else if (tag === "note") {
          if (kid(el, "grace")) continue;
          const dur = num(text(el, "duration")) / div;
          const chord = !!kid(el, "chord");
          const s = chord ? last : pos;
          if (!chord) last = pos;
          const pitch = kid(el, "pitch");
          if (pitch && !kid(el, "cue")) {
            const midi = (Math.trunc(num(text(pitch, "octave"), 4)) + 1) * 12 +
              (STEP[(text(pitch, "step") || "C").trim()] || 0) + Math.round(num(text(pitch, "alter")));
            const staff = Math.trunc(num(text(el, "staff"), 1)) || 1;
            const ties = new Set(kids(el, "tie").map(t => t.getAttribute("type")));
            const k = midi * 100 + staff;
            if (ties.has("stop") && openTies.has(k)) {
              const n = openTies.get(k);
              n[1] = Math.max(n[1], s + dur);
              if (!ties.has("start")) openTies.delete(k);
            } else {
              const n = [s, s + dur, midi, staff];
              notes.push(n);
              if (ties.has("start")) openTies.set(k, n);
            }
          }
          if (!chord) { pos += dur; maxpos = Math.max(maxpos, pos); }
        } else if (tag === "backup") {
          pos -= num(text(el, "duration")) / div;
        } else if (tag === "forward") {
          pos += num(text(el, "duration")) / div;
          maxpos = Math.max(maxpos, pos);
        }
      }
      pos = maxpos;
      meas.push([start, maxpos - start]);
    }
    if (measures === null) measures = meas;
    const [name, program, drums] = infos[part.getAttribute("id")] || ["", null, false];
    parts.push({ name, program, drums, staves, notes });
  }

  const [beats, beatType] = timeSig || [4, 4];
  const bar = beats * 4 / beatType;
  const pickup = measures && measures.length && measures[0][1] > 0 && measures[0][1] < bar - 1e-6 ? measures[0][1] : 0;
  const out = [];
  let melodySeen = false;
  for (const p of parts) {
    const tid = instrumentTrack(p.name, p.program, p.staves, p.drums);
    const hands = tid === "piano" && p.staves >= 2;   // pentagrama de arriba: derecha
    out.push({ track: tid, newMelody: tid === "melodia" && melodySeen,
      notes: p.notes.filter(([a, b]) => b > a).map(([a, b, n, st]) => [a, b, n, 80, hands ? (st === 1 ? 1 : 0) : null]) });
    melodySeen = melodySeen || tid === "melodia";
  }
  // Varias partes de piano (por ejemplo una por mano): la primera es la derecha.
  const pianos = out.filter(o => o.track === "piano");
  if (pianos.length > 1 && pianos.every(o => new Set(o.notes.map(n => n[4])).size <= 1)) {
    pianos.forEach((o, i) => { o.notes = o.notes.map(([a, b, n, v]) => [a, b, n, v, i === 0 ? 1 : 0]); });
  }
  return buildData(title, out, tempos, Math.round(bar), pickup, fifths, mode);
}

// ------------------------------------------------------------------ MIDI
export function parseMidi(buf, fallbackTitle = "MIDI") {
  const b = new Uint8Array(buf);
  const u32 = i => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16 = i => (b[i] << 8) | b[i + 1];
  const tag = i => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (tag(0) !== "MThd") throw new Error("No es un archivo MIDI");
  const ntrks = u16(10), ppq = u16(12);
  if (ppq & 0x8000) throw new Error("MIDI con tiempo SMPTE: no soportado");
  const vlq = i => { let v = 0, c; do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return [v, i]; };
  let i = 8 + u32(4);
  const tempos = [], groups = new Map();
  let timeSig = null, keySig = null;
  for (let tr = 0; tr < ntrks; tr++) {
    if (tag(i) !== "MTrk") break;
    const end = i + 8 + u32(i + 4);
    let j = i + 8, tick = 0, status = 0, name = "";
    i = end;
    const program = new Array(16).fill(0), on = new Map();
    while (j < end) {
      let d;
      [d, j] = vlq(j);
      tick += d;
      if (b[j] & 0x80) status = b[j++];
      if (status === 0xff) {
        const typ = b[j];
        let ml;
        [ml, j] = vlq(j + 1);
        const data = b.subarray(j, j + ml);
        j += ml;
        if (typ === 0x03) name = String.fromCharCode(...data).trim();
        else if (typ === 0x51 && ml === 3) tempos.push([tick / ppq, 60e6 / ((data[0] << 16) | (data[1] << 8) | data[2])]);
        else if (typ === 0x58 && timeSig === null && ml >= 2) timeSig = [data[0], 2 ** data[1]];
        else if (typ === 0x59 && keySig === null && ml >= 2) keySig = [data[0] > 127 ? data[0] - 256 : data[0], data[1]];
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { let ml; [ml, j] = vlq(j); j += ml; continue; }
      const kind = status & 0xf0, ch = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) { if (kind === 0xc0) program[ch] = b[j]; j += 1; continue; }
      const a = b[j], v = b[j + 1];
      j += 2;
      const k = ch * 128 + a;
      if (kind === 0x90 && v > 0) {
        if (!on.has(k)) on.set(k, []);
        on.get(k).push([tick, v, program[ch]]);
      } else if (kind === 0x80 || kind === 0x90) {
        const stack = on.get(k);
        if (stack && stack.length) {
          const [t0, vel, prog] = stack.shift();
          const gk = `${String(tr).padStart(4, "0")}|${String(ch).padStart(2, "0")}|${String(prog).padStart(3, "0")}`;
          if (!groups.has(gk)) groups.set(gk, { name, program: prog, drums: ch === 9, notes: [] });
          const g = groups.get(gk);
          g.name = g.name || name;
          g.notes.push([t0 / ppq, tick / ppq, a, vel]);
        }
      }
    }
  }
  const out = [];
  let melodySeen = false;
  for (const gk of [...groups.keys()].sort()) {
    const g = groups.get(gk);
    const tid = instrumentTrack(g.name, g.program, 1, g.drums);
    out.push({ track: tid, newMelody: tid === "melodia" && melodySeen,
      notes: g.notes.filter(([a, b2]) => b2 > a).map(([a, b2, n, v]) => [a, b2, n, v, null]) });
    melodySeen = melodySeen || tid === "melodia";
  }
  // Piano en dos pistas (una por mano): la mas aguda es la derecha.
  const pianos = out.filter(o => o.track === "piano" && o.notes.length);
  if (pianos.length === 2) {
    const mean = o => o.notes.reduce((s, n) => s + n[2], 0) / o.notes.length;
    const hi = mean(pianos[0]) >= mean(pianos[1]) ? pianos[0] : pianos[1];
    for (const o of pianos) o.notes = o.notes.map(([a, b2, n, v]) => [a, b2, n, v, o === hi ? 1 : 0]);
  }
  const [fifths, mode] = keySig ? [keySig[0], keySig[1] ? "minor" : "major"] : [null, null];
  const [beats, beatType] = timeSig || [4, 4];
  return buildData(fallbackTitle, out, tempos, Math.round(beats * 4 / beatType), 0, fifths, mode);
}

// Lee cualquier formato soportado y devuelve los datos de la cancion.
export async function importScore(file) {
  const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, "");
  if (ext === ".mid" || ext === ".midi") return parseMidi(await file.arrayBuffer(), title);
  return parseMusicXml(await readMusicXml(file), title);
}

// Audio en silencio del largo de la cancion (WAV de 8 kHz, 8 bits: unos 8 KB
// por segundo), para que el reproductor funcione igual que con una grabacion.
export function silentWav(seconds) {
  const rate = 8000, n = Math.ceil(seconds * rate);
  const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, "data"); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);   // 128 = silencio en 8 bits
  return new Blob([buf], { type: "audio/wav" });
}
