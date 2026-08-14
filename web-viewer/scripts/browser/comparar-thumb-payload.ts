// ¿Nuestro lienzo se parece a lo que dibuja la propia app Concepts?
//
// Cada .concepts trae adentro un `thumb.jpg` que renderizo Concepts con el
// dibujo COMPLETO. Es la unica verdad disponible sobre como tiene que verse:
// si nuestro "zoom all" coincide con esa imagen, entonces las fotos estan
// colocadas donde van, escaladas como van, y los trazos caen encima.
//
// La comparacion no puede ser pixel a pixel (rasterizamos distinto, y el
// thumb tiene otra resolucion). Se compara la ESTRUCTURA: se reduce todo a
// una grilla de luminancia normalizada y se mide la correlacion. Una imagen
// con los planos en su sitio correlaciona alto; una a la que le faltan los
// planos, o los tiene corridos, se cae enseguida.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

const REJILLA = 48;

/** Reduce una imagen a una rejilla REJILLA x REJILLA de luminancia, ignorando
 * el brillo/contraste global (se normaliza a media 0 y desvio 1). */
function firma(datos: ImageData): Float64Array {
  const { data, width, height } = datos;
  const out = new Float64Array(REJILLA * REJILLA);
  const cuenta = new Float64Array(REJILLA * REJILLA);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(REJILLA - 1, Math.floor((y / height) * REJILLA));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(REJILLA - 1, Math.floor((x / width) * REJILLA));
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      // Sobre fondo blanco: lo transparente cuenta como blanco.
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * a + 255 * (1 - a);
      out[gy * REJILLA + gx] += l;
      cuenta[gy * REJILLA + gx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cuenta[i] || 1;
  let media = 0;
  for (const v of out) media += v;
  media /= out.length;
  let varianza = 0;
  for (const v of out) varianza += (v - media) ** 2;
  const desvio = Math.sqrt(varianza / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - media) / desvio;
  return out;
}

function correlacion(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

async function aImageData(fuente: CanvasImageSource, w: number, h: number): Promise<ImageData> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(fuente, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  c.width = 0;
  c.height = 0;
  return d;
}

export interface ResultadoComparacion {
  error?: string;
  /** Correlacion 0..1 de nuestro render contra el thumb de Concepts. */
  correlacion: number;
  /** Lo mismo con nuestro render girado 180 grados. */
  correlacionGirado: number;
  /** Correlacion dibujando SOLO los trazos (sin imagenes): sirve de piso. */
  correlacionSoloTrazos: number;
  /** Correlacion dibujando SOLO las imagenes. */
  correlacionSoloImagenes: number;
  thumb: string;
  encuadre: { x0: number; y0: number; x1: number; y1: number };
  aspectoThumb: number;
  aspectoEncuadre: number;
  trazos: number;
  imagenes: number;
  imagenesDibujadas: number;
  /** PNG en base64 de nuestro render, para poder mirarlo. */
  render: string;
  thumbPng: string;
}

export async function compararConThumb(
  url: string,
  headers: Record<string, string>,
  opciones: { lado?: number; soloGrandes?: boolean } = {}
): Promise<ResultadoComparacion> {
  const lado = opciones.lado ?? 512;
  const archivo = await openConceptsRemote(url, headers);
  const blobThumb = await archivo.thumbnail();
  if (!blobThumb) {
    archivo.close();
    return { error: "el archivo no trae thumb.jpg" } as ResultadoComparacion;
  }
  const bmThumb = await createImageBitmap(blobThumb);
  const doc = await archivo.parse();

  // --- Encuadre: el mismo criterio que usa el visor para "zoom all" -------
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
  const cajasImg: Array<{ id: string; m: number[]; w: number; h: number; area: number }> = [];
  for (const l of doc.layers) {
    for (const img of l.images) {
      const m = img.transform;
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
      const xs = [0, img.width].flatMap((x) => [0, img.height].map((y) => a * x + c * y + e));
      const ys = [0, img.width].flatMap((x) => [0, img.height].map((y) => b * x + d * y + f));
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs);
      const by0 = Math.min(...ys), by1 = Math.max(...ys);
      cajasImg.push({ id: img.resourceId, m, w: img.width, h: img.height, area: (bx1 - bx0) * (by1 - by0) });
      if (trazos === 0) {
        if (bx0 < minX) minX = bx0;
        if (by0 < minY) minY = by0;
        if (bx1 > maxX) maxX = bx1;
        if (by1 > maxY) maxY = by1;
      }
    }
  }

  const anchoDoc = maxX - minX;
  const altoDoc = maxY - minY;
  const escala = Math.min(lado / anchoDoc, lado / altoDoc);
  const W = Math.max(1, Math.round(anchoDoc * escala));
  const H = Math.max(1, Math.round(altoDoc * escala));

  // --- Rasterizar los recursos al tamano de este render -------------------
  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => {
    targets[id] = { width: s.width * escala, height: s.height * escala };
  });
  const soloGrandes = opciones.soloGrandes ?? false;
  const idsPedidos = soloGrandes
    ? cajasImg.filter((c) => c.area > 50000).map((c) => c.id)
    : doc.resourceIds;
  const imagenes = await loadResourceImages(doc, {
    targets,
    quality: 1,
    minSide: 64,
    timeoutMs: 120000,
    only: [...new Set(idsPedidos)],
    sinCache: true,
  });

  const pintar = (que: "todo" | "trazos" | "imagenes") => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.scale(escala, escala);
    ctx.translate(-minX, -minY);
    if (que !== "trazos") {
      for (const caja of cajasImg) {
        const recurso = imagenes[caja.id];
        if (!recurso) continue;
        ctx.save();
        const m = caja.m;
        ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
        dibujarRecurso(ctx, recurso, caja.w, caja.h);
        ctx.restore();
      }
    }
    if (que !== "imagenes") {
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
    }
    ctx.restore();
    return c;
  };

  const cTodo = pintar("todo");
  const cTrazos = pintar("trazos");
  const cImgs = pintar("imagenes");

  // El thumb se remuestrea al MISMO tamano que nuestro render: si las
  // proporciones no coinciden, la correlacion cae y eso es justamente lo que
  // hay que detectar (encuadre distinto = algo esta mal colocado).
  const fThumb = firma(await aImageData(bmThumb, W, H));

  // La misma comparacion con NUESTRO render girado 180 grados. Es la forma de
  // contestar, con un numero y no a ojo, si el visor esta dibujando el
  // documento entero cabeza abajo respecto de lo que muestra Concepts.
  const girado = document.createElement("canvas");
  girado.width = W;
  girado.height = H;
  const gctx = girado.getContext("2d", { willReadFrequently: true })!;
  gctx.fillStyle = "#ffffff";
  gctx.fillRect(0, 0, W, H);
  gctx.translate(W, H);
  gctx.rotate(Math.PI);
  gctx.drawImage(cTodo, 0, 0);
  const correlacionGirado = +correlacion(firma(await aImageData(girado, W, H)), fThumb).toFixed(4);
  girado.width = 0;
  const r: ResultadoComparacion = {
    correlacion: +correlacion(firma(await aImageData(cTodo, W, H)), fThumb).toFixed(4),
    correlacionGirado,
    correlacionSoloTrazos: +correlacion(firma(await aImageData(cTrazos, W, H)), fThumb).toFixed(4),
    correlacionSoloImagenes: +correlacion(firma(await aImageData(cImgs, W, H)), fThumb).toFixed(4),
    thumb: `${bmThumb.width}x${bmThumb.height}`,
    encuadre: { x0: +minX.toFixed(0), y0: +minY.toFixed(0), x1: +maxX.toFixed(0), y1: +maxY.toFixed(0) },
    aspectoThumb: +(bmThumb.width / bmThumb.height).toFixed(3),
    aspectoEncuadre: +(anchoDoc / altoDoc).toFixed(3),
    trazos,
    imagenes: cajasImg.length,
    imagenesDibujadas: Object.keys(imagenes).length,
    render: cTodo.toDataURL("image/png"),
    thumbPng: (await (async () => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(bmThumb, 0, 0, W, H);
      return c.toDataURL("image/png");
    })()),
  };

  releaseResourceImages(imagenes);
  bmThumb.close();
  cTodo.width = 0;
  cTrazos.width = 0;
  cImgs.width = 0;
  doc.close();
  archivo.close();
  return r;
}
