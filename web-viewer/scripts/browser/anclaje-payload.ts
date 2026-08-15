// ¿Donde esta el (0,0) local de un recurso colocado?
//
// El giro de 180 grados se aplica IGUAL a los trazos (girarPunto) y a las
// matrices (girarTransform), asi que no puede meter un desface entre unos y
// otros: la geometria relativa que dibujamos es la del dato crudo. Lo unico
// que elegimos nosotros al dibujar es que rectangulo local ocupa el recurso.
// Hoy usamos [0,w] x [0,h] (esquina superior izquierda). Puede ser cualquier
// otro anclaje.
//
// Esto prueba las 9 combinaciones (alfa, beta en 0, 0.5, 1) y las juzga con
// el thumb.jpg de Concepts:
//
//   1. Con cada anclaje se renderizan las IMAGENES solas y se busca en que
//      parte cae el recorte del thumb (los planos son grandes y estructurados,
//      esa busqueda es la parte confiable).
//   2. En esa zona se compara la TINTA CALIDA (R-B > 40, que aisla las
//      anotaciones a mano de los planos grises y azules) contra la del thumb.
//
// Gana el anclaje que hace que las anotaciones caigan donde Concepts las
// dibuja, SIN ningun corrimiento extra. Si ninguno sube de cero, el problema
// no es el anclaje.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

const SIG = 64;

