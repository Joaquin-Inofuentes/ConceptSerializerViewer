// ¿Las imagenes que el parser dice que hay estan DE VERDAD colocadas en el
// lienzo, y donde?
//
// El parser acepta dos tipos de item como "recurso colocado" (7 y 8). Aceptar
// el 7 multiplico por cinco la cantidad de imagenes del dibujo mas pesado (de
// 21 a 96), asi que antes de dar eso por bueno hay que mirar la GEOMETRIA: un
// item que de verdad esta en el lienzo cae cerca de los trazos y tiene un
// tamano razonable; una entrada de historial o un elemento borrado aparece en
// coordenadas absurdas, o repetido exactamente sobre otro, o con una matriz
// degenerada.
//
// Devuelve, por imagen: caja en coordenadas del documento, escala, rotacion,
// y a que distancia esta del bloque de trazos.

import { openConceptsRemote } from "../../src/VisorConcept/parser";

export interface Colocacion {
  tipoOrigen: number;
  resourceId: string;
  capa: number;
  /** Caja que ocupa en el documento, ya con la matriz aplicada. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ancho: number;
  alto: number;
  escalaX: number;
  escalaY: number;
  rotacion: number;
  /** Area en unidades del documento al cuadrado. */
  area: number;
  /** 0 = cae dentro del bloque de trazos; >0 = distancia al bloque. */
  distanciaATrazos: number;
  /** Fraccion del area de esta imagen que solapa con OTRA imagen identica. */
  duplicadaDe: string | null;
}

export async function auditarColocacion(url: string, headers: Record<string, string>) {
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();

  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let nTrazos = 0;
  const cajasTrazo: Array<[number, number, number, number]> = [];
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      nTrazos++;
      cajasTrazo.push([s.bbox.minX, s.bbox.minY, s.bbox.maxX, s.bbox.maxY]);
      if (s.bbox.minX < sMinX) sMinX = s.bbox.minX;
      if (s.bbox.minY < sMinY) sMinY = s.bbox.minY;
      if (s.bbox.maxX > sMaxX) sMaxX = s.bbox.maxX;
      if (s.bbox.maxY > sMaxY) sMaxY = s.bbox.maxY;
    }
  }

  const colocaciones: Colocacion[] = [];
  doc.layers.forEach((l, capa) => {
    l.images.forEach((img) => {
      const m = img.transform;
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
      const esquinas = [
        [0, 0],
        [img.width, 0],
        [0, img.height],
        [img.width, img.height],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const xs = esquinas.map((p) => p[0]);
      const ys = esquinas.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);

      // Distancia de Chebyshev al bloque de trazos: 0 si la imagen lo toca.
      const dx = Math.max(sMinX - x1, x0 - sMaxX, 0);
      const dy = Math.max(sMinY - y1, y0 - sMaxY, 0);

      colocaciones.push({
        tipoOrigen: 0,
        resourceId: img.resourceId,
        capa,
        x0: +x0.toFixed(1),
        y0: +y0.toFixed(1),
        x1: +x1.toFixed(1),
        y1: +y1.toFixed(1),
        ancho: +(x1 - x0).toFixed(1),
        alto: +(y1 - y0).toFixed(1),
        escalaX: +Math.hypot(a, b).toFixed(4),
        escalaY: +Math.hypot(c, d).toFixed(4),
        rotacion: +((Math.atan2(b, a) * 180) / Math.PI).toFixed(1),
        area: +((x1 - x0) * (y1 - y0)).toFixed(0),
        distanciaATrazos: +Math.hypot(dx, dy).toFixed(1),
        duplicadaDe: null,
      });
    });
  });

  // Duplicados exactos: misma caja (a menos de 1 unidad). Si el tipo 7 fuera
  // historial y no colocacion, se verian muchisimos apilados en el mismo sitio.
  const vistos = new Map<string, string>();
  for (const c of colocaciones) {
    const clave = `${Math.round(c.x0)}|${Math.round(c.y0)}|${Math.round(c.x1)}|${Math.round(c.y1)}`;
    const previo = vistos.get(clave);
    if (previo && previo !== c.resourceId) c.duplicadaDe = previo.slice(0, 8);
    else if (previo) c.duplicadaDe = "misma";
    else vistos.set(clave, c.resourceId);
  }

  // ¿Cuantos TRAZOS caen sobre alguna imagen? Un trazo que no cae sobre
  // ninguna es una anotacion "flotando en el aire".
  let trazosSobreImagen = 0;
  for (const [tx0, ty0, tx1, ty1] of cajasTrazo) {
    const cx = (tx0 + tx1) / 2;
    const cy = (ty0 + ty1) / 2;
    if (colocaciones.some((c) => cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1)) {
      trazosSobreImagen++;
    }
  }

  const r = {
    capas: doc.layers.length,
    trazos: nTrazos,
    imagenes: colocaciones.length,
    recursos: doc.resourceIds.length,
    bboxTrazos:
      nTrazos > 0
        ? { x0: +sMinX.toFixed(0), y0: +sMinY.toFixed(0), x1: +sMaxX.toFixed(0), y1: +sMaxY.toFixed(0) }
        : null,
    trazosSobreImagen,
    pctTrazosSobreImagen: nTrazos ? +((trazosSobreImagen / nTrazos) * 100).toFixed(1) : 0,
    colocaciones,
    bytesNecesariosMB: +(doc.bytesNecesarios / 1048576).toFixed(1),
    totalMB: +(doc.totalBytes / 1048576).toFixed(1),
  };
  doc.close();
  archivo.close();
  return r;
}
