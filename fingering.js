// Numeros de dedo (digitacion) para cada mano del piano: 1 = pulgar ... 5 = meñique.
// Mismo archivo en la PC y en el iPad (script comun, deja window.Fingering).
//
// Programacion dinamica: para cada nota (o acorde) se prueban todos los dedos
// posibles y se elige la secuencia que menos "cuesta" segun reglas de
// comodidad de la mano (Parncutt y otros, 1997): cuanto se estiran dos dedos,
// el pulgar en tecla negra, los dedos debiles, cambiar de posicion sin tiempo.
(function () {
  // Distancias en semitonos entre dos dedos (el de numero menor abajo):
  // [minPractica, minComoda, minRelajada, maxRelajada, maxComoda, maxPractica]
  const SPAN = {
    "1-2": [-5, -3, 1, 5, 8, 10], "1-3": [-4, -2, 3, 7, 10, 12], "1-4": [-3, -1, 5, 9, 12, 14],
    "1-5": [-1, 1, 7, 10, 13, 15], "2-3": [1, 1, 1, 2, 3, 5], "2-4": [1, 1, 3, 4, 5, 7],
    "2-5": [2, 2, 5, 6, 8, 10], "3-4": [1, 1, 1, 2, 2, 4], "3-5": [1, 1, 3, 4, 5, 7],
    "4-5": [1, 1, 1, 2, 3, 5],
  };
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = p => BLACK.has(((p % 12) + 12) % 12);

  // Costo de tocar la nota q con el dedo b despues de la nota p con el dedo a.
  // La mano izquierda es el espejo de la derecha: se invierten las alturas.
  function pairCost(a, p, b, q, gap) {
    if (a === b) {
      if (p === q) return 0;                       // repetir la misma tecla
      return 8 + Math.abs(q - p);                  // mismo dedo en otra tecla: malo
    }
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const d = a < b ? q - p : p - q;               // distancia del dedo menor al mayor
    const [minP, minC, minR, maxR, maxC, maxP] = SPAN[`${lo}-${hi}`];
    let c = 0;
    // Pasar el pulgar por abajo (o un dedo por arriba del pulgar): se puede,
    // pero cada paso cuesta; lo natural es pasarlo despues del 3 o del 4.
    if (lo === 1 && d < 0) {
      c = 3 + 0.5 * -d + (hi === 2 ? 1.5 : hi === 5 ? 5 : 0);
      if (d < minP) c += 12 + 2 * (minP - d);
      if (gap > 0.6) c *= 0.35; else if (gap > 0.3) c *= 0.7;
      return c;
    }
    if (d > maxC) c += 2 * (d - maxC);
    if (d < minC) c += 2 * (minC - d);
    if (d < minR) c += (lo === 1 ? 2 : 1) * (minR - d);
    if (d > maxR) c += (lo === 1 ? 1 : 2) * (d - maxR);
    if (d < minP || d > maxP) c += 12 + 2 * Math.max(minP - d, d - maxP);
    // Con tiempo de sobra la mano se acomoda: los saltos importan menos.
    if (gap > 0.6) c *= 0.35; else if (gap > 0.3) c *= 0.7;
    return c;
  }

  // Costo propio de un dedo sobre una nota (sin mirar la anterior).
  function fingerCost(f, p, run) {
    let c = 0;
    if (f === 4) c += 0.6;
    if (f === 5 && run) c += 0.3;
    if (f === 1 && isBlack(p)) c += 2.5;
    if (f === 5 && isBlack(p)) c += 1;
    return c;
  }

  // Todas las formas de repartir k notas (de grave a aguda) entre 5 dedos en orden.
  const combos = {};
  function fingerSets(k) {
    if (combos[k]) return combos[k];
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let f = start; f <= 5; f++) { acc.push(f); rec(f + 1, acc); acc.pop(); }
    };
    rec(1, []);
    return (combos[k] = out);
  }

  // Costo de un acorde (estirar la mano entre dedos vecinos).
  function chordCost(fs, ps) {
    let c = 0;
    for (let i = 1; i < fs.length; i++) {
      const [, minC, minR, maxR, maxC, maxP] = SPAN[`${fs[i - 1]}-${fs[i]}`];
      const d = ps[i] - ps[i - 1];
      if (d > maxC) c += 2 * (d - maxC);
      if (d < minC) c += 2 * (minC - d);
      if (d > maxP) c += 15;
      // La mano relajada: cada dedo cerca de "su" tecla (Do-Mi-Sol = 1-3-5).
      if (d > maxR) c += d - maxR;
      if (d < minR) c += minR - d;
    }
    for (let i = 0; i < fs.length; i++) c += fingerCost(fs[i], ps[i], false) * 0.5;
    return c;
  }

  /**
   * notes: [[inicio, fin, nota, ...], ...] de UNA mano. hand: 1 derecha, 0 izquierda.
   * Devuelve un array con el dedo (1..5) de cada nota, en el mismo orden.
   */
  function assign(notes, hand) {
    const n = notes.length, out = new Array(n).fill(0);
    if (!n) return out;
    const sign = hand === 0 ? -1 : 1;              // izquierda: espejo
    // Eventos: notas que empiezan juntas (menos de 40 ms) forman un acorde.
    const order = [...notes.keys()].sort((i, j) => notes[i][0] - notes[j][0] || notes[i][2] - notes[j][2]);
    const events = [];
    for (const i of order) {
      const last = events[events.length - 1];
      if (last && notes[i][0] - last.t < 0.04 && last.idx.length < 5) last.idx.push(i);
      else events.push({ t: notes[i][0], idx: [i] });
    }
    for (const ev of events) {
      // De grave a agudo en la mano derecha; en la izquierda, al reves (espejo).
      ev.idx.sort((i, j) => sign * (notes[i][2] - notes[j][2]));
      ev.ps = ev.idx.map(i => sign * notes[i][2]);
      ev.raw = ev.idx.map(i => notes[i][2]);
      ev.cands = fingerSets(ev.idx.length);
    }
    // Viterbi: mejor costo para llegar a cada digitacion de cada evento.
    let prevCost = events[0].cands.map(fs => chordCost(fs, events[0].ps) + fs.reduce((c, f, k) => c + fingerCost(f, events[0].raw[k], true), 0) * 0.5);
    const back = [null];
    for (let e = 1; e < events.length; e++) {
      const A = events[e - 1], B = events[e], gap = B.t - A.t;
      const cost = [], from = [];
      for (let j = 0; j < B.cands.length; j++) {
        const fb = B.cands[j];
        let own = chordCost(fb, B.ps);
        if (fb.length === 1) own += fingerCost(fb[0], B.raw[0], true);
        let best = Infinity, arg = 0;
        for (let i = 0; i < A.cands.length; i++) {
          const fa = A.cands[i];
          // Se comparan los extremos (nota mas grave y mas aguda) de cada evento.
          let t = pairCost(fa[0], A.ps[0], fb[0], B.ps[0], gap);
          if (fa.length > 1 || fb.length > 1) {
            t = (t + pairCost(fa[fa.length - 1], A.ps[A.ps.length - 1], fb[fb.length - 1], B.ps[B.ps.length - 1], gap)) / 2;
          }
          const v = prevCost[i] + t;
          if (v < best) { best = v; arg = i; }
        }
        cost.push(best + own);
        from.push(arg);
      }
      prevCost = cost;
      back.push(from);
    }
    let j = prevCost.indexOf(Math.min(...prevCost));
    for (let e = events.length - 1; e >= 0; e--) {
      const fs = events[e].cands[j];
      events[e].idx.forEach((i, k) => (out[i] = fs[k]));
      if (e > 0) j = back[e][j];
    }
    return out;
  }

  window.Fingering = { assign };
})();
