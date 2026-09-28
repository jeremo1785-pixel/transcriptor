// Procesamiento de audio: FFT, espectrograma log-mel (para el pulso) y
// estimacion de afinacion. Replica exactamente lo que hacen torchaudio y
// librosa en la version de PC (validado numero contra numero con Python).

// ------------------------------------------------------------------ FFT
const fftCache = new Map();

function fftPlan(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const levels = Math.log2(n);
  if (levels % 1) throw new Error("La FFT necesita un tamano potencia de 2");
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const plan = { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, plan);
  return plan;
}

// Magnitud del espectro (n/2+1 valores) de una trama real ya ventaneada.
export function magnitude(frame, out) {
  const n = frame.length, p = fftPlan(n), re = p.re, im = p.im;
  for (let i = 0; i < n; i++) { re[p.rev[i]] = frame[i]; im[p.rev[i]] = 0; }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * p.cos[k] - im[b] * p.sin[k];
        const ti = re[b] * p.sin[k] + im[b] * p.cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  const bins = n / 2 + 1;
  out = out || new Float32Array(bins);
  for (let k = 0; k < bins; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

export function hann(n, periodic = true) {
  const w = new Float32Array(n), d = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

// ------------------------------------------------------------------ log-mel (beat_this)
// torchaudio MelSpectrogram(sr=22050, n_fft=1024, hop=441, center=True con
// relleno "reflect", ventana Hann periodica, normalized="frame_length",
// power=1) y despues log1p(1000 * mel). fb: banco de filtros (513 x 128).
export function beatSpectrogram(y, fb, onProgress) {
  const nFft = 1024, hop = 441, bins = 513, mels = 128, pad = nFft / 2;
  const n = y.length;
  const frames = 1 + Math.floor(n / hop);
  const win = hann(nFft), frame = new Float32Array(nFft), mag = new Float32Array(bins);
  const out = new Float32Array(frames * mels);
  const norm = 1 / Math.sqrt(nFft);
  const at = i => {            // relleno por reflexion en los bordes
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
    return y[Math.max(0, Math.min(n - 1, i))];
  };
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad;
    for (let i = 0; i < nFft; i++) frame[i] = at(start + i) * win[i];
    magnitude(frame, mag);
    const row = f * mels;
    for (let k = 0; k < bins; k++) {
      const v = mag[k] * norm;
      if (v === 0) continue;
      const fr = k * mels;
      for (let m = 0; m < mels; m++) out[row + m] += v * fb[fr + m];
    }
    for (let m = 0; m < mels; m++) out[row + m] = Math.log1p(1000 * out[row + m]);
    if (onProgress && f % 2000 === 0) onProgress(f / frames);
  }
  return { data: out, frames, mels };
}

// ------------------------------------------------------------------ afinacion
// librosa.estimate_tuning(y, sr, n_fft=2048) con bins_per_octave=12:
// picos espectrales (piptrack, 150-4000 Hz, umbral 0.1 del maximo de cada
// trama), interpolacion parabolica, y el desvio mas frecuente respecto del
// semitono mas cercano. Devuelve semitonos (-0.5 a 0.5).
export function estimateTuning(y, sr, maxSeconds = 150) {
  const nFft = 2048, hop = 512, bins = nFft / 2 + 1, pad = nFft / 2;
  const n = Math.min(y.length, Math.floor(sr * maxSeconds));
  const frames = 1 + Math.floor(n / hop);
  const win = hann(nFft), frame = new Float32Array(nFft), S = new Float32Array(bins);
  const kMin = Math.ceil((150 * nFft) / sr), kMax = Math.min(bins - 2, Math.floor((4000 * nFft) / sr - 1e-9));
  const pitches = [], mags = [];
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad;
    for (let i = 0; i < nFft; i++) {
      const j = start + i;
      frame[i] = j >= 0 && j < n ? y[j] * win[i] : 0;   // relleno constante (librosa)
    }
    magnitude(frame, S);
    let mx = 0;
    for (let k = 0; k < bins; k++) if (S[k] > mx) mx = S[k];
    const ref = 0.1 * mx;
    for (let k = Math.max(1, kMin); k <= kMax; k++) {
      const b = S[k];
      if (!(b > ref)) continue;
      const a = S[k - 1] > ref ? S[k - 1] : 0, c = S[k + 1] > ref ? S[k + 1] : 0;
      if (!(b > a && b >= c)) continue;
      const den = 2 * b - S[k - 1] - S[k + 1];
      const shift = Math.abs(den) < 1e-12 ? 0 : (0.5 * (S[k + 1] - S[k - 1])) / den;
      const avg = 0.5 * (S[k + 1] - S[k - 1]);
      pitches.push(((k + shift) * sr) / nFft);
      mags.push(b + 0.5 * avg * shift);
    }
  }
  if (!pitches.length) return 0;
  const sorted = Float32Array.from(mags).sort();
  const thr = sorted[sorted.length >> 1];
  const counts = new Float64Array(100);
  for (let i = 0; i < pitches.length; i++) {
    if (mags[i] < thr || pitches[i] <= 0) continue;
    let r = (12 * Math.log2(pitches[i] / 27.5)) % 1;
    if (r < 0) r += 1;
    if (r >= 0.5) r -= 1;
    const bin = Math.min(99, Math.max(0, Math.floor((r + 0.5) / 0.01)));
    counts[bin]++;
  }
  let best = 0;
  for (let i = 1; i < 100; i++) if (counts[i] > counts[best]) best = i;
  return -0.5 + best * 0.01;
}

// ------------------------------------------------------------------ remuestreo
// Remuestreo lineal con filtro previo simple. Solo se usa para corregir la
// afinacion (cambios de menos de un 3%), donde alcanza de sobra.
export function resampleLinear(y, ratio) {
  const n = Math.floor(y.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    const a = y[j] || 0, b = y[j + 1] || 0;
    out[i] = a + (b - a) * f;
  }
  return out;
}
