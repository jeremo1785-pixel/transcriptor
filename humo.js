// Prueba de humo: recorre la app como un usuario y mide si algo falla o se traba.
// Se activa abriendo la app con ?humo en la direccion (por ejemplo
// http://127.0.0.1:8430/?humo). Es el mismo archivo en la PC y en el iPad.
// Usa window.__app, que app.js deja disponible.
(function () {
  if (!/[?&]humo\b/.test(location.search)) return;
  const errors = [];
  window.addEventListener("error", e => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", e => errors.push("promesa: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    const t0 = performance.now();
    while (!fn()) { if (performance.now() - t0 > ms) return false; await sleep(15); }
    return true;
  };
  const frames = async ms => {
    const gaps = [];
    let last = performance.now();
    const end = last + ms;
    while (performance.now() < end) {
      await new Promise(r => requestAnimationFrame(r));
      const n = performance.now();
      gaps.push(n - last);
      last = n;
    }
    gaps.sort((a, b) => a - b);
    // Si la pestaña quedo oculta, el navegador pausa el dibujo: no es la app.
    const hidden = document.visibilityState !== "visible" || gaps[gaps.length - 1] > 2000;
    return { median: gaps[gaps.length >> 1] || 0, worst: gaps[gaps.length - 1] || 0, slow: gaps.filter(g => g > 50).length, hidden };
  };

  async function run() {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:auto 12px 12px auto;z-index:99999;max-width:min(560px,calc(100vw - 24px));max-height:70vh;overflow:auto;" +
      "background:#0f1218;color:#eef1f7;border:1px solid #7b8cff;border-radius:12px;padding:12px 14px;font:12px/1.5 ui-monospace,Consolas,monospace;box-shadow:0 10px 40px #000a";
    box.innerHTML = "<b>Prueba de humo</b> — esperando la biblioteca…";
    document.body.appendChild(box);
    const rows = [];
    const show = (extra = "") => { box.innerHTML = `<b>Prueba de humo</b>${extra}<br>` + rows.join("<br>"); };
    const A = window.__app;
    if (!A) { rows.push("❌ falta window.__app"); show(); return; }

    location.hash = "#/";
    // La lista se arma de a poco (servidor o almacenamiento del iPad): se espera a que aparezca.
    await until(() => document.querySelectorAll(".job").length, 8000);
    const ids = [...document.querySelectorAll(".job.ready")].map(li => li.dataset.id).slice(0, 4);
    if (!ids.length) { rows.push("⚠️ no hay canciones listas para probar"); show(); return; }

    for (const id of ids) {
      const r = { id, problemas: [] };
      const fail = m => r.problemas.push(m);
      const errs0 = errors.length;
      try {
        let t0 = performance.now();
        location.hash = "#/cancion/" + id;
        // Lista de verdad: la cancion nueva (no la anterior, que sigue cargada mientras baja).
        if (!await until(() => A.player.job && A.player.job.id === id && A.player.tracks.length)) fail("no abrió");
        r.abrir = Math.round(performance.now() - t0);
        r.titulo = (A.player.data.title || "").slice(0, 34);
        A.setView("roll");

        // Reproducir: el tiempo tiene que avanzar y las notas dibujarse fluido.
        await A.engine.play();
        const tA = A.engine.time();
        const f = await frames(2500);
        let avanzo = A.engine.time() - tA;
        A.engine.pause();
        if (avanzo < 1.5) fail(`el tiempo avanzó ${avanzo.toFixed(1)} s en 2,5 s`);
        r.cuadro = f.hidden ? "sin medir (pestaña oculta)" : `${f.median.toFixed(0)} ms (peor ${f.worst.toFixed(0)}, lentos ${f.slow})`;
        if (!f.hidden && f.median > 25) fail("dibujo lento");
        if (f.hidden) avanzo = Math.max(avanzo, 2);   // con la pestaña oculta el tiempo igual avanza

        // Saltar, tono y velocidad.
        A.engine.seek(A.player.data.duration * 0.5);
        if (Math.abs(A.engine.time() - A.player.data.duration * 0.5) > 0.5) fail("no saltó al medio");
        document.querySelector("#trUp").click();
        document.querySelector("#trDown").click();
        A.engine.setSpeed(0.7); A.engine.setSpeed(1);

        // Partitura: abrir, pasar de pagina y volver.
        A.sheet.invalidate();
        t0 = performance.now();
        A.setView("sheet");
        await sleep(30);
        if (!await until(() => !A.sheet.loading, 20000)) fail("la partitura no terminó");
        r.partitura = Math.round(performance.now() - t0);
        const msg = document.querySelector("#sheetMsg").textContent;
        if (msg) fail("partitura: " + msg);
        if (A.sheet.pages && A.sheet.pages.length > 1) {
          t0 = performance.now();
          document.querySelector("#pgNext").click();
          r.pagina = Math.round(performance.now() - t0);
          if (r.pagina > 1200) fail("pasar de página lento");
        }
        if (r.partitura > 4000) fail("partitura lenta");
        A.setView("roll");

        // Practica: una tecla tocada tiene que registrarse.
        document.querySelector("#practiceBtn").click();
        await sleep(200);
        if (document.querySelector("#songIntro").hidden) fail("«Practicar» no abrió la ficha");
        document.querySelector("#siGo").click();
        await sleep(400);
        A.practice.noteOn(60);
        if (!A.practice.held.has(60)) fail("la práctica no registró la tecla");
        A.practice.noteOff(60);
        document.querySelector("#practiceBtn").click();

        // Pantalla completa (solo la parte de la app; el navegador puede negarla).
        A.focusMode.toggle(true);
        await sleep(150);
        if (!document.body.classList.contains("focus")) fail("no entró en pantalla completa");
        A.focusMode.toggle(false);
      } catch (e) {
        fail("excepción: " + e.message);
      }
      if (errors.length > errs0) fail("errores: " + errors.slice(errs0).join(" | ").slice(0, 200));
      rows.push(`${r.problemas.length ? "❌" : "✅"} <b>${r.titulo || id}</b> — abrir ${r.abrir} ms · cuadro ${r.cuadro} · partitura ${r.partitura} ms` +
        (r.pagina != null ? ` · página ${r.pagina} ms` : "") + (r.problemas.length ? `<br>&nbsp;&nbsp;⚠️ ${r.problemas.join("; ")}` : ""));
      show(" — probando…");
    }
    // Digitacion: ejercicios con digitacion de libro conocida.
    if (window.Fingering) {
      const seq = (ps, dt = 0.25) => ps.map((p, i) => [i * dt, i * dt + dt * 0.9, p, 80]);
      const chord = ps => ps.map(p => [0, 1, p, 80]);
      const casos = [
        [seq([60, 62, 64, 65, 67, 69, 71, 72]), 1, "1 2 3 1 2 3 4 5"], [seq([72, 71, 69, 67, 65, 64, 62, 60]), 1, "5 4 3 2 1 3 2 1"],
        [seq([48, 50, 52, 53, 55, 57, 59, 60]), 0, "5 4 3 2 1 3 2 1"], [seq([60, 59, 57, 55, 53, 52, 50, 48]), 0, "1 2 3 1 2 3 4 5"],
        [seq([60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84]), 1, "1 2 3 1 2 3 4 1 2 3 1 2 3 4 5"],
        [chord([60, 64, 67]), 1, "1 3 5"], [chord([48, 52, 55]), 0, "5 3 1"], [chord([60, 64, 67, 72]), 1, "1 2 3 5"],
        [seq([60, 64, 67, 72]), 1, "1 2 3 5"], [seq([60, 62, 64, 65, 67, 65, 64, 62, 60]), 1, "1 2 3 4 5 4 3 2 1"],
        [seq([76, 75, 76, 75, 76, 71, 74, 72, 69]), 1, "5 4 5 4 5 2 4 3 1"], [seq([67, 69, 71, 72, 74, 76, 78, 79]), 1, "1 2 3 1 2 3 4 5"],
        [seq([62, 64, 66, 67, 69, 71, 73, 74]), 1, "1 2 3 1 2 3 4 5"], [seq([65, 67, 69, 70, 72, 74, 76, 77]), 1, "1 2 3 4 1 2 3 4"],
        [seq([64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62]), 1, "3 3 4 5 5 4 3 2 1 1 2 3 3 2 2"],
        [seq([62, 61, 59, 57, 55, 54, 52, 50]), 0, "1 2 3 1 2 3 4 5"],
      ];
      const ok = casos.filter(([n, h, want]) => Fingering.assign(n, h).join(" ") === want).length;
      rows.push(`${ok === casos.length ? "✅" : "❌"} <b>Digitación</b> — ${ok} de ${casos.length} ejercicios iguales al libro`);
    }
    location.hash = "#/";
    const bad = rows.filter(x => x.startsWith("❌")).length;
    show(bad ? ` — <span style="color:#ff5d73">${bad} con problemas</span>` : ` — <span style="color:#3ddc97">todo OK</span>`);
    window.__humo = { ok: !bad, rows };
  }
  window.addEventListener("load", () => setTimeout(run, 800));
})();
