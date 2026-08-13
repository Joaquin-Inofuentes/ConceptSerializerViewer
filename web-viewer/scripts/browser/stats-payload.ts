// Corre dentro del navegador: parsea un .concepts y devuelve solo metricas
// (sin renderizar nada). Sirve para saber, sobre TODO el corpus, si el peso
// esta en los trazos o en los recursos embebidos.

import { parseConceptsFile } from "../../src/VisorConcept/parser";

export async function medir(url: string) {
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  const tFetch = performance.now() - t0;

  const t1 = performance.now();
  const doc = await parseConceptsFile(buf);
  const tParse = performance.now() - t1;

  let strokes = 0;
  let points = 0;
  let images = 0;
  let maxPuntosTrazo = 0;
  for (const l of doc.layers) {
    strokes += l.strokes.length;
    images += l.images.length;
    for (const s of l.strokes) {
      const n = (s as any).pointCount ?? (s as any).points?.length ?? 0;
      points += n;
      if (n > maxPuntosTrazo) maxPuntosTrazo = n;
    }
  }

  let bytesRecursos = 0;
  for (const b of Object.values(doc.resources)) bytesRecursos += (b as Blob).size;

  return {
    tFetch: Math.round(tFetch),
    tParse: Math.round(tParse),
    layers: doc.layers.length,
    strokes,
    points,
    maxPuntosTrazo,
    images,
    recursos: Object.keys(doc.resources).length,
    MBrecursos: +(bytesRecursos / 1048576).toFixed(2),
  };
}
