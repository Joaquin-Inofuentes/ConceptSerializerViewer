// Audita la geometria de un .concepts: matrices de transform de cada imagen,
// bbox de los trazos, y si imagenes y trazos se solapan. Sirve para contestar
// con datos "¿las imagenes estan invertidas?" y "¿los dibujos coinciden?".

import { openConceptsRemote } from "../../src/VisorConcept/parser";

export async function auditar(url: string, headers: Record<string, string>) {
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();

  // Bbox de los trazos (lo que el usuario dibujo a mano).
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let nTrazos = 0;
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      nTrazos++;
      if (s.bbox.minX < sMinX) sMinX = s.bbox.minX;
      if (s.bbox.minY < sMinY) sMinY = s.bbox.minY;
      if (s.bbox.maxX > sMaxX) sMaxX = s.bbox.maxX;
      if (s.bbox.maxY > sMaxY) sMaxY = s.bbox.maxY;
    }
  }

  // Por cada imagen colocada: matriz, escalas con signo y caja resultante.
  const imagenes: any[] = [];
  let iMinX = Infinity, iMinY = Infinity, iMaxX = -Infinity, iMaxY = -Infinity;
  for (const l of doc.layers) {
    for (const img of l.images) {
      const m = img.transform;
      // Canvas usa transform(a,b,c,d,e,f) = (m0,m1,m4,m5,m12,m13).
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], fy = m[13];
      // Las cuatro esquinas del recurso, ya transformadas.
      const esquinas = [
        [0, 0],
        [img.width, 0],
        [0, img.height],
        [img.width, img.height],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + fy]);
      const xs = esquinas.map((p) => p[0]);
      const ys = esquinas.map((p) => p[1]);
      const caja = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      iMinX = Math.min(iMinX, caja.minX); iMaxX = Math.max(iMaxX, caja.maxX);
      iMinY = Math.min(iMinY, caja.minY); iMaxY = Math.max(iMaxY, caja.maxY);

      imagenes.push({
        id: img.resourceId.slice(0, 8),
        nativo: `${Math.round(img.width)}x${Math.round(img.height)}`,
        // det < 0 => la matriz invierte (espeja) la imagen.
        determinante: +(a * d - b * c).toFixed(4),
        escalaX: +Math.hypot(a, b).toFixed(3),
        escalaY: +Math.hypot(c, d).toFixed(3),
        signos: { a: Math.sign(a), b: Math.sign(b), c: Math.sign(c), d: Math.sign(d) },
        // Rotacion implicita en grados (0 = sin rotar).
        rotacionGrados: +((Math.atan2(b, a) * 180) / Math.PI).toFixed(2),
        traslacion: `${Math.round(e)},${Math.round(fy)}`,
        caja: `${Math.round(caja.minX)},${Math.round(caja.minY)} .. ${Math.round(caja.maxX)},${Math.round(caja.maxY)}`,
      });
    }
  }

  // ¿Se solapan trazos e imagenes? Si los trazos son anotaciones SOBRE los
  // planos, la interseccion deberia cubrir casi todo el bbox de los trazos.
  const ix = Math.max(0, Math.min(sMaxX, iMaxX) - Math.max(sMinX, iMinX));
  const iy = Math.max(0, Math.min(sMaxY, iMaxY) - Math.max(sMinY, iMinY));
  const areaTrazos = Math.max(1, (sMaxX - sMinX) * (sMaxY - sMinY));

  const r = {
    trazos: nTrazos,
    bboxTrazos: `${Math.round(sMinX)},${Math.round(sMinY)} .. ${Math.round(sMaxX)},${Math.round(sMaxY)}`,
    bboxImagenes: `${Math.round(iMinX)},${Math.round(iMinY)} .. ${Math.round(iMaxX)},${Math.round(iMaxY)}`,
    solapeConTrazosPct: +(((ix * iy) / areaTrazos) * 100).toFixed(1),
    conDeterminanteNegativo: imagenes.filter((i) => i.determinante < 0).length,
    conRotacion: imagenes.filter((i) => Math.abs(i.rotacionGrados) > 0.5).length,
    total: imagenes.length,
    imagenes,
  };
  doc.close();
  archivo.close();
  return r;
}
