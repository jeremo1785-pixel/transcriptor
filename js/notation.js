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

function noteXml(ev, piece, { staff, voice, fifths, tieStart, tieStop }) {
  const [len, type, dot] = piece;
  if (!ev) {
    return `<note><rest/><duration>${len}</duration><voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${staff ? `<staff>${staff}</staff>` : ""}</note>`;
  }
  return ev.ps.map((p, i) => {
    const ties = (tieStop ? '<tie type="stop"/>' : "") + (tieStart ? '<tie type="start"/>' : "");
    const tied = (tieStop ? '<tied type="stop"/>' : "") + (tieStart ? '<tied type="start"/>' : "");
    return `<note>${i ? "<chord/>" : ""}${pitchXml(p, fifths)}<duration>${len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${staff ? `<staff>${staff}</staff>` : ""}${tied ? `<notations>${tied}</notations>` : ""}</note>`;
  }).join("");
}

// Contenido de un compas para un pentagrama: notas y silencios que lo llenan.
function measureStaff(seq, m0, m1, opts) {
  let xml = "", pos = m0;
  const evs = seq.filter(e => e.off < m1 && e.off + e.dur > m0);
  if (!evs.length) {
    const len = m1 - m0;
    return `<note><rest measure="yes"/><duration>${len}</duration><voice>${opts.voice}</voice>${opts.staff ? `<staff>${opts.staff}</staff>` : ""}</note>`;
  }
  for (const e of evs) {
    const a = Math.max(e.off, m0), b = Math.min(e.off + e.dur, m1);
    if (a > pos) { for (const pc of pieces(pos - m0, a - pos)) xml += noteXml(null, pc, opts); }
    const ps = pieces(a - m0, b - a);
    ps.forEach((pc, i) => {
      const first = i === 0, last = i === ps.length - 1;
      xml += noteXml(e, pc, {
        ...opts,
        tieStop: !first || a > e.off,                 // viene de antes (otra figura o el compas anterior)
        tieStart: !last || b < e.off + e.dur,         // sigue despues
      });
    });
    pos = b;
  }
  if (pos < m1) for (const pc of pieces(pos - m0, m1 - pos)) xml += noteXml(null, pc, opts);
  return xml;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function buildMusicXml(data, { transpose = 0, trackIds = null } = {}) {
  const bm = new BeatMap(data.beats);
  const bpb = data.beats_per_bar || 4;
  const shift = barShift(data, bm);
  const fifths = keyInfo(data.key.tonic + transpose, data.key.mode).fifths;
  const tracks = data.tracks.filter(t => t.id !== "drums" && t.notes.length && (!trackIds || trackIds.includes(t.id)));
  if (!tracks.length) throw new Error("No hay pistas con notas para la partitura");

  // Pentagramas de cada parte.
  const parts = tracks.map(t => {
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
        body += `<attributes><divisions>${Q}</divisions><key><fifths>${fifths}</fifths></key>` +
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
        body += measureStaff(s.seq, m0, m1, { staff: staves.length > 1 ? si + 1 : 0, voice: si * 4 + 1, fifths });
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
