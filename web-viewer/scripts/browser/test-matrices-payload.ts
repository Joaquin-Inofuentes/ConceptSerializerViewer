// Prueba, para cada imagen colocada, tres candidatas de matriz de posicion
// (solo la interna, solo la "matrixB" del final de cuerpo, y la composicion
// de ambas) y mide contra cual el bbox de los trazos solapa mejor. Sirve
// para decidir empiricamente cual es la matriz de verdad, ya que el formato
// no esta documentado.

import { ZipArchive, RemoteSource } from "../../src/VisorConcept/zip";
import { decode, ExtensionCodec } from "@msgpack/msgpack";

function dummyEncode(): Uint8Array {
  return new Uint8Array();
}
const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: 1, encode: dummyEncode,
  decode: (d: Uint8Array) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; },
});
extensionCodec.register({
  type: 2, encode: dummyEncode,
  decode: (d: Uint8Array) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; },
});
extensionCodec.register({
  type: 4, encode: dummyEncode,
  decode: (d: Uint8Array) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)]; },
});
extensionCodec.register({
  type: 5, encode: dummyEncode,
  decode: (d: Uint8Array) => { const hex = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; },
});
extensionCodec.register({
  type: 7, encode: dummyEncode,
  decode: (d: Uint8Array) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); const m: number[] = []; for (let i = 0; i < 16; i++) m.push(v.getFloat32(i * 4, true)); return m; },
});

function girarPunto(x: number, y: number): [number, number] {
  return [-x, -y];
}
function girarTransform(m: number[]): number[] {
  const s = m.slice();
  for (const i of [0, 1, 4, 5, 12, 13]) s[i] = -s[i];
  return s;
}
function mul(m1: number[], m2: number[]): number[] {
  // Compone m1 despues de m2 (world = m1 * (m2 * local)), en formato canvas
  // (a,b,c,d,e,f) mapeado a indices [0,1,4,5,12,13] del array de 16.
  const a1 = m1[0], b1 = m1[1], c1 = m1[4], d1 = m1[5], e1 = m1[12], f1 = m1[13];
  const a2 = m2[0], b2 = m2[1], c2 = m2[4], d2 = m2[5], e2 = m2[12], f2 = m2[13];
  const out = m1.slice();
  out[0] = a1 * a2 + c1 * b2;
  out[1] = b1 * a2 + d1 * b2;
  out[4] = a1 * c2 + c1 * d2;
  out[5] = b1 * c2 + d1 * d2;
  out[12] = a1 * e2 + c1 * f2 + e1;
  out[13] = b1 * e2 + d1 * f2 + f1;
  return out;
}

export async function testMatrices(url: string, headers: Record<string, string>) {
  const source = await RemoteSource.open(url, headers);
  const zip = await ZipArchive.open(source);
  const nombreTree = zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) return { error: "sin tree.pack" };
  const bytes = await zip.read(nombreTree);
  const tree: any = decode(bytes, { extensionCodec });

  type Img = { width: number; height: number; internoMat: number[] | null; matrixB: number[] | null; capa: number };
  const imagenes: Img[] = [];
  const trazos: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];

  const visitarCapa = (nodo: any, capa: number) => {
    const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
    for (const item of items) visitarItem(item, capa);
  };

  const visitarItem = (item: any, capa: number) => {
    if (!Array.isArray(item) || item.length === 0) return;
    const tipo = item[0];
    const cuerpo = item.length > 1 ? item[1] : null;
    if ((tipo === 8 || tipo === 7) && Array.isArray(cuerpo)) {
      const interno = Array.isArray(cuerpo[1]) ? cuerpo[1] : null;
      const tam = cuerpo.find((x: any) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
      const internoMat = interno ? interno.find((x: any) => Array.isArray(x) && x.length === 16) || null : null;
      const matrixB = cuerpo.find((x: any) => Array.isArray(x) && x.length === 16) || null;
      // matrixB por cuerpo.find encuentra el PRIMER array de 16 en cuerpo top-level,
      // que en la practica es el ultimo elemento (no hay otros arrays de 16 ahi).
      if (tam) {
        imagenes.push({ width: tam[0], height: tam[1], internoMat, matrixB, capa });
      }
      return;
    }
    buscarTrazos(item, capa);
  };

  const buscarTrazos = (o: any, capa: number) => {
    if (!Array.isArray(o)) return;
    const blobs = o.filter((x) => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);
    if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
      const blob = blobs[0];
      const n = Math.floor(blob.length / 16);
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const [x, y] = girarPunto(view.getFloat32(i * 16, true), view.getFloat32(i * 16 + 4, true));
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      trazos.push({ minX, minY, maxX, maxY });
      return;
    }
    for (const x of o) buscarTrazos(x, capa);
  };

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;
  const docCapas = Array.isArray(docData)
    ? docData.find((x: any) => Array.isArray(x) && x.length > 0 && x.every((c: any) => Array.isArray(c) && c.length > 0 && c[0] === 1))
    : null;
  if (docCapas) {
    docCapas.forEach((c: any, i: number) => visitarCapa(c, i));
  } else if (Array.isArray(docData)) {
    // fallback: sin capas reconocibles, se recorre todo como si fuera una sola.
    visitarItem(docData, 0);
    buscarTrazos(docData, 0);
  }

  const caja = (m: number[], w: number, h: number) => {
    const gm = girarTransform(m);
    const a = gm[0], b = gm[1], c = gm[4], d = gm[5], e = gm[12], f = gm[13];
    const esquinas = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = esquinas.map((p) => p[0]), ys = esquinas.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  const overlapPct = (cajas: Array<{ x0: number; y0: number; x1: number; y1: number }>) => {
    if (!trazos.length) return null;
    let n = 0;
    for (const t of trazos) {
      const cx = (t.minX + t.maxX) / 2, cy = (t.minY + t.maxY) / 2;
      if (cajas.some((c) => cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1)) n++;
    }
    return +((n / trazos.length) * 100).toFixed(1);
  };

  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const candidatas = {
    soloInterno: imagenes.map((im) => caja(im.internoMat || IDENT, im.width, im.height)),
    soloMatrixB: imagenes.map((im) => caja(im.matrixB || IDENT, im.width, im.height)),
    compuestaIntMB: imagenes.map((im) => caja(mul(im.internoMat || IDENT, im.matrixB || IDENT), im.width, im.height)),
    compuestaMBInt: imagenes.map((im) => caja(mul(im.matrixB || IDENT, im.internoMat || IDENT), im.width, im.height)),
  };

  return {
    imagenes: imagenes.length,
    trazos: trazos.length,
    internoIdentidad: imagenes.filter((im) => !im.internoMat || im.internoMat.every((v, i) => v === IDENT[i])).length,
    matrixBIdentidad: imagenes.filter((im) => !im.matrixB || im.matrixB.every((v, i) => v === IDENT[i])).length,
    overlap: {
      soloInterno: overlapPct(candidatas.soloInterno),
      soloMatrixB: overlapPct(candidatas.soloMatrixB),
      compuestaIntMB: overlapPct(candidatas.compuestaIntMB),
      compuestaMBInt: overlapPct(candidatas.compuestaMBInt),
    },
  };
}
