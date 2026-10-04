// Partitura (MusicXML) y MIDI a partir de las notas, en el navegador.
// Misma logica que notation.py de la version de PC: las notas se alinean al
// pulso real, se cuantizan a semicorcheas, los acordes se arman solo con
// notas que empiezan juntas de verdad, y la anacrusa queda como compas
// incompleto. El piano va en un sistema de dos pentagramas segun las manos.
import { BeatMap, assignHands, barShift, keyInfo } from "./analysis.js";

const Q = 4;   // divisiones por negra (semicorcheas)

// ------------------------------------------------------------------ cuantizacion
function quantize(notes, bm, shift, transpose) {
  return notes.map(([s, e, p]) => {
    const a = Math.max(0, Math.round((bm.toBeat(s) + shift) * Q));
    let b = Math.round((bm.toBeat(e) + shift) * Q);
    if (b <= a) b = a + 1;
    return { a, b, p: p + transpose, t: s };
  });
}

// Linea de acordes sin superposiciones (ver notation.py: _chord_sequence).
function chordSequence(qnotes) {
  const cl = [];
  for (const n of [...qnotes].sort((x, y) => x.t - y.t || x.p - y.p)) {
    const last = cl[cl.length - 1];
    if (last && n.t - last.t < 0.04) { last.ps.add(n.p); last.b = Math.max(last.b, n.b); continue; }
    let { a, b } = n;
    if (last && a <= last.a) { a = last.a + 1; b = Math.max(b, a + 1); }
    cl.push({ a, b, ps: new Set([n.p]), t: n.t });
  }
  const seq = [];
  for (let i = 0; i < cl.length; i++) {
    let end = cl[i].b;
    if (i + 1 < cl.length) {
      const nxt = cl[i + 1].a;
      end = Math.min(end, nxt);
      if (nxt - end <= Q / 2) end = nxt;   // huecos de menos de medio pulso: se rellenan
    }
    if (end > cl[i].a) seq.push({ off: cl[i].a, dur: end - cl[i].a, ps: [...cl[i].ps].sort((x, y) => x - y) });
  }
  return seq;
}

// ------------------------------------------------------------------ acordes
// Cifrado para teclado facil (misma logica que notation.py de la PC):
// [tipo MusicXML, intervalos, costo]. Los menos comunes tienen que ganar claro.
const CHORD_KINDS = [
  ["major", [0, 4, 7], 0],
  ["minor", [0, 3, 7], 0],
  ["dominant", [0, 4, 7, 10], 0.1],
  ["diminished", [0, 3, 6], 0.1],
  ["suspended-fourth", [0, 5, 7], 0.2],
];
// Acordes propios de la tonalidad [distancia a la tonica, tipo]: desempatan.
const DIATONIC = {
  major: [[0, "major"], [2, "minor"], [4, "minor"], [5, "major"], [7, "major"],
    [7, "dominant"], [9, "minor"], [11, "diminished"]],
  minor: [[0, "minor"], [2, "diminished"], [3, "major"], [5, "minor"], [7, "minor"],
    [7, "major"], [7, "dominant"], [8, "major"], [10, "major"], [11, "diminished"]],
};

function bestChord(chroma, bass, tonic, mode) {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total < 0.5 || chroma.filter(c => c > 0.1 * total).length < 2) return null;
  const diat = new Set((DIATONIC[mode] || DIATONIC.major).map(([d, k]) => `${(tonic + d) % 12}${k}`));
  let best = null, bestS = -1e9;
  for (let root = 0; root < 12; root++) {
    for (const [kind, ivs, cost] of CHORD_KINDS) {
      const tones = ivs.map(i => (root + i) % 12);
      let inn = 0;
      for (const t of tones) inn += chroma[t];
      let s = inn - 0.7 * (total - inn) - cost * total;
      s -= 0.15 * total * tones.filter(t => chroma[t] < 0.05 * total).length;
      if (bass === root) s += 0.2 * total;
      if (diat.has(`${root}${kind}`)) s += 0.08 * total;
      if (s > bestS + 1e-9) { best = [root, kind]; bestS = s; }
    }
  }
  return best;
}

