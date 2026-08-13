// Mide el pipeline REAL del visor como si corriera en un telefono de gama
// baja: viewport chico (360x700 @ DPR 2) y pensado para ejecutarse con CPU
// throttling activado desde el runner (bench-lowend.mjs). Ademas de los
// tiempos por etapa, releva cuantos bytes del .concepts hacen falta REALMENTE
// para cada momento del arranque (dato clave para planear descarga parcial
// por rangos) y el pico de heap durante todo el proceso.

import { parseConceptsFile } from "../../src/VisorConcept/parser";
import { ZipArchive } from "../../src/VisorConcept/zip";
import {
  buildRenderPlan,
  drawItems,
  drawnSizes,
  loadResourceImages,
  releaseResourceImages,
} from "../../src/Gallery/renderCore";

export async function medirGamaBaja(url: string) {
  const ancho = 360;
  const alto = 700;
  const DPR = 2;
  const frames = 40;

  let heapPeak = 0;
  const muestrear = () => {
    const m = (performance as any).memory;
    if (m && m.usedJSHeapSize > heapPeak) heapPeak = m.usedJSHeapSize;
  };
  const sampler = setInterval(muestrear, 150);

  const t: Record<string, number> = {};
  let marca = performance.now();
  const paso = (k: string) => {
    t[k] = Math.round(performance.now() - marca);
    marca = performance.now();
  };

  const buf = await (await fetch(url)).arrayBuffer();
  paso("descarga");
  muestrear();

  const doc = await parseConceptsFile(buf);
  paso("parse");
  muestrear();

  let strokes = 0;
  let points = 0;
  for (const l of doc.layers) {
    strokes += l.strokes.length;
    for (const s of l.strokes) points += s.points.length;
  }

  const plan = buildRenderPlan(doc);
  paso("planDeDibujo");

  // --- Cuantos bytes del archivo hacen falta para cada etapa -------------
  // (para planear descarga parcial por rangos HTTP)
  const zip = ZipArchive.open(buf);
  const entradaBytes = (pred: (n: string) => boolean) => {
    let suma = 0;
    for (const [n, e] of zip.entries) if (pred(n)) suma += e.compressedSize;
    return suma;
  };
  const bytesTree = entradaBytes((n) => /(^|\/)tree\.pack$/.test(n));
  const bytesThumb = entradaBytes((n) => /(^|\/)thumb\.jpe?g$/i.test(n));
  const usados = new Set(doc.resourceIds);
  let bytesRecursosUsados = 0;
  for (const [n, e] of zip.entries) {
    const plano = n.replace(/-/g, "");
    for (const uuid of usados) {
      if (plano.includes(uuid.replace(/-/g, ""))) {
        bytesRecursosUsados += e.compressedSize;
        break;
      }
    }
  }
  const treeEntry = [...zip.entries.entries()].find(([n]) => /(^|\/)tree\.pack$/.test(n));
  const treeOffset = treeEntry ? treeEntry[1].localHeaderOffset : -1;

  // Encuadre mobile "zoom all", igual que el visor.
  const cw = plan.maxX - plan.minX || 1;
  const ch = plan.maxY - plan.minY || 1;
  const zoom = Math.max(0.1, Math.min(Math.min((ancho - 40) / cw, (alto - 40) / ch), 5));

  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, size]) => {
    targets[id] = { width: size.width * zoom * DPR, height: size.height * zoom * DPR };
  });

  const inicioRecursos = performance.now();
  let msPrimerRecurso: number | null = null;
  const images = await loadResourceImages(doc, {
    targets,
    quality: 1.25,
    maxPixels: 4_000_000,
    minSide: 256,
    timeoutMs: 120000,
    concurrency: 3,
    onEach: () => {
      muestrear();
      if (msPrimerRecurso === null) msPrimerRecurso = Math.round(performance.now() - inicioRecursos);
    },
  });
  paso("recursos");
  muestrear();

  let pxImagenes = 0;
  for (const img of Object.values(images)) {
    pxImagenes += ((img as any).width || 0) * ((img as any).height || 0);
  }

  // Frames de pan sobre canvas de tamaño telefono.
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(ancho * DPR);
  canvas.height = Math.round(alto * DPR);
  const ctx = canvas.getContext("2d")!;
  const msPorFrame: number[] = [];
  for (let i = 0; i < frames; i++) {
    const f0 = performance.now();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);
    ctx.save();
    ctx.translate(ancho / 2 - ((plan.minX + plan.maxX) / 2) * zoom + i, alto / 2 - ((plan.minY + plan.maxY) / 2) * zoom);
    ctx.scale(zoom, zoom);
    drawItems(ctx, plan.items, images);
    ctx.restore();
    msPorFrame.push(performance.now() - f0);
  }
  paso("frames");

  // Costo de las previews del menu de imagenes (el loop de toDataURL del
  // Viewer), medido aparte porque corre en el hilo principal despues de
  // cargar los recursos.
  const p0 = performance.now();
  for (const fuente of Object.values(images)) {
    const w = (fuente as any).width || 384;
    const h = (fuente as any).height || 384;
    const k = Math.min(384 / Math.max(w, h), 1);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const cctx = c.getContext("2d");
    if (!cctx) continue;
    cctx.drawImage(fuente, 0, 0, c.width, c.height);
    c.toDataURL("image/jpeg", 0.85);
  }
  const msPreviewsMenu = Math.round(performance.now() - p0);

  clearInterval(sampler);
  msPorFrame.sort((a, b) => a - b);

  releaseResourceImages(images);

  return {
    tiempos: t,
    msHastaVerTrazos: t.descarga + t.parse + t.planDeDibujo,
    msHastaPrimeraFoto:
      msPrimerRecurso === null ? null : t.descarga + t.parse + t.planDeDibujo + msPrimerRecurso,
    totalHastaVerDibujo: t.descarga + t.parse + t.planDeDibujo + t.recursos,
    msPreviewsMenu,
    strokes,
    points,
    items: plan.items.length,
    recursosRasterizados: Object.keys(images).length,
    MpxImagenes: +(pxImagenes / 1e6).toFixed(1),
    ramImagenesMB: +((pxImagenes * 4) / 1048576).toFixed(1),
    frameMedianaMs: +msPorFrame[Math.floor(frames / 2)].toFixed(2),
    framePeorMs: +msPorFrame[frames - 1].toFixed(2),
    heapPeakMB: +(heapPeak / 1048576).toFixed(1),
    zipStats: {
      totalMB: +(buf.byteLength / 1048576).toFixed(1),
      entradas: zip.entries.size,
      treePackMB: +(bytesTree / 1048576).toFixed(2),
      thumbKB: +(bytesThumb / 1024).toFixed(1),
      recursosUsadosMB: +(bytesRecursosUsados / 1048576).toFixed(1),
      treeOffsetMB: +(treeOffset / 1048576).toFixed(1),
      necesarioParaTrazosMB: +((bytesTree + bytesThumb) / 1048576).toFixed(2),
      necesarioTotalMB: +((bytesTree + bytesThumb + bytesRecursosUsados) / 1048576).toFixed(1),
    },
  };
}
