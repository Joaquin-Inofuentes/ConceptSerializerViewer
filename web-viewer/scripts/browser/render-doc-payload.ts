// Renderiza un .concepts completo a PNG con el mismo camino que usa el visor
// (parser + renderCore), y devuelve tambien el thumb.jpg que dibujo la propia
// app Concepts. Es la base de `verificar-colocacion.mjs`: permite comparar
// nuestro render contra el de la app sin depender de la UI.
import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

export interface CajaImagen {
  resourceId: string;
  /** Centro de la imagen en coordenadas de canvas del documento. */
  centro: [number, number];
  ancho: number;
  alto: number;
  isPhoto?: boolean;
  /** Orientacion EXIF del recurso, tal como la resolvio el rasterizador. */
  exif?: number;
}

export async function renderDocumento(url: string, lado = 900) {
  const archivo = await openConceptsRemote(url, {});
  const doc = await archivo.parse();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let trazos = 0;
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      trazos++;
      if (s.bbox.minX < minX) minX = s.bbox.minX;
      if (s.bbox.minY < minY) minY = s.bbox.minY;
      if (s.bbox.maxX > maxX) maxX = s.bbox.maxX;
      if (s.bbox.maxY > maxY) maxY = s.bbox.maxY;
    }
  }
  const cajas: Array<{ id: string; m: number[]; w: number; h: number; isPhoto?: boolean }> = [];
  for (const l of doc.layers) {
    for (const img of l.images) {
      const m = img.transform;
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
      const xs = [0, img.width].flatMap((x) => [0, img.height].map((y) => a * x + c * y + e));
      const ys = [0, img.width].flatMap((x) => [0, img.height].map((y) => b * x + d * y + f));
      cajas.push({ id: img.resourceId, m, w: img.width, h: img.height, isPhoto: img.isPhoto });
      minX = Math.min(minX, ...xs); maxX = Math.max(maxX, ...xs);
      minY = Math.min(minY, ...ys); maxY = Math.max(maxY, ...ys);
    }
  }

  const anchoDoc = maxX - minX, altoDoc = maxY - minY;
  const escala = Math.min(lado / anchoDoc, lado / altoDoc);
  const W = Math.max(1, Math.round(anchoDoc * escala));
  const H = Math.max(1, Math.round(altoDoc * escala));

  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => {
    targets[id] = { width: s.width * escala, height: s.height * escala };
  });
  const imagenes = await loadResourceImages(doc, {
    targets, quality: 1, minSide: 64, timeoutMs: 180000, sinCache: true, sinWorker: true,
  });

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.scale(escala, escala);
  ctx.translate(-minX, -minY);
  for (const caja of cajas) {
    const recurso = imagenes[caja.id];
    if (!recurso) continue;
    ctx.save();
    const m = caja.m;
    ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
    dibujarRecurso(ctx, recurso, caja.w, caja.h);
    ctx.restore();
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      if (s.points.length === 0) continue;
      const p = new Path2D();
      p.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) p.lineTo(s.points[i].x, s.points[i].y);
      ctx.strokeStyle = s.color.hex.slice(0, 7);
      ctx.globalAlpha = s.color.a;
      ctx.lineWidth = s.width || 1.5;
      ctx.stroke(p);
    }
  }
  ctx.restore();
  const png = c.toDataURL("image/png");

  const thumbBlob = await archivo.thumbnail();
  let thumbPng: string | null = null;
  if (thumbBlob) {
    const bm = await createImageBitmap(thumbBlob);
    const tc = document.createElement("canvas");
    tc.width = bm.width; tc.height = bm.height;
    tc.getContext("2d")!.drawImage(bm, 0, 0);
    thumbPng = tc.toDataURL("image/png");
    bm.close();
  }

  // Ficha por imagen, para poder auditar la colocacion sin mirar el PNG.
  const fichas: CajaImagen[] = cajas.map((caja) => {
    const m = caja.m;
    const cx = m[0] * (caja.w / 2) + m[4] * (caja.h / 2) + m[12];
    const cy = m[1] * (caja.w / 2) + m[5] * (caja.h / 2) + m[13];
    return {
      resourceId: caja.id,
      centro: [+cx.toFixed(2), +cy.toFixed(2)],
      ancho: caja.w,
      alto: caja.h,
      isPhoto: caja.isPhoto,
      exif: imagenes[caja.id]?.exif,
    };
  });

  releaseResourceImages(imagenes);
  c.width = 0;
  doc.close();
  archivo.close();
  return { png, thumbPng, fichas, trazos, encuadre: { minX, minY, maxX, maxY }, escala, W, H };
}
