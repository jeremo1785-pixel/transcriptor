// Tonalidad, reparto de manos, compas y ajustes de tempo. Es la misma logica
// que analysis.py / notation.py de la version de PC.

// ------------------------------------------------------------------ tonalidad
export const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const ES = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };

export function keyInfo(tonic, mode) {
  tonic = ((tonic % 12) + 12) % 12;
  const fifths = MAJOR_FIFTHS[mode === "major" ? tonic : (tonic + 3) % 12];
  const name = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[tonic];
  const es = ES[name[0]] + name.slice(1).replace("#", "♯").replace("b", "♭");
  return { tonic, mode, fifths, name: name + (mode === "major" ? "" : "m"),
    label: `${es} ${mode === "major" ? "mayor" : "menor"}` };
}

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Krumhansl-Schmuckler sobre las notas, pesando por duracion (el bajo, doble).
export function detectKey(tracks) {
  const hist = new Array(12).fill(0);
  for (const t of tracks) {
    if (t.id === "drums") continue;
    const w = t.id === "bass" ? 2 : 1;
    for (const [s, e, p, v] of t.notes) hist[p % 12] += w * Math.min(e - s, 2) * (0.5 + v / 127);
  }
  if (!hist.some(x => x > 0)) return keyInfo(0, "major");
  let best = [0, "major"], bestR = -2;
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [["major", MAJOR], ["minor", MINOR]]) {
      const rolled = prof.map((_, i) => prof[((i - t) % 12 + 12) % 12]);
      const r = corr(hist, rolled);
      if (r > bestR) { best = [t, mode]; bestR = r; }
    }
  }
  return { ...keyInfo(best[0], best[1]), confidence: +bestR.toFixed(3) };
}

// ------------------------------------------------------------------ manos
// 0 = izquierda, 1 = derecha. Division en el Do central, con excepciones solo
// cuando un acorde no entra en una mano o las manos se cruzan claramente.
export function assignHands(notes) {
  const n = notes.length, hands = new Array(n).fill(1);
  if (!n) return hands;
  const order = [...notes.keys()].sort((a, b) => notes[a][0] - notes[b][0] || notes[a][2] - notes[b][2]);
  let lc = 50, rc = 69;
  const split = 60;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    const t0 = notes[order[i]][0];
    while (j < n && notes[order[j]][0] - t0 < 0.04) j++;
    const idx = order.slice(i, j).sort((a, b) => notes[a][2] - notes[b][2]);
    const ps = idx.map(k => notes[k][2]);
    let bestK = 0, bestC = Infinity;
    for (let k = 0; k <= ps.length; k++) {
      const left = ps.slice(0, k), right = ps.slice(k);
      let c = 0;
      for (const p of left) c += 0.15 * Math.abs(p - lc) + 2 * Math.max(0, p - split + 1);
      for (const p of right) c += 0.15 * Math.abs(p - rc) + 2 * Math.max(0, split - p);
      for (const g of [left, right]) {
        if (g.length) {
          c += 6 * Math.max(0, g[g.length - 1] - g[0] - 14);
          c += 8 * Math.max(0, g.length - 5);
        }
      }
      if (c < bestC - 1e-9) { bestK = k; bestC = c; }
    }
    idx.forEach((k, pos) => (hands[k] = pos < bestK ? 0 : 1));
    const left = ps.slice(0, bestK), right = ps.slice(bestK);
    if (left.length) lc = 0.65 * lc + 0.35 * (left.reduce((s, x) => s + x, 0) / left.length);
    if (right.length) rc = 0.65 * rc + 0.35 * (right.reduce((s, x) => s + x, 0) / right.length);
    if (rc - lc < 7) { const mid = (lc + rc) / 2; lc = mid - 3.5; rc = mid + 3.5; }
    i = j;
  }
  return hands;
}

// ------------------------------------------------------------------ compas
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

