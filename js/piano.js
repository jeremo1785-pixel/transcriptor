// Transcripcion de piano: el modelo de ByteDance (Kong et al.) corre por
// segmentos de 10 s con 50% de solapamiento, y sus salidas se convierten en
// notas igual que en piano_transcription_inference (RegressionPostProcessor).

export const PIANO_SR = 16000;
const SEG = 160000;          // 10 s
const FPS = 100;
const KEYS = 88, BEGIN_NOTE = 21;

// Divide el audio en segmentos de 10 s que avanzan de a 5 s (enframe).
export function segments(audio) {
  const n = audio.length;
  const padded = new Float32Array(Math.ceil(n / SEG) * SEG);
  padded.set(audio);
  const out = [];
  for (let p = 0; p + SEG <= padded.length; p += SEG / 2) out.push(padded.subarray(p, p + SEG));
  return out;
}

// Une las salidas de los segmentos (deframe): de cada uno se usa la mitad
// central, que es donde el modelo tiene contexto a ambos lados.
// outs: lista de Float32Array (1001 * 88) por segmento.
export function deframe(outs) {
  const segFrames = 1001, used = segFrames - 1;   // la ultima trama sobra (center=True)
  if (outs.length === 1) return { data: outs[0], frames: segFrames };
  const q = used / 4;
  const parts = [];
  parts.push([outs[0], 0, 3 * q]);
  for (let i = 1; i < outs.length - 1; i++) parts.push([outs[i], q, 3 * q]);
  parts.push([outs[outs.length - 1], q, used]);
  const frames = parts.reduce((s, [, a, b]) => s + (b - a), 0);
  const data = new Float32Array(frames * KEYS);
  let pos = 0;
  for (const [src, a, b] of parts) {
    data.set(src.subarray(a * KEYS, b * KEYS), pos);
    pos += (b - a) * KEYS;
  }
  return { data, frames };
}

// Picos de una salida de regresion (onset u offset) con su corrimiento
// sub-trama (seccion III-D del paper).
function binarize(reg, frames, threshold, neighbour) {
  const bin = new Uint8Array(frames * KEYS), shift = new Float32Array(frames * KEYS);
  for (let k = 0; k < KEYS; k++) {
    const x = n => reg[n * KEYS + k];
    for (let n = neighbour; n < frames - neighbour; n++) {
      if (!(x(n) > threshold)) continue;
      let mono = true;
      for (let i = 0; i < neighbour; i++) {
        if (x(n - i) < x(n - i - 1)) mono = false;
        if (x(n + i) < x(n + i + 1)) mono = false;
      }
      if (!mono) continue;
      bin[n * KEYS + k] = 1;
      shift[n * KEYS + k] = x(n - 1) > x(n + 1)
        ? (x(n + 1) - x(n - 1)) / (x(n) - x(n + 1)) / 2
        : (x(n + 1) - x(n - 1)) / (x(n) - x(n - 1)) / 2;
    }
  }
  return { bin, shift };
}

// Salidas del modelo (ya unidas) -> notas [inicio_s, fin_s, midi, velocidad].
export function toNotes(out, frames, { onsetThreshold = 0.3, offsetThreshold = 0.3, frameThreshold = 0.1 } = {}) {
  const on = binarize(out.onset, frames, onsetThreshold, 2);
  const off = binarize(out.offset, frames, offsetThreshold, 4);
  const notes = [];
  for (let k = 0; k < KEYS; k++) {
    const idx = i => i * KEYS + k;
    // Igual que el original en Python, donde "if bgn:" trata la trama 0 como vacia.
    let bgn = 0, fd = 0, oo = 0;
    const push = (b, fin, offShift) => notes.push([
      (b + on.shift[idx(b)]) / FPS, (fin + offShift) / FPS, k + BEGIN_NOTE,
      Math.floor(out.velocity[idx(b)] * 128),
    ]);
    for (let i = 0; i < frames; i++) {
      if (on.bin[idx(i)] === 1) {
        if (bgn) { push(bgn, Math.max(i - 1, 0), 0); fd = 0; oo = 0; }
        bgn = i;
      }
      if (bgn && i > bgn) {
        if (out.frame[idx(i)] <= frameThreshold && !fd) fd = i;
        if (off.bin[idx(i)] === 1 && !oo) oo = i;
        if (fd) {
          const fin = oo && oo - bgn > fd - oo ? oo : fd;
          push(bgn, fin, off.shift[idx(fin)]);
          bgn = 0; fd = 0; oo = 0;
        }
        if (bgn && (i - bgn >= 600 || i === frames - 1)) {
          push(bgn, i, off.shift[idx(i)]);
          bgn = 0; fd = 0; oo = 0;
        }
      }
    }
  }
  notes.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return notes;
}
