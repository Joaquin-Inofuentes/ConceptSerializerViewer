// Mide el desplazamiento REAL entre trazos e imagenes, usando el thumb.jpg
// como verdad local.
//
// Idea: el thumb es un recorte con zoom de una zona del dibujo, hecho por la
// propia Concepts, con los planos Y las notas en su lugar. Entonces:
//
//   1. Se renderizan las imagenes SOLAS y se busca en que parte de nuestro
//      render cae el thumb. Los planos son grandes y estructurados, asi que
//      esa busqueda es confiable (los trazos son finos y no la mueven).
//   2. Ya sabiendo la zona, se prueba correr los trazos respecto de las
//      imagenes y se mide cual corrimiento hace que el recorte se parezca
//      mas al thumb. El corrimiento que gana ES el desface.
//
// Si el desface da (0,0), trazos e imagenes ya coinciden. Si da otra cosa, es
// la medida exacta de cuanto y para donde estan corridos.
//
// LIMITE CONOCIDO, comprobado: cuando el documento tiene varias paginas
// iguales apiladas, el maximo que encuentra la busqueda puede ser un ENGANO —
// un corrimiento del orden del tamaño de una pagina hace que caiga encima del
// plano OTRO grupo de anotaciones, distinto del que muestra el thumb, y el
// solapamiento sube igual. Antes de creerle a un desface, hay que mirar el
// recorte corregido y confirmar que los trazos son LOS MISMOS que los del
// thumb (misma forma, mismos numeros), no solo que haya tinta naranja
// encima. Medido en Fede y Franco/Concepts/HO/Drawing: dio (2442,-2311), que
// es casi exactamente el ancho de una pagina (2598), y los trazos que traia
// no eran los del thumb.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

const SIG = 64;

