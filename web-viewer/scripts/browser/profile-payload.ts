// Corre DENTRO del navegador (lo sirve Vite en dev). Vive en un modulo real y
// no en un page.evaluate porque necesita `import.meta.url` para resolver el
// worker de pdf.js igual que lo hace la app.
//
// Reproduce paso a paso lo que hace el visor al abrir un .concepts y mide
// cada etapa, incluida la resolucion a la que termina rasterizando cada
// recurso embebido.

import { parseConceptsFile } from "../../src/VisorConcept/parser";
import { EXPORT_SCALE } from "../../src/Gallery/renderCore";

export async function perfilar(url: string) {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const marks: Record<string, number> = {};
  let t = performance.now();
  const mark = (k: string) => {
    marks[k] = Math.round(performance.now() - t);
    t = performance.now();
  };

  const buf = await (await fetch(url)).arrayBuffer();
  mark("fetch");

  const doc = await parseConceptsFile(buf);
  mark("parse");

  let strokes = 0;
  let points = 0;
  let images = 0;
  for (const l of doc.layers) {
    strokes += l.strokes.length;
    images += l.images.length;
    for (const s of l.strokes) points += s.points.length;
  }
  mark("statsTrazos");

  const porRecurso: any[] = [];
  let pxTotales = 0;
  for (const layer of doc.layers) {
    for (const img of layer.images) {
      const blob = doc.resources[img.resourceId];
      if (!blob) {
        porRecurso.push({ id: img.resourceId?.slice(0, 8), falta: true });
        continue;
      }
      const header = await blob.slice(0, 5).text();
      const esPdf = header === "%PDF-";
      const t0 = performance.now();
      const info: any = { id: img.resourceId.slice(0, 8), tipo: esPdf ? "pdf" : "img", MB: +(blob.size / 1048576).toFixed(2) };
      try {
        if (esPdf) {
          const objUrl = URL.createObjectURL(blob);
          const pdf = await pdfjsLib.getDocument({ url: objUrl }).promise;
          const page1 = await pdf.getPage(1);
          const nativo = page1.getViewport({ scale: 1 });
          const tr = img.transform;
          const sx = tr && tr.length === 16 ? Math.hypot(tr[0], tr[1]) : 1;
          const sy = tr && tr.length === 16 ? Math.hypot(tr[4], tr[5]) : 1;
          const targetW = (img.width || nativo.width) * sx * EXPORT_SCALE;
          const targetH = (img.height || nativo.height) * sy * EXPORT_SCALE;
          const needed = Math.max(targetW / nativo.width, targetH / nativo.height);
          const escala = Math.min(Math.max(needed, 2.0), 10);
          const vp = page1.getViewport({ scale: escala });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width;
          canvas.height = vp.height;
          const ctx = canvas.getContext("2d")!;
          const tRender = performance.now();
          await (page1 as any).render({ canvasContext: ctx, viewport: vp }).promise;
          info.msRasterizar = Math.round(performance.now() - tRender);
          info.nativo = `${Math.round(nativo.width)}x${Math.round(nativo.height)}`;
          info.dibujadoEn = `${Math.round((img.width || 0) * sx)}x${Math.round((img.height || 0) * sy)}`;
          info.escalaPedida = +escala.toFixed(2);
          info.canvas = `${canvas.width}x${canvas.height}`;
          info.megapixeles = +((canvas.width * canvas.height) / 1e6).toFixed(1);
          info.ramMB = +((canvas.width * canvas.height * 4) / 1048576).toFixed(1);
          pxTotales += canvas.width * canvas.height;
          const tData = performance.now();
          canvas.toDataURL(); // lo que hace onImagesLoaded para la galeria
          info.msToDataURL = Math.round(performance.now() - tData);
          URL.revokeObjectURL(objUrl);
        } else {
          const objUrl = URL.createObjectURL(blob);
          const el = new Image();
          await new Promise((res, rej) => {
            el.onload = () => res(true);
            el.onerror = rej;
            el.src = objUrl;
          });
          const tr = img.transform;
          const sx = tr && tr.length === 16 ? Math.hypot(tr[0], tr[1]) : 1;
          const sy = tr && tr.length === 16 ? Math.hypot(tr[4], tr[5]) : 1;
          info.nativo = `${el.naturalWidth}x${el.naturalHeight}`;
          info.dibujadoEn = `${Math.round((img.width || 0) * sx)}x${Math.round((img.height || 0) * sy)}`;
          info.megapixeles = +((el.naturalWidth * el.naturalHeight) / 1e6).toFixed(1);
          info.ramMB = +((el.naturalWidth * el.naturalHeight * 4) / 1048576).toFixed(1);
          pxTotales += el.naturalWidth * el.naturalHeight;
        }
      } catch (e) {
        info.error = String(e).slice(0, 140);
      }
      info.msTotal = Math.round(performance.now() - t0);
      porRecurso.push(info);
    }
  }
  mark("recursos");

  return {
    marks,
    strokes,
    points,
    images,
    recursos: doc.resourceIds.length,
    porRecurso,
    megapixelesTotales: +(pxTotales / 1e6).toFixed(1),
    ramImagenesMB: +((pxTotales * 4) / 1048576).toFixed(1),
    heapMB: (performance as any).memory
      ? +((performance as any).memory.usedJSHeapSize / 1048576).toFixed(1)
      : null,
  };
}
