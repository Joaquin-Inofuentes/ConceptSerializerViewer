// Renderiza el MISMO documento dos veces, con las dos convenciones de origen
// para las imagenes colocadas, para poder mirar el antes y el despues:
//
//   A) como esta hoy: el (0,0) local del recurso es su esquina superior
//      izquierda (salvo el caso de matriz lineal identidad, que el parser ya
//      centra).
//   B) candidata: el (0,0) local es el CENTRO del recurso, para todas.
//
// Centrar equivale a restarle a la traslacion la mitad del recurso ya pasada
// por la parte lineal de su matriz. Se aplica sobre la matriz FINAL (la que
// ya salio del parser, girada): dibujar el rectangulo local [0,w]x[0,h] con
// M, versus dibujarlo centrado, difiere exactamente en esa constante, asi que
// hacerlo aca es equivalente a hacerlo dentro del parser.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { loadResourceImages, releaseResourceImages, drawnSizes, dibujarRecurso } from "../../src/Gallery/renderCore";

export interface ResultadoAB {
  error?: string;
  antes: string;
  despues: string;
  /** Cuanto se sale el bbox de trazos del bbox de imagenes, en cada variante.
   * 0 = los trazos caen enteros dentro del area cubierta por las imagenes. */
  desborde: { antes: number; despues: number; centrarTodas: number };
  /** Cuantas colocaciones tienen traslacion exactamente (0,0). */
  nuncaMovidas: number;
  imagenes: number;
  trazos: number;
}

export async function compararCentrado(url: string, lado = 700): Promise<ResultadoAB> {
  const archivo = await openConceptsRemote(url, {});
  const doc = await archivo.parse();

  const cajas: Array<{ id: string; m: number[]; w: number; h: number }> = [];
  for (const l of doc.layers) for (const img of l.images) {
    cajas.push({ id: img.resourceId, m: img.transform.slice(), w: img.width, h: img.height });
  }
  const trazos: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const l of doc.layers) for (const s of l.strokes) {
    trazos.push({ x0: s.bbox.minX, y0: s.bbox.minY, x1: s.bbox.maxX, y1: s.bbox.maxY });
  }

  /** Matriz con el origen local llevado al centro del recurso. */
  const centrar = (m: number[], w: number, h: number) => {
    const s = m.slice();
    s[12] = m[12] - (m[0] * w) / 2 - (m[4] * h) / 2;
    s[13] = m[13] - (m[1] * w) / 2 - (m[5] * h) / 2;
    return s;
  };

  const cajaDe = (m: number[], w: number, h: number) => {
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const xs = [0, w].flatMap((x) => [0, h].map((y) => a * x + c * y + e));
    const ys = [0, w].flatMap((x) => [0, h].map((y) => b * x + d * y + f));
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  /** Cuanto del bbox de trazos queda afuera del area que cubren las imagenes,
   * como fraccion del propio bbox de trazos. Es una medida burda pero directa
   * de "las notas caen sobre los planos o al lado". */
  const desbordeDe = (ms: number[][]) => {
    if (!trazos.length || !cajas.length) return 0;
    const bs = cajas.map((c, i) => cajaDe(ms[i], c.w, c.h));
    const ix0 = Math.min(...bs.map((b) => b.x0)), ix1 = Math.max(...bs.map((b) => b.x1));
    const iy0 = Math.min(...bs.map((b) => b.y0)), iy1 = Math.max(...bs.map((b) => b.y1));
    const tx0 = Math.min(...trazos.map((t) => t.x0)), tx1 = Math.max(...trazos.map((t) => t.x1));
    const ty0 = Math.min(...trazos.map((t) => t.y0)), ty1 = Math.max(...trazos.map((t) => t.y1));
    const fuera =
      Math.max(0, ix0 - tx0) + Math.max(0, tx1 - ix1) +
      Math.max(0, iy0 - ty0) + Math.max(0, ty1 - iy1);
    const tam = (tx1 - tx0) + (ty1 - ty0);
    return +(fuera / (tam || 1)).toFixed(3);
  };

  const msAntes = cajas.map((c) => c.m);
  const msTodas = cajas.map((c) => centrar(c.m, c.w, c.h));
  // Variante acotada: centrar SOLO las colocaciones cuya traslacion es
  // exactamente (0,0) — el recurso se pego y nunca se movio de lugar, aunque
  // la app le haya aplicado escala y rotacion para encajarlo en la pagina.
  // Es la generalizacion natural de la regla que ya existe en el parser (que
  // exige que la parte LINEAL sea identidad y por eso se pierde justamente
  // estos casos).
  const nuncaMovida = (m: number[]) => m[12] === 0 && m[13] === 0;
  const msOrigen = cajas.map((c) => (nuncaMovida(c.m) ? centrar(c.m, c.w, c.h) : c.m));
  const cuantasNuncaMovidas = cajas.filter((c) => nuncaMovida(c.m)).length;
  const msDespues = msOrigen;

  const dibujado = drawnSizes(doc);
  const pintar = async (ms: number[][]) => {
    const bs = ms.map((m, i) => cajaDe(m, cajas[i].w, cajas[i].h));
    const todos = [
      ...bs,
      ...trazos,
    ];
    const minX = Math.min(...todos.map((b) => b.x0)), maxX = Math.max(...todos.map((b) => b.x1));
    const minY = Math.min(...todos.map((b) => b.y0)), maxY = Math.max(...todos.map((b) => b.y1));
    const escala = Math.min(lado / (maxX - minX), lado / (maxY - minY));
    const W = Math.max(1, Math.round((maxX - minX) * escala));
    const H = Math.max(1, Math.round((maxY - minY) * escala));

    const targets: Record<string, { width: number; height: number }> = {};
    Object.entries(dibujado).forEach(([id, s]) => {
      targets[id] = { width: s.width * escala, height: s.height * escala };
    });
    const imagenes = await loadResourceImages(doc, {
      targets, quality: 1, minSide: 48, timeoutMs: 180000, sinCache: true,
    });

    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.scale(escala, escala);
    ctx.translate(-minX, -minY);
    // Imagenes primero, trazos despues: las notas van SIEMPRE arriba.
    cajas.forEach((caja, i) => {
      const recurso = imagenes[caja.id];
      if (!recurso) return;
      ctx.save();
      const m = ms[i];
      ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
      dibujarRecurso(ctx, recurso, caja.w, caja.h);
      ctx.restore();
    });
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const l of doc.layers) {
      for (const s of l.strokes) {
        if (!s.points.length) continue;
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
    const url2 = c.toDataURL("image/png");
    releaseResourceImages(imagenes);
    c.width = 0;
    return url2;
  };

  const antes = await pintar(msAntes);
  const despues = await pintar(msDespues);
  const r: ResultadoAB = {
    antes, despues,
    desborde: {
      antes: desbordeDe(msAntes),
      despues: desbordeDe(msDespues),
      centrarTodas: desbordeDe(msTodas),
    },
    nuncaMovidas: cuantasNuncaMovidas,
    imagenes: cajas.length, trazos: trazos.length,
  };
  doc.close();
  archivo.close();
  return r;
}
