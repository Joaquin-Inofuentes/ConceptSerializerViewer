// Mide el pipeline REAL del visor, end to end, con el codigo que corre en
// produccion: abrir el zip, parsear, armar el plan de dibujo, rasterizar los
// recursos a resolucion de pantalla y dibujar frames.
//
// Devuelve tiempos por etapa, memoria de imagenes y ms por frame de pan/zoom,
// que es lo que define si "se traba" o no.

import { parseConceptsFile } from "../../src/VisorConcept/parser";
import {
  buildRenderPlan,
  drawItems,
  drawnSizes,
  loadResourceImages,
  releaseResourceImages,
} from "../../src/Gallery/renderCore";

export async function medirVisor(url: string, opts: { ancho?: number; alto?: number; frames?: number } = {}) {
  const ancho = opts.ancho ?? 1440;
  const alto = opts.alto ?? 900;
  const frames = opts.frames ?? 30;
  const DPR = 2;

  const t: Record<string, number> = {};
  let marca = performance.now();
  const paso = (k: string) => {
    t[k] = Math.round(performance.now() - marca);
    marca = performance.now();
  };

  const buf = await (await fetch(url)).arrayBuffer();
  paso("descarga");

  const doc = await parseConceptsFile(buf);
  paso("parse");

  let strokes = 0;
  let points = 0;
  for (const l of doc.layers) {
    strokes += l.strokes.length;
    for (const s of l.strokes) points += s.points.length;
  }

  const plan = buildRenderPlan(doc);
  paso("planDeDibujo");

  // Encuadre "zoom all", igual que hace el visor al abrir.
  const cw = plan.maxX - plan.minX || 1;
  const ch = plan.maxY - plan.minY || 1;
  const zoom = Math.max(0.1, Math.min(Math.min((ancho - 80) / cw, (alto - 80) / ch), 5));

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
    timeoutMs: 30000,
    concurrency: 3,
    onEach: () => {
      if (msPrimerRecurso === null) msPrimerRecurso = Math.round(performance.now() - inicioRecursos);
    },
  });
  paso("recursos");

  let pxImagenes = 0;
  const detalleRecursos = Object.entries(images).map(([id, img]) => {
    const w = (img as any).width || 0;
    const h = (img as any).height || 0;
    pxImagenes += w * h;
    return { id: id.slice(0, 8), canvas: `${w}x${h}`, Mpx: +((w * h) / 1e6).toFixed(2) };
  });

  // Frames de pan/zoom sobre el mismo canvas, midiendo el peor caso.
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

  msPorFrame.sort((a, b) => a - b);
  const heap = (performance as any).memory
    ? +((performance as any).memory.usedJSHeapSize / 1048576).toFixed(1)
    : null;

  releaseResourceImages(images);

  return {
    tiempos: t,
    // Lo que de verdad importa: cuanto tarda en verse ALGO (los trazos ya
    // estan dibujados apenas termina el plan) y cuanto la primera foto.
    msHastaVerTrazos: t.descarga + t.parse + t.planDeDibujo,
    msHastaPrimeraFoto: msPrimerRecurso === null ? null : t.descarga + t.parse + t.planDeDibujo + msPrimerRecurso,
    totalHastaVerDibujo: t.descarga + t.parse + t.planDeDibujo + t.recursos,
    strokes,
    points,
    items: plan.items.length,
    recursosUsados: doc.resourceIds.length,
    recursosRasterizados: detalleRecursos.length,
    MpxImagenes: +(pxImagenes / 1e6).toFixed(1),
    ramImagenesMB: +((pxImagenes * 4) / 1048576).toFixed(1),
    frameMedianaMs: +msPorFrame[Math.floor(frames / 2)].toFixed(2),
    framePeorMs: +msPorFrame[frames - 1].toFixed(2),
    heapMB: heap,
    detalleRecursos,
  };
}