// A partir de pulsos y primeros tiempos: compas, tempo y primer tiempo fuerte.
export function rhythmFrom(beats, downs, duration) {
  if (beats.length < 4) {
    beats = [];
    for (let t = 0; t < Math.max(duration, 2); t += 0.5) beats.push(t);
    downs = beats.filter((_, i) => i % 4 === 0);
  }
  const idx = downs.map(d => lowerBound(beats, d - 1e-3));
  const gaps = [];
  for (let i = 1; i < idx.length; i++) { const g = idx[i] - idx[i - 1]; if (g >= 2 && g <= 7) gaps.push(g); }
  let perBar = 4;
  if (gaps.length) {
    const cnt = {};
    for (const g of gaps) cnt[g] = (cnt[g] || 0) + 1;
    perBar = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a - b)[0];
  }
  if (!downs.length) downs = beats.filter((_, i) => i % perBar === 0);
  const diffs = beats.slice(1).map((b, i) => b - beats[i]);
  return {
    beats: beats.map(b => +b.toFixed(4)),
    downbeats: downs.map(d => +d.toFixed(4)),
    bpm: +(60 / median(diffs)).toFixed(1),
    beats_per_bar: perBar,
    first_downbeat: downs.length ? lowerBound(beats, downs[0] - 1e-3) : 0,
  };
}

// Ajustes del usuario (tempo a la mitad / al doble, compas a mano).
export function applyRhythm(data) {
  const raw = data.rhythm_raw;
  if (!raw) return data;
  const st = data.settings || {};
  const factor = st.tempo_factor || 1;
  let b = [...raw.beats], fd = raw.first_downbeat, bpb = raw.beats_per_bar;
  if (factor === 0.5 && b.length >= 8) {
    b = b.filter((_, i) => i >= fd % 2 && (i - (fd % 2)) % 2 === 0);
    fd = Math.floor(fd / 2);
    bpb = bpb % 2 === 0 ? Math.max(2, bpb / 2) : bpb;
  } else if (factor === 2 && b.length >= 2) {
    const mids = b.slice(1).map((x, i) => (b[i] + x) / 2);
    b = [...b, ...mids].sort((x, y) => x - y);
    fd *= 2;
    bpb = bpb * 2 <= 7 ? bpb * 2 : bpb;
  }
  if (st.beats_per_bar) bpb = st.beats_per_bar;
  const first = fd % bpb;
  const downs = b.filter((_, i) => i >= first && (i - first) % bpb === 0);
  const diffs = b.slice(1).map((x, i) => x - b[i]);
  const out = {
    ...data,
    beats: b.map(x => +x.toFixed(4)),
    downbeats: downs.map(x => +x.toFixed(4)),
    bpm: +(60 / median(diffs)).toFixed(1),
    beats_per_bar: bpb,
    first_downbeat: first,
    settings: { tempo_factor: factor, beats_per_bar: st.beats_per_bar || null },
  };
  out.bar_shift = barShift(out);
  return out;
}

// ------------------------------------------------------------------ segundos <-> pulsos
export class BeatMap {
  constructor(beats) {
    this.b = beats;
    this.p0 = beats[1] - beats[0];
    this.p1 = beats[beats.length - 1] - beats[beats.length - 2];
  }
  toBeat(t) {
    const b = this.b, n = b.length;
    if (t <= b[0]) return (t - b[0]) / this.p0;
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / this.p1;
    const i = lowerBound(b, t) - 1;
    return i + (t - b[i]) / (b[i + 1] - b[i]);
  }
}

// Pulsos que se suman para armar los compases (ver notation.py: bar_shift).
export function barShift(data, bm) {
  bm = bm || new BeatMap(data.beats);
  const bpb = data.beats_per_bar || 4, fd = data.first_downbeat || 0;
  let shift = -fd + bpb * Math.ceil(fd / bpb);
  let first = Infinity;
  for (const t of data.tracks) {
    if (t.id === "drums") continue;
    for (const n of t.notes) if (n[0] < first) first = n[0];
  }
  if (isFinite(first)) {
    const pos = bm.toBeat(first) + shift;
    if (pos < -0.1) shift += bpb * Math.ceil((-pos - 0.1) / bpb);
  }
  return shift;
}