// Acordes de la cancion: [{pos (en pulsos), root (0-11), kind}]. Cada compas
// (o cada mitad en 4/4 y 6/4), con todas las pistas visibles y mas peso para
// el bajo; a la mitad del compas solo si cambia.
export function chordTrack(data, { transpose = 0, trackIds = null } = {}) {
  const bm = new BeatMap(data.beats);
  const bpb = data.beats_per_bar || 4;
  const shift = barShift(data, bm);
  const tonic = (((data.key.tonic + transpose) % 12) + 12) % 12;
  const notes = [];
  for (const t of data.tracks) {
    if (t.id === "drums" || (trackIds && !trackIds.includes(t.id))) continue;
    for (const [s, e, p] of t.notes) notes.push([bm.toBeat(s) + shift, bm.toBeat(e) + shift, p + transpose]);
  }
  if (!notes.length) return [];
  const last = Math.max(...notes.map(n => n[1]));
  const half = bpb === 4 || bpb === 6 ? bpb / 2 : bpb;
  const out = [];
  for (let b0 = 0; b0 < Math.ceil(last / bpb) * bpb; b0 += bpb) {
    let prev = null;
    for (let i = 0; i < bpb; i += half) {
      const a = b0 + i, b = b0 + Math.min(i + half, bpb);
      const chroma = new Array(12).fill(0);
      let low = null;
      for (const [s, e, p] of notes) {
        const ov = Math.min(e, b) - Math.max(s, a);
        if (ov <= 0) continue;
        chroma[((p % 12) + 12) % 12] += ov;
        if (ov >= 0.25 && (low === null || p < low)) low = p;
      }
      const ch = bestChord(chroma, low === null ? null : ((low % 12) + 12) % 12, tonic, data.key.mode);
      if (ch && !(prev && ch[0] === prev[0] && ch[1] === prev[1])) out.push({ pos: a, root: ch[0], kind: ch[1] });
      if (ch) prev = ch;
    }
  }
  return out;
}

// Como se escribe la raiz: Si♭ y no La♯ en Do mayor o La menor; en menor, la
// sensible con sostenido (Sol♯dim en La menor).
const SHARPS = { 1: ["C", 1], 3: ["D", 1], 6: ["F", 1], 8: ["G", 1], 10: ["A", 1] };
export function chordRoot(pc, fifths, tonic = 0, mode = "major") {
  const white = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
  if (pc in white) return [white[pc], 0];
  if (mode === "minor" && pc === (tonic + 11) % 12) return SHARPS[pc];
  const black = fifths >= 4 ? SHARPS
    : fifths >= 2 ? { 1: ["C", 1], 3: ["E", -1], 6: ["F", 1], 8: ["G", 1], 10: ["B", -1] }
    : fifths >= 0 ? { 1: ["C", 1], 3: ["E", -1], 6: ["F", 1], 8: ["A", -1], 10: ["B", -1] }
    : fifths >= -3 ? { 1: ["D", -1], 3: ["E", -1], 6: ["F", 1], 8: ["A", -1], 10: ["B", -1] }
    : { 1: ["D", -1], 3: ["E", -1], 6: ["G", -1], 8: ["A", -1], 10: ["B", -1] };
  return black[pc];
}

function harmonyXml(h, staff) {
  const [step, alter] = h.spelled;
  return `<harmony><root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ""}</root>` +
    `<kind>${h.kind}</kind>${staff ? `<staff>${staff}</staff>` : ""}</harmony>`;
}

// Que pista lleva la melodia en la partitura facil.
const MELODY_ORDER = ["melodia", "vocals", "piano", "guitar", "other", "bass"];


// ------------------------------------------------------------------ escritura
const STEPS_SHARP = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const STEPS_FLAT = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];

