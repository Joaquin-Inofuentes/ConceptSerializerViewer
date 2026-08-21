import type { Document, ConceptsFile } from "../VisorConcept/parser";
import { readEmbeddedThumbnail, readEmbeddedThumbnailRemote } from "../VisorConcept/parser";
import { BufferSource } from "../VisorConcept/zip";
import { THUMBNAIL_SIZE } from "../config";
import { getBudgets } from "../device";
import type { RecursoRasterizado } from "./renderCore";
import {
  loadResourceImages,
  releaseResourceImages,
  buildRenderPlan,
  drawItems,
  drawnSizes,
} from "./renderCore";

/** Encuadra la imagen a su contenido (descarta el papel en blanco de los
 * bordes) y la mete en un cuadrado de `size`. La vista previa que guarda
 * Concepts es una captura del lienzo, con bastante hoja vacia alrededor; sin
 * recortar, en una tarjeta de 150 px el dibujo queda como una manchita. */
function encuadrarAContenido(
  fuente: CanvasImageSource,
  anchoFuente: number,
  altoFuente: number,
  size: number
): string {
  const work = document.createElement("canvas");
  work.width = anchoFuente;
  work.height = altoFuente;
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  wctx.drawImage(fuente, 0, 0);

  let minX = anchoFuente;
  let minY = altoFuente;
  let maxX = -1;
  let maxY = -1;
  try {
    const data = wctx.getImageData(0, 0, anchoFuente, altoFuente).data;
    // Muestreo cada PASO px, no pixel a pixel: el bounding box que importa
    // aca es el de un recorte con margen del 4% (ver `pad` mas abajo), asi
    // que perder 2-3 px de precision en cada borde no se nota, y en una
    // vista previa de ~2000x1500 esto es 4-16x menos iteraciones en el hilo
    // principal, corriendo ademas dentro del pool de miniaturas (varias en
    // paralelo). El piso de PASO=1 para fuentes chicas evita perder el
    // contenido de una vista previa diminuta.
    const PASO = Math.max(1, Math.floor(Math.min(anchoFuente, altoFuente) / 400));
    for (let y = 0; y < altoFuente; y += PASO) {
      for (let x = 0; x < anchoFuente; x += PASO) {
        const i = (y * anchoFuente + x) * 4;
        // Umbral alto: el fondo es papel casi blanco, no blanco puro.
        if (data[i] > 243 && data[i + 1] > 243 && data[i + 2] > 243) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  } catch {
    // getImageData puede fallar por canvas "tainted"; se usa la imagen entera.
  }
  if (maxX < 0) {
    minX = 0; minY = 0; maxX = anchoFuente - 1; maxY = altoFuente - 1;
  }

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04) + 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(anchoFuente - 1, maxX + pad);
  maxY = Math.min(altoFuente - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const octx = out.getContext("2d")!;
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, size, size);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  const k = Math.min(size / cw, size / ch);
  const dw = cw * k;
  const dh = ch * k;
  octx.drawImage(work, minX, minY, cw, ch, (size - dw) / 2, (size - dh) / 2, dw, dh);
  const resultado = out.toDataURL("image/jpeg", 0.82);
  // En iOS/Android el backing store de un canvas no vuelve solo hasta el
  // GC (mismo motivo que `liberarImagen` en renderCore.ts): con 3+
  // miniaturas procesandose en paralelo por carpeta, sin esto quedan
  // canvases enteros de la vista previa (hasta unos MB cada uno) vivos mas
  // tiempo del necesario.
  work.width = 0;
  work.height = 0;
  out.width = 0;
  out.height = 0;
  return resultado;
}

/**
 * Miniatura a partir de la vista previa que Concepts guarda dentro del
 * archivo. Es el camino rapido: no hay que parsear el documento ni
 * rasterizar PDFs. Devuelve null si el archivo no trae vista previa.
 */
export async function thumbnailFromEmbedded(
  fileBuffer: ArrayBuffer,
  size = THUMBNAIL_SIZE
): Promise<string | null> {
  const blob = await readEmbeddedThumbnail(new BufferSource(fileBuffer));
  if (!blob) return null;
  return desdeVistaPrevia(blob, size);
}

/**
 * Igual que thumbnailFromEmbedded pero SIN bajar el archivo: lee por rangos
 * HTTP solo el indice del zip y la entrada `thumb.jpg`. Para el dibujo de
 * 262,9 MB eso son ~110 KB en vez de 262 MB: 2400 veces menos datos para el
 * mismo resultado.
 */
export async function thumbnailFromRemote(
  url: string,
  headers: Record<string, string> = {},
  size = THUMBNAIL_SIZE
): Promise<string | null> {
  const blob = await readEmbeddedThumbnailRemote(url, headers);
  if (!blob) return null;
  return desdeVistaPrevia(blob, size);
}

/**
 * Miniatura de un archivo YA ABIERTO. Usa la vista previa embebida si esta
 * (el 100% de los .concepts de la carpeta real la traen) y solo si falta
 * dibuja el documento. Recibe el archivo abierto en vez de una URL para no
 * pagar dos veces la lectura del indice del zip.
 */
export async function thumbnailDeArchivo(
  archivo: ConceptsFile,
  size = THUMBNAIL_SIZE
): Promise<{ dataUrl: string; bytesFuente: number }> {
  const blob = await archivo.thumbnail();
  if (blob) {
    const dataUrl = await desdeVistaPrevia(blob, size);
    if (dataUrl) return { dataUrl, bytesFuente: 0 };
  }
  // Sin vista previa embebida hay que dibujar el documento. Igual se lee por
  // rangos: solo baja tree.pack + los recursos efectivamente colocados.
  const doc = await archivo.parse();
  try {
    return { dataUrl: await renderThumbnailDataUrl(doc, size), bytesFuente: doc.totalBytes };
  } finally {
    doc.close();
  }
}

async function desdeVistaPrevia(blob: Blob, size: number): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    return encuadrarAContenido(bitmap, bitmap.width, bitmap.height, size);
  } finally {
    bitmap.close();
  }
}

