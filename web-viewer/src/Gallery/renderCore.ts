import type { Document } from "../VisorConcept/parser";

// Las coordenadas del documento se asumen en px CSS (96 DPI, el estandar
// web). Para que los PDF/JPG exportados salgan nitidos, todo export
// renderiza el canvas a esta escala (mas pixeles reales) mientras el
// tamaño logico de pagina/imagen queda igual. 150 DPI no alcanzaba para
// leer texto fino (ej. un ticket fotografiado como fondo) porque las
// imagenes se dibujan chicas dentro de un documento con un bbox tambien
// chico — 600 DPI (el estandar para escaneos legibles/OCR) da suficiente
// densidad de pixeles para que ese texto se pueda leer.
export const EXPORT_DPI = 600;
const BASE_DPI = 96;
export const EXPORT_SCALE = EXPORT_DPI / BASE_DPI;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

/** Cuanto mas grande el canvas final donde va a terminar dibujada esta
 * imagen (en px reales), mas alto tiene que rasterizarse el PDF fuente —
 * un multiplicador fijo de escala no alcanza si el PDF es chico en su
 * propio espacio de pagina pero se dibuja grande en el documento. Se
 * calcula el tamaño nativo (scale 1) y se sube la escala hasta cubrir el
 * tamaño real de destino, con un piso (pdfRenderScale) y un techo (10x)
 * para no generar canvases gigantes por error. */
async function loadOneResource(
  resourceId: string,
  blob: Blob,
  loaded: Record<string, CanvasImageSource>,
  pdfRenderScale: number,
  targetSize?: { width: number; height: number }
): Promise<void> {
  const header = await blob.slice(0, 5).text();
  if (header === "%PDF-") {
    const pdfjsLib = await import("pdfjs-dist");
    // El worker tiene que ser same-origin: los navegadores bloquean crear un
    // Worker desde una URL de otro origen (ej. un CDN) aunque el CORS este
    // bien configurado, es una restriccion de seguridad aparte. Se usa el
    // worker local que ya viene empaquetado con pdfjs-dist en vez de bajarlo
    // de cdnjs.
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    const url = URL.createObjectURL(blob);
    try {
      const pdf = await pdfjsLib.getDocument({ url }).promise;
      const page = await pdf.getPage(1);
      let scale = pdfRenderScale;
      if (targetSize && targetSize.width > 0 && targetSize.height > 0) {
        const native = page.getViewport({ scale: 1 });
        const needed = Math.max(
          targetSize.width / native.width,
          targetSize.height / native.height
        );
        scale = Math.min(Math.max(needed, pdfRenderScale), 10);
      }
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport } as any).promise;
        loaded[resourceId] = canvas;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(true);
      img.onerror = reject;
      img.src = url;
    });
    loaded[resourceId] = img;
  }
}

/** Carga todas las imagenes/PDFs embebidos del documento. Un recurso lento o
 * roto (ej. worker de PDF que no carga) no traba el resto: se omite tras el
 * timeout y sigue. `pdfRenderScale` es el piso de resolucion para un PDF
 * embebido usado como "foto" (2.0 alcanza para pantalla). `targetSizes`
 * (opcional, en px del canvas final) permite pedir mas resolucion cuando
 * la imagen va a terminar dibujada grande — sin esto, un PDF fuente chico
 * estirado a un tamaño grande sale pixelado sin importar cuanto DPI se le
 * pida al canvas de salida, porque la fuente ya perdio el detalle. */
export async function loadResourceImages(
  doc: Document,
  pdfRenderScale = 2.0,
  targetSizes?: Record<string, { width: number; height: number }>
): Promise<Record<string, CanvasImageSource>> {
  const loaded: Record<string, CanvasImageSource> = {};
  await Promise.all(
    Object.entries(doc.resources).map(async ([resourceId, blob]) => {
      try {
        await withTimeout(
          loadOneResource(resourceId, blob, loaded, pdfRenderScale, targetSizes?.[resourceId]),
          8000
        );
      } catch (e) {
        console.error("Recurso omitido por timeout/error", resourceId, e);
      }
    })
  );
  return loaded;
}

export type RenderItem =
  | { type: "stroke"; path: Path2D; color: string; alpha: number; width: number; layerIndex: number }
  | {
      type: "image";
      resourceId: string;
      transform: number[];
      width: number;
      height: number;
      layerIndex: number;
    };

export interface RenderPlan {
  items: RenderItem[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasContent: boolean;
}

/**
 * Junta los trazos e imagenes del documento en items dibujables, y calcula
 * el encuadre ("zoom all"). Dos pasadas separadas y no una por capa: primero
 * TODOS los trazos de TODAS las capas para saber si el documento tiene
 * trazos, y recien despues las imagenes. Si se mezclan en una pasada por
 * capa, una capa de solo-imagenes que aparece antes de una capa con trazos
 * alcanza a expandir el encuadre con la imagen antes de saber que hay
 * trazos, dando un encuadre mal ajustado.
 */
export function buildRenderPlan(doc: Document): RenderPlan {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasStrokes = false;
  const items: RenderItem[] = [];

  doc.layers.forEach((layer) => {
    layer.strokes.forEach((stroke) => {
      if (stroke.points.length === 0) return;
      hasStrokes = true;
      const path = new Path2D();
      path.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.forEach((p) => path.lineTo(p.x, p.y));
      if (stroke.bbox.minX < minX) minX = stroke.bbox.minX;
      if (stroke.bbox.minY < minY) minY = stroke.bbox.minY;
      if (stroke.bbox.maxX > maxX) maxX = stroke.bbox.maxX;
      if (stroke.bbox.maxY > maxY) maxY = stroke.bbox.maxY;
      items.push({
        type: "stroke",
        path,
        color: stroke.color.hex.slice(0, 7),
        alpha: stroke.color.a,
        width: stroke.width || 1.5,
        layerIndex: layer.index,
      });
    });
  });

  doc.layers.forEach((layer) => {
    layer.images.forEach((img) => {
      const tx = img.transform[12];
      const ty = img.transform[13];
      const w = img.width || 500;
      const h = img.height || 500;
      items.push({
        type: "image",
        resourceId: img.resourceId,
        transform: img.transform,
        width: img.width,
        height: img.height,
        layerIndex: layer.index,
      });
      if (!hasStrokes) {
        if (tx < minX) minX = tx;
        if (ty < minY) minY = ty;
        if (tx + w > maxX) maxX = tx + w;
        if (ty + h > maxY) maxY = ty + h;
      }
    });
  });

  return { items, minX, minY, maxX, maxY, hasContent: minX !== Infinity };
}

/** Dibuja los items (ya ordenados por capa) sobre un contexto ya
 * trasladado/escalado por el que llama. */
export function drawItems(
  ctx: CanvasRenderingContext2D,
  items: RenderItem[],
  images: Record<string, CanvasImageSource>
) {
  const sorted = [...items].sort((a, b) => a.layerIndex - b.layerIndex);
  for (const item of sorted) {
    if (item.type === "image") {
      const imgObj = images[item.resourceId];
      if (!imgObj) continue;
      ctx.save();
      const m = item.transform;
      if (m && m.length === 16) ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
      if (item.width && item.height) ctx.drawImage(imgObj, 0, 0, item.width, item.height);
      else ctx.drawImage(imgObj, 0, 0);
      ctx.restore();
    } else {
      ctx.strokeStyle = item.color;
      ctx.globalAlpha = item.alpha;
      ctx.lineWidth = item.width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke(item.path);
    }
  }
}