function firma(d: ImageData): Float32Array | null {
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

export interface ResultadoAnclaje {
  error?: string;
  thumbPng: string;
  variantes: Array<{
    alfa: number; beta: number; nombre: string;
    zonaCorr: number;   // que tan bien encajo el thumb usando las imagenes
    tinta: number;      // solapamiento de anotaciones (0 = no se tocan)
    recorte: string;
  }>;
}

export async function probarAnclajes(url: string, lado = 1000): Promise<ResultadoAnclaje> {
  const archivo = await openConceptsRemote(url, {});
  const blobThumb = await archivo.thumbnail();
  if (!blobThumb) { archivo.close(); return { error: "sin thumb.jpg" } as ResultadoAnclaje; }
  const bmThumb = await createImageBitmap(blobThumb);
  const aspecto = bmThumb.width / bmThumb.height;
  const doc = await archivo.parse();

  const cajas: Array<{ id: string; m: number[]; w: number; h: number }> = [];
  for (const l of doc.layers) for (const img of l.images)
    cajas.push({ id: img.resourceId, m: img.transform.slice(), w: img.width, h: img.height });
  const trazosBb: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const l of doc.layers) for (const s of l.strokes)
    trazosBb.push({ x0: s.bbox.minX, y0: s.bbox.minY, x1: s.bbox.maxX, y1: s.bbox.maxY });

  /** Matriz con el anclaje corrido a (alfa, beta) del recurso. */
  const anclar = (m: number[], w: number, h: number, alfa: number, beta: number) => {
    const s = m.slice();
    s[12] = m[12] - m[0] * w * alfa - m[4] * h * beta;
    s[13] = m[13] - m[1] * w * alfa - m[5] * h * beta;
    return s;
  };
  const cajaDe = (m: number[], w: number, h: number) => {
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const xs = [0, w].flatMap((x) => [0, h].map((y) => a * x + c * y + e));
    const ys = [0, w].flatMap((x) => [0, h].map((y) => b * x + d * y + f));
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  const opciones = [0, 0.5, 1];
  const variantesDef = [];
  for (const beta of opciones) for (const alfa of opciones)
    variantesDef.push({ alfa, beta, ms: cajas.map((c) => anclar(c.m, c.w, c.h, alfa, beta)) });

  // Un unico encuadre para todas las variantes, asi los recursos se
  // rasterizan una sola vez y las variantes son comparables entre si.
  const todasCajas = variantesDef.flatMap((v) => v.ms.map((m, i) => cajaDe(m, cajas[i].w, cajas[i].h)));
  const todo = [...todasCajas, ...trazosBb];
  const minX = Math.min(...todo.map((b) => b.x0)), maxX = Math.max(...todo.map((b) => b.x1));
  const minY = Math.min(...todo.map((b) => b.y0)), maxY = Math.max(...todo.map((b) => b.y1));
  const escala = Math.min(lado / (maxX - minX), lado / (maxY - minY));
  const W = Math.max(1, Math.round((maxX - minX) * escala));
  const H = Math.max(1, Math.round((maxY - minY) * escala));

  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => { targets[id] = { width: s.width * escala, height: s.height * escala }; });
  const imagenes = await loadResourceImages(doc, { targets, quality: 1, minSide: 48, timeoutMs: 180000, sinCache: true });

  const lienzo = (pintor: (c: CanvasRenderingContext2D) => void, transparente = false) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    if (!transparente) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); }
    ctx.save(); ctx.scale(escala, escala); ctx.translate(-minX, -minY);
    pintor(ctx); ctx.restore();
    return c;
  };
  const cTrz = lienzo((ctx) => {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const l of doc.layers) for (const s of l.strokes) {
      if (!s.points.length) continue;
      const p = new Path2D();
      p.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) p.lineTo(s.points[i].x, s.points[i].y);
      ctx.strokeStyle = s.color.hex.slice(0, 7);
      ctx.globalAlpha = s.color.a;
      ctx.lineWidth = s.width || 1.5;
      ctx.stroke(p);
    }
  }, true);

  const tmp = document.createElement("canvas");
  tmp.width = 128; tmp.height = Math.max(1, Math.round(128 / aspecto));
  const tx = tmp.getContext("2d", { willReadFrequently: true })!;

  // Firma y mascara calida del thumb.
  tx.fillStyle = "#fff"; tx.fillRect(0, 0, tmp.width, tmp.height);
  tx.drawImage(bmThumb, 0, 0, tmp.width, tmp.height);
  const idT = tx.getImageData(0, 0, tmp.width, tmp.height);
  const fThumb = firma(idT)!;
  const mThumb = new Float32Array(tmp.width * tmp.height);
  let nThumb = 0;
  for (let i = 0, p = 0; p < mThumb.length; i += 4, p++) {
    const v = idT.data[i] - idT.data[i + 2] > 40 && idT.data[i] > 60 ? 1 : 0;
    mThumb[p] = v; nThumb += v;
  }

  const recortar = (fuente: HTMLCanvasElement, x: number, y: number, w: number, h: number, girado: boolean, encima?: HTMLCanvasElement) => {
    tx.save();
    tx.fillStyle = "#fff"; tx.fillRect(0, 0, tmp.width, tmp.height);
    if (girado) { tx.translate(tmp.width, tmp.height); tx.rotate(Math.PI); }
    const sx = girado ? W - x - w : x, sy = girado ? H - y - h : y;
    tx.drawImage(fuente, sx, sy, w, h, 0, 0, tmp.width, tmp.height);
    if (encima) tx.drawImage(encima, sx, sy, w, h, 0, 0, tmp.width, tmp.height);
    tx.restore();
    return tx.getImageData(0, 0, tmp.width, tmp.height);
  };

  const variantes = [];
  for (const v of variantesDef) {
    const cImgs = lienzo((ctx) => {
      cajas.forEach((caja, i) => {
        const r = imagenes[caja.id];
        if (!r) return;
        ctx.save();
        const m = v.ms[i];
        ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
        dibujarRecurso(ctx, r, caja.w, caja.h);
        ctx.restore();
      });
    });

    // 1) donde cae el thumb, con las imagenes solas
    let zona = { x: 0, y: 0, w: 0, h: 0, girado: false, corr: -2 };
    for (const girado of [false, true]) {
      for (let k = 0; k <= 9; k++) {
        const frac = 0.15 * Math.pow(1 / 0.15, k / 9);
        let cw = W * frac, ch = cw / aspecto;
        if (ch > H) { ch = H; cw = ch * aspecto; }
        if (cw > W) { cw = W; ch = cw / aspecto; }
        const paso = Math.max(10, cw / 7);
        for (let y = 0; y + ch <= H + 0.5; y += paso) {
          for (let x = 0; x + cw <= W + 0.5; x += paso) {
            const f = firma(recortar(cImgs, x, y, cw, ch, girado));
            if (!f) continue;
            const c = correl(f, fThumb);
            if (c > zona.corr) zona = { x, y, w: cw, h: ch, girado, corr: c };
          }
        }
      }
    }

    // 2) solapamiento de anotaciones en esa zona, SIN corrimiento extra
    const id = recortar(cTrz, zona.x, zona.y, zona.w, zona.h, zona.girado);
    let inter = 0, n = 0;
    for (let i = 0, p = 0; p < mThumb.length; i += 4, p++) {
      if (id.data[i + 3] < 40) continue;
      const val = id.data[i] - id.data[i + 2] > 40 && id.data[i] > 60 ? 1 : 0;
      n += val; inter += val * mThumb[p];
    }
    const tinta = n < 3 || nThumb < 3 ? 0 : inter / Math.sqrt(n * nThumb);

    // recorte grande para mirarlo
    const rc = document.createElement("canvas");
    rc.width = 460; rc.height = Math.max(1, Math.round(460 / aspecto));
    const rctx = rc.getContext("2d")!;
    rctx.fillStyle = "#fff"; rctx.fillRect(0, 0, rc.width, rc.height);
    if (zona.girado) { rctx.translate(rc.width, rc.height); rctx.rotate(Math.PI); }
    const sx = zona.girado ? W - zona.x - zona.w : zona.x, sy = zona.girado ? H - zona.y - zona.h : zona.y;
    rctx.drawImage(cImgs, sx, sy, zona.w, zona.h, 0, 0, rc.width, rc.height);
    rctx.drawImage(cTrz, sx, sy, zona.w, zona.h, 0, 0, rc.width, rc.height);
    const recorte = rc.toDataURL("image/png");
    rc.width = 0; cImgs.width = 0;

    variantes.push({
      alfa: v.alfa, beta: v.beta,
      nombre: `alfa=${v.alfa} beta=${v.beta}`,
      zonaCorr: +zona.corr.toFixed(4), tinta: +tinta.toFixed(4), recorte,
    });
  }

  const tp = document.createElement("canvas");
  tp.width = 460; tp.height = Math.max(1, Math.round(460 / aspecto));
  const tpx = tp.getContext("2d")!;
  tpx.fillStyle = "#fff"; tpx.fillRect(0, 0, tp.width, tp.height);
  tpx.drawImage(bmThumb, 0, 0, tp.width, tp.height);
  const thumbPng = tp.toDataURL("image/png");
  tp.width = 0;

  releaseResourceImages(imagenes);
  cTrz.width = 0; tmp.width = 0;
  bmThumb.close(); doc.close(); archivo.close();
  return { thumbPng, variantes };
}