/**
 * Renderiza trazos E imagenes/fotos embebidas del documento a una miniatura
 * JPEG cuadrada. Dibuja primero en un canvas grande (mejor anti-aliasing) y
 * despues lo reduce a `finalSize` con el downscale del navegador.
 *
 * Los recursos embebidos se rasterizan al tamaño que ocupan DENTRO de esa
 * miniatura (pocos cientos de px como mucho), no a una escala fija: un PDF
 * de fondo rasterizado a "escala 2" son decenas de megapixeles tirados para
 * terminar en una imagen de 32x32.
 */
export async function renderThumbnailDataUrl(
  doc: Document,
  finalSize = THUMBNAIL_SIZE,
  superSample = 512
): Promise<string> {
  const plan = buildRenderPlan(doc);

  const big = document.createElement("canvas");
  big.width = superSample;
  big.height = superSample;
  const ctx = big.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, superSample, superSample);

  let images: Record<string, RecursoRasterizado> = {};

  if (plan.hasContent) {
    let { minX, minY, maxX, maxY } = plan;
    const w = maxX - minX;
    const h = maxY - minY;
    const pad = Math.max(w, h, 1) * 0.08;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const cw = maxX - minX;
    const ch = maxY - minY;
    const scale = Math.min(superSample / cw, superSample / ch);
    const offsetX = (superSample - cw * scale) / 2;
    const offsetY = (superSample - ch * scale) / 2;

    // Tamaño de cada recurso ya expresado en px de ESTE canvas.
    const dibujado = drawnSizes(doc);
    const targets: Record<string, { width: number; height: number }> = {};
    Object.entries(dibujado).forEach(([id, size]) => {
      targets[id] = { width: size.width * scale, height: size.height * scale };
    });

    // Antes fijos (1 Mpx / 8 Mpx / concurrency 4), ignorando el dispositivo.
    // Como esto se invoca desde varios `processItem` de la galeria a la vez
    // (ver `getBudgets().concurrency` en Gallery.tsx), el techo efectivo se
    // multiplicaba por esa cantidad de llamadas simultaneas: en gama baja
    // (12 Mpx / 48 MB de presupuesto TOTAL de imagenes) unas pocas
    // miniaturas en paralelo ya doblaban el presupuesto pensado para todo
    // el documento que el usuario tiene abierto.
    const budgets = getBudgets();
    images = await loadResourceImages(doc, {
      targets,
      quality: 1,
      maxPixels: Math.min(1_000_000, budgets.maxPixelsPerResource),
      maxTotalPixels: Math.min(8_000_000, budgets.maxImagePixels),
      minSide: 32,
      timeoutMs: 20000,
      concurrency: budgets.concurrency,
      // La miniatura pide una resolucion diminuta que no le sirve a nadie mas;
      // cachearla desalojaria las versiones utiles.
      sinCache: true,
    });

    ctx.save();
    ctx.translate(offsetX - minX * scale, offsetY - minY * scale);
    ctx.scale(scale, scale);
    drawItems(ctx, plan.items, images);
    ctx.restore();
  }

  const small = document.createElement("canvas");
  small.width = finalSize;
  small.height = finalSize;
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(big, 0, 0, superSample, superSample, 0, 0, finalSize, finalSize);

  releaseResourceImages(images);
  const resultado = small.toDataURL("image/jpeg", 0.85);
  // Ver el comentario equivalente en `encuadrarAContenido`: liberar el
  // backing store de inmediato en vez de esperar al GC.
  big.width = 0;
  big.height = 0;
  small.width = 0;
  small.height = 0;
  return resultado;
}
