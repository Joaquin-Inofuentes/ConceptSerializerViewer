// Alineacion PRECISA contra el thumb, para responder donde tendrian que caer
// las anotaciones.
//
// A diferencia del intento anterior (que buscaba el recorte del thumb sobre el
// render del documento entero, con una grilla gruesa y una correlacion que
// domina la estructura de las paginas), aca se busca imagen POR imagen: se
// renderiza cada plano solo, y se busca la escala y el offset del thumb que
// mejor lo explican. Los planos son ricos y distintivos, asi que ese ajuste es
// fino y confiable.
//
// Con esa correspondencia (thumb px -> coordenadas del documento) se pasa la
// tinta calida del thumb a coordenadas del documento: eso es DONDE Concepts
// dibuja las anotaciones. Se compara con donde las dibujamos nosotros y la
// diferencia es el desface, ya medido sobre una referencia confiable.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

const SIG = 72;

function firmaDeDatos(d: ImageData): Float32Array | null {
  const { data, width, height } = d;
  const out = new Float32Array(SIG * SIG), cnt = new Float32Array(SIG * SIG);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(SIG - 1, ((y / height) * SIG) | 0);
    for (let x = 0; x < width; x++) {
      const gx = Math.min(SIG - 1, ((x / width) * SIG) | 0);
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      out[gy * SIG + gx] += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * a + 255 * (1 - a);
      cnt[gy * SIG + gx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  let m = 0; for (const v of out) m += v; m /= out.length;
  let va = 0; for (const v of out) va += (v - m) ** 2;
  const sd = Math.sqrt(va / out.length);
  if (sd < 2) return null;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
}
const correl = (a: Float32Array, b: Float32Array) => {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
};

export interface ResultadoAlinear {
  error?: string;
  thumb: string;
  /** Cual de las imagenes del documento muestra el thumb, y que tan bien. */
  mejorImagen: { indice: number; resourceId: string; corr: number };
  /** Rectangulo del documento que cubre el thumb, ya resuelto. */
  rectDoc: { x0: number; y0: number; x1: number; y1: number };
  /** Centroide de la tinta de anotacion, en coordenadas del documento. */
  tintaThumb: { x: number; y: number; n: number } | null;
  tintaNuestra: { x: number; y: number; n: number } | null;
  /** Cuanto habria que mover NUESTROS trazos para que caigan como en el thumb. */
  desface: { x: number; y: number } | null;
  comparacion: string;
}

export async function alinearConThumb(url: string, lado = 1300): Promise<ResultadoAlinear> {
  const archivo = await openConceptsRemote(url, {});
  const blobThumb = await archivo.thumbnail();
  if (!blobThumb) { archivo.close(); return { error: "sin thumb.jpg" } as ResultadoAlinear; }
  const bmThumb = await createImageBitmap(blobThumb);
  const anchoT = bmThumb.width, altoT = bmThumb.height;
  const doc = await archivo.parse();

  const cajas: Array<{ id: string; m: number[]; w: number; h: number }> = [];
  for (const l of doc.layers) for (const img of l.images)
    cajas.push({ id: img.resourceId, m: img.transform.slice(), w: img.width, h: img.height });
  const cajaDe = (m: number[], w: number, h: number) => {
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const xs = [0, w].flatMap((x) => [0, h].map((y) => a * x + c * y + e));
    const ys = [0, w].flatMap((x) => [0, h].map((y) => b * x + d * y + f));
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  const dibujado = drawnSizes(doc);
  const escalaRaster = 1;
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => { targets[id] = { width: s.width * escalaRaster, height: s.height * escalaRaster }; });
  const imagenes = await loadResourceImages(doc, { targets, quality: 1, minSide: 48, timeoutMs: 240000, sinCache: true });

  const tmp = document.createElement("canvas");
  tmp.width = SIG * 2; tmp.height = SIG * 2;
  const tx = tmp.getContext("2d", { willReadFrequently: true })!;

  // Firma y tinta calida del thumb, a resolucion util.
  const tw = 300, th = Math.round((300 * altoT) / anchoT);
  const tc = document.createElement("canvas");
  tc.width = tw; tc.height = th;
  const tcx = tc.getContext("2d", { willReadFrequently: true })!;
  tcx.fillStyle = "#fff"; tcx.fillRect(0, 0, tw, th);
  tcx.drawImage(bmThumb, 0, 0, tw, th);
  const datosT = tcx.getImageData(0, 0, tw, th);
  // centroide de tinta calida del thumb, en fracciones del thumb
  let sx = 0, sy = 0, nT = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = (y * tw + x) * 4;
    if (datosT.data[i] - datosT.data[i + 2] > 40 && datosT.data[i] > 60) { sx += x; sy += y; nT++; }
  }
  const tintaFrac = nT > 5 ? { fx: sx / nT / tw, fy: sy / nT / th, n: nT } : null;

  // --- buscar que imagen muestra el thumb, y con que encuadre --------------
  let mejor = { indice: -1, corr: -2, x0: 0, y0: 0, x1: 0, y1: 0 };
  for (let i = 0; i < cajas.length; i++) {
    const caja = cajas[i];
    const rec = imagenes[caja.id];
    if (!rec) continue;
    const b = cajaDe(caja.m, caja.w, caja.h);

    // Lienzo con SOLO esta imagen, generoso alrededor para permitir que el
    // thumb cubra mas o menos que la pagina.
    const anchoB = b.x1 - b.x0, altoB = b.y1 - b.y0;
    const marg = 0.35;
    const X0 = b.x0 - anchoB * marg, X1 = b.x1 + anchoB * marg;
    const Y0 = b.y0 - altoB * marg, Y1 = b.y1 + altoB * marg;
    const esc = Math.min(lado / (X1 - X0), lado / (Y1 - Y0));
    const W = Math.max(1, Math.round((X1 - X0) * esc)), H = Math.max(1, Math.round((Y1 - Y0) * esc));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.scale(esc, esc); ctx.translate(-X0, -Y0);
    ctx.save();
    const m = caja.m;
    ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
    dibujarRecurso(ctx, rec, caja.w, caja.h);
    ctx.restore(); ctx.restore();

    const aspT = anchoT / altoT;
    // El thumb cubre entre el 60% y el 140% de la pagina.
    for (let k = 0; k <= 16; k++) {
      const f = 0.6 * Math.pow(140 / 60, k / 16);
      let cw = (b.x1 - b.x0) * f * esc, ch = cw / aspT;
      if (cw < 20 || ch < 20 || cw > W || ch > H) continue;
      const paso = Math.max(4, cw / 22);
      for (let y = 0; y + ch <= H; y += paso) {
        for (let x = 0; x + cw <= W; x += paso) {
          tx.fillStyle = "#fff"; tx.fillRect(0, 0, tmp.width, tmp.height);
          tx.drawImage(c, x, y, cw, ch, 0, 0, tmp.width, tmp.height);
          const fg = firmaDeDatos(tx.getImageData(0, 0, tmp.width, tmp.height));
          if (!fg) continue;
          const fT = firmaDeDatos(datosT)!;
          const co = correl(fg, fT);
          if (co > mejor.corr) {
            mejor = {
              indice: i, corr: co,
              x0: X0 + x / esc, y0: Y0 + y / esc,
              x1: X0 + (x + cw) / esc, y1: Y0 + (y + ch) / esc,
            };
          }
        }
      }
    }
    c.width = 0;
  }

  // --- donde cae la tinta, en coordenadas del documento -------------------
  const rectDoc = { x0: mejor.x0, y0: mejor.y0, x1: mejor.x1, y1: mejor.y1 };
  const tintaThumb = tintaFrac
    ? {
        x: +(rectDoc.x0 + tintaFrac.fx * (rectDoc.x1 - rectDoc.x0)).toFixed(1),
        y: +(rectDoc.y0 + tintaFrac.fy * (rectDoc.y1 - rectDoc.y0)).toFixed(1),
        n: tintaFrac.n,
      }
    : null;

  // Nuestra tinta calida: centroide de los puntos de trazos calidos que caen
  // dentro (o cerca) del rectangulo del thumb.
  let nx = 0, ny = 0, nn = 0;
  for (const l of doc.layers) for (const s of l.strokes) {
    const c = s.color;
    const R = c.r * 255, B = c.b * 255;
    if (!(R - B > 40 && R > 60)) continue;
    for (const p of s.points) { nx += p.x; ny += p.y; nn++; }
  }
  const tintaNuestra = nn > 5 ? { x: +(nx / nn).toFixed(1), y: +(ny / nn).toFixed(1), n: nn } : null;

  const desface = tintaThumb && tintaNuestra
    ? { x: +(tintaThumb.x - tintaNuestra.x).toFixed(1), y: +(tintaThumb.y - tintaNuestra.y).toFixed(1) }
    : null;

  const b = cajas[mejor.indice] ? cajaDe(cajas[mejor.indice].m, cajas[mejor.indice].w, cajas[mejor.indice].h) : null;
  const comparacion = b
    ? `pagina elegida ocupa (${b.x0.toFixed(0)},${b.y0.toFixed(0)})-(${b.x1.toFixed(0)},${b.y1.toFixed(0)}); el thumb cubre (${rectDoc.x0.toFixed(0)},${rectDoc.y0.toFixed(0)})-(${rectDoc.x1.toFixed(0)},${rectDoc.y1.toFixed(0)})`
    : "sin imagen";

  releaseResourceImages(imagenes);
  tmp.width = 0; tc.width = 0;
  bmThumb.close(); doc.close(); archivo.close();
  return {
    thumb: `${anchoT}x${altoT}`,
    mejorImagen: { indice: mejor.indice, resourceId: cajas[mejor.indice]?.id ?? "", corr: +mejor.corr.toFixed(4) },
    rectDoc: {
      x0: +rectDoc.x0.toFixed(1), y0: +rectDoc.y0.toFixed(1),
      x1: +rectDoc.x1.toFixed(1), y1: +rectDoc.y1.toFixed(1),
    },
    tintaThumb, tintaNuestra, desface, comparacion,
  };
}