function firma(datos: ImageData): Float32Array | null {
  const { data, width, height } = datos;
  const out = new Float32Array(SIG * SIG);
  const cnt = new Float32Array(SIG * SIG);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(SIG - 1, ((y / height) * SIG) | 0);
    for (let x = 0; x < width; x++) {
      const gx = Math.min(SIG - 1, ((x / width) * SIG) | 0);
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * a + 255 * (1 - a);
      out[gy * SIG + gx] += l;
      cnt[gy * SIG + gx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  let va = 0;
  for (const v of out) va += (v - m) ** 2;
  const sd = Math.sqrt(va / out.length);
  if (sd < 2) return null;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
}

function correl(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

export interface ResultadoDesface {
  error?: string;
  thumb: string;
  /** Zona del render (en px) donde encajo el thumb, y si hubo que girar. */
  zona: { x: number; y: number; w: number; h: number; girado: boolean; corr: number };
  escala: number;
  /** Desface medido de los TRAZOS respecto de las IMAGENES, en unidades del
   * documento. (0,0) = ya coinciden. */
  desface: { x: number; y: number };
  corrSinCorregir: number;
  corrCorregido: number;
  thumbPng: string;
  recorteSinCorregir: string;
  recorteCorregido: string;
}

export async function medirDesface(url: string, lado = 1100): Promise<ResultadoDesface> {
  const archivo = await openConceptsRemote(url, {});
  const blobThumb = await archivo.thumbnail();
  if (!blobThumb) { archivo.close(); return { error: "sin thumb.jpg" } as ResultadoDesface; }
  const bmThumb = await createImageBitmap(blobThumb);
  const anchoT = bmThumb.width, altoT = bmThumb.height;
  const aspecto = anchoT / altoT;
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
  const bs = cajas.map((c) => cajaDe(c.m, c.w, c.h));
  const tb: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const l of doc.layers) for (const s of l.strokes)
    tb.push({ x0: s.bbox.minX, y0: s.bbox.minY, x1: s.bbox.maxX, y1: s.bbox.maxY });
  const todos = [...bs, ...tb];
  let minX = Math.min(...todos.map((b) => b.x0)), maxX = Math.max(...todos.map((b) => b.x1));
  let minY = Math.min(...todos.map((b) => b.y0)), maxY = Math.max(...todos.map((b) => b.y1));
  // Se agranda el lienzo: al correr los trazos para probar, no tienen que
  // quedar cortados por el borde.
  const mx = (maxX - minX) * 0.5, my = (maxY - minY) * 0.5;
  minX -= mx; maxX += mx; minY -= my; maxY += my;

  const escala = Math.min(lado / (maxX - minX), lado / (maxY - minY));
  const W = Math.max(1, Math.round((maxX - minX) * escala));
  const H = Math.max(1, Math.round((maxY - minY) * escala));

  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, s]) => { targets[id] = { width: s.width * escala, height: s.height * escala }; });
  const imagenes = await loadResourceImages(doc, { targets, quality: 1, minSide: 48, timeoutMs: 180000, sinCache: true });

  const lienzo = (pintor: (ctx: CanvasRenderingContext2D) => void, transparente = false) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    if (!transparente) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H); }
    ctx.save(); ctx.scale(escala, escala); ctx.translate(-minX, -minY);
    pintor(ctx);
    ctx.restore();
    return c;
  };

  const cImgs = lienzo((ctx) => {
    cajas.forEach((caja) => {
      const r = imagenes[caja.id];
      if (!r) return;
      ctx.save();
      const m = caja.m;
      ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
      dibujarRecurso(ctx, r, caja.w, caja.h);
      ctx.restore();
    });
  });
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

  // --- 1) Donde cae el thumb, usando SOLO las imagenes --------------------
  const tSig = document.createElement("canvas");
  tSig.width = 256; tSig.height = Math.max(1, Math.round(256 / aspecto));
  const tsx = tSig.getContext("2d", { willReadFrequently: true })!;
  tsx.fillStyle = "#fff"; tsx.fillRect(0, 0, tSig.width, tSig.height);
  tsx.drawImage(bmThumb, 0, 0, tSig.width, tSig.height);
  const fThumb = firma(tsx.getImageData(0, 0, tSig.width, tSig.height))!;

  const tmp = document.createElement("canvas");
  tmp.width = 128; tmp.height = Math.max(1, Math.round(128 / aspecto));
  const tmpx = tmp.getContext("2d", { willReadFrequently: true })!;

  const firmaDe = (fuente: HTMLCanvasElement, x: number, y: number, w: number, h: number, girado: boolean, extra?: { c: HTMLCanvasElement; dx: number; dy: number }) => {
    tmpx.save();
    tmpx.fillStyle = "#fff"; tmpx.fillRect(0, 0, tmp.width, tmp.height);
    if (girado) { tmpx.translate(tmp.width, tmp.height); tmpx.rotate(Math.PI); }
    const sx = girado ? W - x - w : x;
    const sy = girado ? H - y - h : y;
    tmpx.drawImage(fuente, sx, sy, w, h, 0, 0, tmp.width, tmp.height);
    if (extra) tmpx.drawImage(extra.c, sx - extra.dx, sy - extra.dy, w, h, 0, 0, tmp.width, tmp.height);
    tmpx.restore();
    return firma(tmpx.getImageData(0, 0, tmp.width, tmp.height));
  };

  let zona = { x: 0, y: 0, w: 0, h: 0, girado: false, corr: -2 };
  for (const girado of [false, true]) {
    for (let k = 0; k <= 11; k++) {
      const frac = 0.12 * Math.pow(1 / 0.12, k / 11);
      let cw = W * frac, ch = cw / aspecto;
      if (ch > H) { ch = H; cw = ch * aspecto; }
      if (cw > W) { cw = W; ch = cw / aspecto; }
      const paso = Math.max(8, cw / 8);
      for (let y = 0; y + ch <= H + 0.5; y += paso) {
        for (let x = 0; x + cw <= W + 0.5; x += paso) {
          const f = firmaDe(cImgs, x, y, cw, ch, girado);
          if (!f) continue;
          const c = correl(f, fThumb);
          if (c > zona.corr) zona = { x, y, w: cw, h: ch, girado, corr: c };
        }
      }
    }
  }

  // --- 2) Que corrimiento de los trazos hace que se parezca mas ------------
  //
  // La correlacion de luminancia NO sirve para esto: la domina la estructura
  // del plano (lineas, grillas, bloques de texto) y los trazos son cuatro
  // rayas finas que casi no mueven el numero — medido, corregir un desface
  // enorme le cambiaba 0,01. Hay que mirar SOLO la tinta de las anotaciones.
  //
  // Se separan por color: los planos son grises, negros y azules/cian; las
  // anotaciones a mano son calidas (naranja, amarillo, rojo). El filtro
  // R-B > 40 deja pasar las anotaciones y descarta el plano, incluidas sus
  // lineas de eje azules.
  const CAL = 110;
  const mascaraCalida = (fuente: HTMLCanvasElement, dx: number, dy: number) => {
    mctx.save();
    mctx.clearRect(0, 0, mcan.width, mcan.height);
    if (zona.girado) { mctx.translate(mcan.width, mcan.height); mctx.rotate(Math.PI); }
    const sx = (zona.girado ? W - zona.x - zona.w : zona.x) - dx;
    const sy = (zona.girado ? H - zona.y - zona.h : zona.y) - dy;
    mctx.drawImage(fuente, sx, sy, zona.w, zona.h, 0, 0, mcan.width, mcan.height);
    mctx.restore();
    const d = mctx.getImageData(0, 0, mcan.width, mcan.height).data;
    const out = new Float32Array(mcan.width * mcan.height);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
      if (d[i + 3] < 40) continue;
      out[p] = d[i] - d[i + 2] > 40 && d[i] > 60 ? 1 : 0;
    }
    return out;
  };
  const mcan = document.createElement("canvas");
  mcan.width = 128; mcan.height = Math.max(1, Math.round(128 / aspecto));
  const mctx = mcan.getContext("2d", { willReadFrequently: true })!;

  // Mascara calida del thumb (la verdad).
  mctx.clearRect(0, 0, mcan.width, mcan.height);
  mctx.drawImage(bmThumb, 0, 0, mcan.width, mcan.height);
  const dT = mctx.getImageData(0, 0, mcan.width, mcan.height).data;
  const mThumb = new Float32Array(mcan.width * mcan.height);
  let nThumb = 0;
  for (let i = 0, p = 0; p < mThumb.length; i += 4, p++) {
    const v = dT[i] - dT[i + 2] > 40 && dT[i] > 60 ? 1 : 0;
    mThumb[p] = v; nThumb += v;
  }

  /** Solapamiento normalizado entre la tinta calida del thumb y la nuestra. */
  const solape = (dx: number, dy: number) => {
    if (nThumb < 8) return -2;
    const m = mascaraCalida(cTrz, dx, dy);
    let inter = 0, n = 0;
    for (let p = 0; p < m.length; p++) { n += m[p]; inter += m[p] * mThumb[p]; }
    if (n < 4) return 0;
    return inter / Math.sqrt(n * nThumb);
  };

  let best = { dx: 0, dy: 0, corr: solape(0, 0) };
  const corrSinCorregir = best.corr;
  // Barrido grueso por TODO el lienzo (los trazos pueden estar lejos), y
  // despues refinamiento.
  for (let dy = -H; dy <= H; dy += 28) {
    for (let dx = -W; dx <= W; dx += 28) {
      const c = solape(dx, dy);
      if (c > best.corr) best = { dx, dy, corr: c };
    }
  }
  for (const paso of [10, 4, 1]) {
    const cx0 = best.dx, cy0 = best.dy, r = paso * 4;
    for (let dy = cy0 - r; dy <= cy0 + r; dy += paso) {
      for (let dx = cx0 - r; dx <= cx0 + r; dx += paso) {
        const c = solape(dx, dy);
        if (c > best.corr) best = { dx, dy, corr: c };
      }
    }
  }

  const signo = zona.girado ? -1 : 1;
  const recorte = (dx: number, dy: number) => {
    const c = document.createElement("canvas");
    c.width = 460; c.height = Math.max(1, Math.round(460 / aspecto));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    if (zona.girado) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
    const sx = zona.girado ? W - zona.x - zona.w : zona.x;
    const sy = zona.girado ? H - zona.y - zona.h : zona.y;
    ctx.drawImage(cImgs, sx, sy, zona.w, zona.h, 0, 0, c.width, c.height);
    ctx.drawImage(cTrz, sx - dx, sy - dy, zona.w, zona.h, 0, 0, c.width, c.height);
    const u = c.toDataURL("image/png");
    c.width = 0;
    return u;
  };
  const recorteSinCorregir = recorte(0, 0);
  const recorteCorregido = recorte(best.dx, best.dy);

  const tp = document.createElement("canvas");
  tp.width = 460; tp.height = Math.max(1, Math.round(460 / aspecto));
  const tpx = tp.getContext("2d")!;
  tpx.fillStyle = "#fff"; tpx.fillRect(0, 0, tp.width, tp.height);
  tpx.drawImage(bmThumb, 0, 0, tp.width, tp.height);
  const thumbPng = tp.toDataURL("image/png");
  tp.width = 0;

  const r: ResultadoDesface = {
    thumb: `${anchoT}x${altoT}`,
    zona: { ...zona, corr: +zona.corr.toFixed(4) },
    escala: +escala.toFixed(5),
    desface: { x: +((signo * best.dx) / escala).toFixed(1), y: +((signo * best.dy) / escala).toFixed(1) },
    corrSinCorregir: +corrSinCorregir.toFixed(4),
    corrCorregido: +best.corr.toFixed(4),
    thumbPng, recorteSinCorregir, recorteCorregido,
  };
  releaseResourceImages(imagenes);
  cImgs.width = 0; cTrz.width = 0; tmp.width = 0; tSig.width = 0; mcan.width = 0;
  bmThumb.close(); doc.close(); archivo.close();
  return r;
}
