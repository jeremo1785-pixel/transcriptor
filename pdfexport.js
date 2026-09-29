// Partitura en PDF (A4), igual a la que se ve en pantalla: mismas pistas,
// transposicion y nombres de notas. Se dibuja con OpenSheetMusicDisplay en
// paginas A4 y cada pagina pasa al PDF como imagen de alta resolucion (asi los
// simbolos ♯ ♭ y los acentos salen siempre bien, sin depender de fuentes).
// Lo usan la version de PC y la del iPad.
(function () {
  "use strict";

  async function svgToJpeg(svg, scale) {
    const box = svg.getBoundingClientRect();
    const w = svg.width?.baseVal?.value || box.width;
    const h = svg.height?.baseVal?.value || box.height;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const g = canvas.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL("image/jpeg", 0.9), w, h };
  }

  // xml: MusicXML de la partitura. Devuelve un Blob con el PDF.
  window.sheetToPdf = async function (xml, { onProgress } = {}) {
    if (!window.jspdf || !window.opensheetmusicdisplay) throw new Error("Faltan las librerías para el PDF");
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-12000px;top:0;width:900px;background:#fff;";
    document.body.appendChild(host);
    try {
      const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(host, {
        autoResize: false, backend: "svg", pageFormat: "A4_P", pageBackgroundColor: "#FFFFFF",
        drawTitle: true, drawSubtitle: false, drawComposer: true, drawPartNames: true,
        drawingParameters: "default", autoBeam: true,
      });
      await osmd.load(xml);
      osmd.render();
      const svgs = [...host.querySelectorAll("svg")];
      if (!svgs.length) throw new Error("No se pudo dibujar la partitura");
      const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
      for (let i = 0; i < svgs.length; i++) {
        if (onProgress) onProgress(i / svgs.length);
        const pg = await svgToJpeg(svgs[i], 2.2);
        if (i) pdf.addPage();
        // La pagina de OSMD ya tiene proporcion A4; por las dudas se ajusta al ancho.
        const hmm = Math.min(297, (210 * pg.h) / pg.w);
        pdf.addImage(pg.data, "JPEG", 0, 0, 210, hmm, undefined, "FAST");
      }
      return pdf.output("blob");
    } finally {
      host.remove();
    }
  };
})();