function pitchXml(midi, fifths) {
  const [step, alter] = (fifths < 0 ? STEPS_FLAT : STEPS_SHARP)[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
}

// Duraciones escribibles, en semicorcheas: [largo, tipo, puntillo].
const TYPES = [[16, "whole", 0], [12, "half", 1], [8, "half", 0], [6, "quarter", 1],
  [4, "quarter", 0], [3, "eighth", 1], [2, "eighth", 0], [1, "16th", 0]];

// Parte una duracion en figuras escribibles; si empieza fuera del pulso, la
// primera figura llega hasta el pulso (se lee mucho mejor).
function pieces(pos, dur) {
  const out = [];
  const toBeat = (Q - (pos % Q)) % Q;
  if (toBeat && dur > toBeat) {
    out.push(...pieces(pos, toBeat));
    pos += toBeat; dur -= toBeat;
  }
  while (dur > 0) {
    const t = TYPES.find(([l]) => l <= dur);
    out.push(t);
    dur -= t[0];
  }
  return out;
}

// Nombre corto de una nota tal como se escribe en la armadura: "Si♭" o "B♭".
const LATIN = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
export function noteLabel(midi, fifths, names) {
  const [step, alter] = (fifths < 0 ? STEPS_FLAT : STEPS_SHARP)[midi % 12];
  return (names === "latin" ? LATIN[step] : step) + (alter === 1 ? "♯" : alter === -1 ? "♭" : "");
}

// Nombres debajo del pentagrama (como "letra"): en los acordes, uno por
// linea, de la nota mas aguda a la mas grave.
function lyricsXml(ps, fifths, names) {
  return [...ps].sort((a, b) => b - a)
    .map((p, i) => `<lyric number="${i + 1}" placement="below"><syllabic>single</syllabic><text>${noteLabel(p, fifths, names)}</text></lyric>`)
    .join("");
}

function noteXml(ev, piece, { staff, voice, fifths, tieStart, tieStop, names }) {
  const [len, type, dot] = piece;
  if (!ev) {
    return `<note><rest/><duration>${len}</duration><voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${staff ? `<staff>${staff}</staff>` : ""}</note>`;
  }
  return ev.ps.map((p, i) => {
    const ties = (tieStop ? '<tie type="stop"/>' : "") + (tieStart ? '<tie type="start"/>' : "");
    const tied = (tieStop ? '<tied type="stop"/>' : "") + (tieStart ? '<tied type="start"/>' : "");
    // El nombre va solo donde la nota se toca, no en su continuacion ligada.
    const lyr = names && i === 0 && !tieStop ? lyricsXml(ev.ps, fifths, names) : "";
    return `<note>${i ? "<chord/>" : ""}${pitchXml(p, fifths)}<duration>${len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${staff ? `<staff>${staff}</staff>` : ""}${tied ? `<notations>${tied}</notations>` : ""}${lyr}</note>`;
  }).join("");
}

// Contenido de un compas para un pentagrama: notas y silencios que lo llenan.
function measureStaff(seq, m0, m1, opts) {
  let xml = "", pos = m0;
  // Cifrado: se ancla en la primera figura (nota o silencio) que empieza desde
  // su lugar, porque OSMD no ubica un acorde en medio de una nota larga. Si
  // varios caen en la misma figura queda el primero.
  const harm = opts.harm || [];
  let hi = 0;
  const chordAt = x => {
    let h = "";
    if (hi < harm.length && harm[hi].pos <= x) h = harmonyXml(harm[hi], opts.staff);
    while (hi < harm.length && harm[hi].pos <= x) hi++;
    return h;
  };
  const evs = seq.filter(e => e.off < m1 && e.off + e.dur > m0);
  if (!evs.length) {
    const len = m1 - m0;
    return chordAt(m0) + `<note><rest measure="yes"/><duration>${len}</duration><voice>${opts.voice}</voice>${opts.staff ? `<staff>${opts.staff}</staff>` : ""}</note>`;
  }
  const rests = (from, len) => {
    let x = from;
    for (const pc of pieces(from - m0, len)) { xml += chordAt(x) + noteXml(null, pc, opts); x += pc[0]; }
  };
  for (const e of evs) {
    const a = Math.max(e.off, m0), b = Math.min(e.off + e.dur, m1);
    if (a > pos) rests(pos, a - pos);
    const ps = pieces(a - m0, b - a);
    let x = a;
    ps.forEach((pc, i) => {
      const first = i === 0, last = i === ps.length - 1;
      xml += chordAt(x) + noteXml(e, pc, {
        ...opts,
        tieStop: !first || a > e.off,                 // viene de antes (otra figura o el compas anterior)
        tieStart: !last || b < e.off + e.dur,         // sigue despues
      });
      x += pc[0];
    });
    pos = b;
  }
  if (pos < m1) rests(pos, m1 - pos);
  return xml;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// names: null (partitura normal), "latin" (Do Re Mi) o "letters" (C D E).
// chords: cifrado arriba del pentagrama; easy: partitura facil (solo la melodia, con cifrado).
export function buildMusicXml(data, { transpose = 0, trackIds = null, names = null, chords = false, easy = false } = {}) {
  const bm = new BeatMap(data.beats);
  const bpb = data.beats_per_bar || 4;
  const shift = barShift(data, bm);
  const fifths = keyInfo(data.key.tonic + transpose, data.key.mode).fifths;
  const tracks = data.tracks.filter(t => t.id !== "drums" && t.notes.length && (!trackIds || trackIds.includes(t.id)));
  if (!tracks.length) throw new Error("No hay pistas con notas para la partitura");

  // Pentagramas de cada parte.
  let parts = tracks.map(t => {
    const q = quantize(t.notes, bm, shift, transpose);
    if (t.id === "piano") {
      const hands = t.hands || assignHands(t.notes);
      return { t, staves: [
        { seq: chordSequence(q.filter((_, i) => hands[i] === 1)), clef: "G" },
        { seq: chordSequence(q.filter((_, i) => hands[i] === 0)), clef: "F" },
      ] };
    }
    const med = t.notes.map(n => n[2]).sort((a, b) => a - b)[t.notes.length >> 1] || 64;
    const clef = t.id === "bass" ? "F" : t.id === "guitar" ? "G8" : med < 55 ? "F" : "G";
    return { t, staves: [{ seq: chordSequence(q), clef }] };
  });

  if (easy) {
    // Solo la melodia: la nota mas aguda de la pista que la lleva (en el piano,
    // la mano derecha). El acompanamiento queda en el cifrado.
    const rank = t => (MELODY_ORDER.includes(t.id) ? MELODY_ORDER.indexOf(t.id) : 99);
    const t = [...tracks].sort((x, y) => rank(x) - rank(y))[0];
    let q = quantize(t.notes, bm, shift, transpose);
    if (t.id === "piano") {
      const hands = t.hands || assignHands(t.notes);
      const rh = q.filter((_, i) => hands[i] === 1);
      if (rh.length) q = rh;
    }
    const seq = chordSequence(q).map(e => ({ ...e, ps: [Math.max(...e.ps)] }));
    const clef = t.id === "piano" || t.id === "melodia" ? "G" : parts.find(p => p.t === t).staves[0].clef;
    parts = [{ t: { ...t, label: "Melodía" }, staves: [{ seq, clef }] }];
  }

  const L = bpb * Q;
  const lastEnd = Math.max(...parts.flatMap(p => p.staves.flatMap(s => s.seq.map(e => e.off + e.dur))), 1);
  // Anacrusa: pulsos enteros vacios al comienzo en todos los pentagramas.
  const firstOn = Math.min(...parts.flatMap(p => p.staves.flatMap(s => s.seq.length ? [s.seq[0].off] : [])));
  const leadBeats = Math.floor(Math.min(firstOn, L) / Q);
  const lead = leadBeats > 0 && leadBeats < bpb ? leadBeats * Q : 0;
  const bounds = [];
  let m0 = lead;
  if (lead) { bounds.push([lead, L]); m0 = L; }
  while (m0 < lastEnd || !bounds.length) { bounds.push([m0, m0 + L]); m0 += L; }

  const clefXml = (c, n) => c === "F"
    ? `<clef${n ? ` number="${n}"` : ""}><sign>F</sign><line>4</line></clef>`
    : `<clef${n ? ` number="${n}"` : ""}><sign>G</sign><line>2</line>${c === "G8" ? "<clef-octave-change>-1</clef-octave-change>" : ""}</clef>`;

  // Cifrado por compas (en semicorcheas absolutas), para el pentagrama de arriba.
  const harmByBar = {};
  if (chords || easy) {
    const tonic = (((data.key.tonic + transpose) % 12) + 12) % 12;
    for (const h of chordTrack(data, { transpose, trackIds })) {
      const bar = Math.floor(h.pos / bpb);
      (harmByBar[bar] = harmByBar[bar] || []).push({
        pos: Math.round(h.pos * Q), kind: h.kind, spelled: chordRoot(h.root, fifths, tonic, data.key.mode),
      });
    }
  }

  let partList = "", body = "";
  parts.forEach(({ t, staves }, pi) => {
    const pid = `P${pi + 1}`;
    partList += `<score-part id="${pid}"><part-name>${esc(t.label)}</part-name>` +
      `<score-instrument id="${pid}-I1"><instrument-name>${esc(t.label)}</instrument-name></score-instrument>` +
      `<midi-instrument id="${pid}-I1"><midi-channel>${pi + 1}</midi-channel><midi-program>${(t.program || 0) + 1}</midi-program></midi-instrument></score-part>`;
    body += `<part id="${pid}">`;
    bounds.forEach(([m0, m1], mi) => {
      const num = lead ? mi : mi + 1;
      body += `<measure number="${num}"${lead && mi === 0 ? ' implicit="yes"' : ""}>`;
      if (mi === 0) {
        body += `<attributes><divisions>${Q}</divisions><key><fifths>${fifths}</fifths><mode>${data.key.mode === "minor" ? "minor" : "major"}</mode></key>` +
          `<time><beats>${bpb}</beats><beat-type>4</beat-type></time>` +
          (staves.length > 1 ? `<staves>${staves.length}</staves>` : "") +
          staves.map((s, i) => clefXml(s.clef, staves.length > 1 ? i + 1 : 0)).join("") + `</attributes>`;
        if (pi === 0) {
          body += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>` +
            `<per-minute>${Math.round(data.bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(data.bpm)}"/></direction>`;
        }
      }
      staves.forEach((s, si) => {
        if (si > 0) body += `<backup><duration>${m1 - m0}</duration></backup>`;
        const harm = pi === 0 && si === 0 ? harmByBar[mi] : null;
        body += measureStaff(s.seq, m0, m1, { staff: staves.length > 1 ? si + 1 : 0, voice: si * 4 + 1, fifths, names, harm });
      });
      if (mi === bounds.length - 1) body += `<barline location="right"><bar-style>light-heavy</bar-style></barline>`;
      body += `</measure>`;
    });
    body += `</part>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0"><work><work-title>${esc(data.title || "Transcripción")}</work-title></work>` +
    `<identification><creator type="composer">Transcripción automática</creator></identification>` +
    `<part-list>${partList}</part-list>${body}</score-partwise>`;
}

// ------------------------------------------------------------------ MIDI
function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function chunk(type, bytes) {
  const len = bytes.length;
  return [...type].map(c => c.charCodeAt(0)).concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], bytes);
}

// aligned: tempo constante y notas llevadas a la grilla de compases (para DAW
// y editores). Si no, los tiempos reales de la grabacion.
export function buildMidi(data, { transpose = 0, aligned = true, trackIds = null } = {}) {
  const PPQ = 480, bpm = data.bpm || 120;
  const bm = new BeatMap(data.beats);
  const shift = barShift(data, bm);
  const toTick = t => Math.max(0, Math.round(aligned ? (bm.toBeat(t) + shift) * PPQ : (t * bpm / 60) * PPQ));
  const k = keyInfo(data.key.tonic + transpose, data.key.mode);
  const usPerQ = Math.round(60000000 / bpm);
  const meta = [0, 0xff, 0x51, 3, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255,
    0, 0xff, 0x58, 4, data.beats_per_bar || 4, 2, 24, 8,
    0, 0xff, 0x59, 2, k.fifths & 255, k.mode === "minor" ? 1 : 0,
    0, 0xff, 0x2f, 0];
  const tracks = [chunk("MTrk", meta)];
  let nextChan = 0;
  for (const t of data.tracks) {
    if (trackIds && !trackIds.includes(t.id)) continue;
    const drums = t.id === "drums";
    if (nextChan === 9) nextChan++;            // el canal 10 es de la bateria
    const chan = drums ? 9 : nextChan++ % 16;
    const evs = [];
    for (const [s, e, p, v] of t.notes) {
      const pitch = drums ? p : p + transpose;
      if (pitch < 0 || pitch > 127) continue;
      const a = toTick(s), b = Math.max(toTick(e), a + 10);
      evs.push([a, 1, 0x90 | chan, pitch, Math.max(1, Math.min(127, v))]);
      evs.push([b, 0, 0x80 | chan, pitch, 0]);
    }
    evs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const name = [...new TextEncoder().encode(t.label)];
    const bytes = [0, 0xff, 0x03, ...vlq(name.length), ...name];
    if (!drums) bytes.push(0, 0xc0 | chan, t.program || 0);
    let last = 0;
    for (const [tick, , st, d1, d2] of evs) { bytes.push(...vlq(tick - last), st, d1, d2); last = tick; }
    bytes.push(0, 0xff, 0x2f, 0);
    tracks.push(chunk("MTrk", bytes));
  }
  const header = chunk("MThd", [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
  return new Uint8Array(header.concat(...tracks));
}
