// Renderiza un PDF a PNG usando el mismo pdf.js que usa la app. Sirve para
// mirar lo que de verdad salio exportado, no lo que uno cree que salio.
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export async function renderPdf(url: string, lado = 1400) {
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  const paginas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pg = await pdf.getPage(n);
    const vp0 = pg.getViewport({ scale: 1 });
    const esc = Math.min(lado / vp0.width, lado / vp0.height);
    const vp = pg.getViewport({ scale: esc });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    await (pg as any).render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c }).promise;
    paginas.push({ n, w: Math.round(vp0.width), h: Math.round(vp0.height), png: c.toDataURL("image/png") });
    c.width = 0;
  }
  return { numPages: pdf.numPages, paginas };
}
