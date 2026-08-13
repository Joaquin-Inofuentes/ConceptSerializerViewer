// Mide, recurso por recurso, cuanto cuesta generar la miniatura de un
// .concepts: que tamaño se le pide a cada recurso, a que tamaño termina
// rasterizado y cuantos ms tarda.

import { parseConceptsFile } from "../../src/VisorConcept/parser";
import { buildRenderPlan, drawnSizes, loadResourceImages } from "../../src/Gallery/renderCore";

export async function probar(url: string, superSample = 256) {
  const buf = await (await fetch(url)).arrayBuffer();
  const t0 = performance.now();
  const doc = await parseConceptsFile(buf);
  const tParse = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const plan = buildRenderPlan(doc);
  const tPlan = Math.round(performance.now() - t1);

  const w = plan.maxX - plan.minX;
  const h = plan.maxY - plan.minY;
  const pad = Math.max(w, h, 1) * 0.08;
  const cw = w + pad * 2;
  const ch = h + pad * 2;
  const scale = Math.min(superSample / cw, superSample / ch);

  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => {
    targets[id] = { width: s.width * scale, height: s.height * scale };
  });

  const tiempos: any[] = [];
  const t2 = performance.now();
  const images = await loadResourceImages(doc, {
    targets,
    quality: 1,
    maxPixels: 1_000_000,
    minSide: 32,
    timeoutMs: 60000,
    concurrency: 3,
    onEach: (id, img) => {
      tiempos.push({
        id: id.slice(0, 8),
        pedido: `${Math.round(targets[id]?.width ?? 0)}x${Math.round(targets[id]?.height ?? 0)}`,
        dibujadoEnDoc: `${Math.round(dibujado[id]?.width ?? 0)}x${Math.round(dibujado[id]?.height ?? 0)}`,
        raster: `${(img as any).width}x${(img as any).height}`,
        msAcumulado: Math.round(performance.now() - t2),
      });
    },
  });
  const tRecursos = Math.round(performance.now() - t2);

  return {
    tParse,
    tPlan,
    tRecursos,
    escalaThumb: +scale.toFixed(5),
    bboxDoc: `${Math.round(w)}x${Math.round(h)}`,
    recursos: Object.keys(doc.resources).length,
    rasterizados: Object.keys(images).length,
    tiempos,
  };
}
