// Pulso y primeros tiempos de compas con beat_this (CPJKU, 2024), igual que
// su inferencia oficial: trozos de 1500 cuadros (30 s) con bordes de 6 que se
// descartan, y picos por encima de 0.5 de probabilidad.

const CHUNK = 1500, BORDER = 6, FPS = 50, MELS = 128;

// Trozos del espectrograma (split_piece con avoid_short_end).
export function chunks(spect) {
  const { data, frames } = spect;
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  // El modelo se exporto con largo fijo: los trozos cortos se completan con
  // ceros (silencio en la escala log1p) y despues se ignora lo agregado.
  return starts.map(start => {
    const buf = new Float32Array(CHUNK * MELS);
    const a = Math.max(start, 0), b = Math.min(start + CHUNK, frames);
    buf.set(data.subarray(a * MELS, b * MELS), (a - start) * MELS);
    return { start, input: buf };
  });
}

// Une las predicciones: gana el trozo anterior en los solapamientos (keep_first).
export function aggregate(results, frames) {
  const beat = new Float32Array(frames).fill(-1000), down = new Float32Array(frames).fill(-1000);
  for (let r = results.length - 1; r >= 0; r--) {
    const { start, beat: b, downbeat: d } = results[r];
    for (let i = BORDER; i < CHUNK - BORDER; i++) {
      const t = start + i;
      if (t < 0 || t >= frames) continue;
      beat[t] = b[i];
      down[t] = d[i];
    }
  }
  return { beat, down };
}

function peaks(logits) {
  const n = logits.length, out = [];
  for (let i = 0; i < n; i++) {
    let mx = -Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (logits[j] > mx) mx = logits[j];
    if (logits[i] === mx && logits[i] > 0) out.push(i);
  }
  // Picos pegados (a 1 cuadro) se promedian en uno.
  const res = [];
  let p = null, c = 0;
  for (const q of out) {
    if (p !== null && q - p <= 1) { c++; p += (q - p) / c; }
    else { if (p !== null) res.push(p); p = q; c = 1; }
  }
  if (p !== null) res.push(p);
  return res;
}

export function postprocess(beat, down) {
  const bt = peaks(beat).map(f => f / FPS);
  let dt = peaks(down).map(f => f / FPS);
  if (bt.length) {
    dt = dt.map(d => {
      let best = bt[0];
      for (const b of bt) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
      return best;
    });
  }
  dt = [...new Set(dt)].sort((a, b) => a - b);
  return { beats: bt, downbeats: dt };
}
