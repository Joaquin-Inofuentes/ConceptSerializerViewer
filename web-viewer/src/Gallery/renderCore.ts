import type { Document } from "../VisorConcept/parser";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

async function loadOneResource(
  resourceId: string,
  blob: Blob,
  loaded: Record<string, CanvasImageSource>
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
      const viewport = page.getViewport({ scale: 2.0 });
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
 * timeout y sigue. */
export async function loadResourceImages(doc: Document): Promise<Record<string, CanvasImageSource>> {
  const loaded: Record<string, CanvasImageSource> = {};
  await Promise.all(
    Object.entries(doc.resources).map(async ([resourceId, blob]) => {
      try {
        await withTimeout(loadOneResource(resourceId, blob, loaded), 8000);
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
