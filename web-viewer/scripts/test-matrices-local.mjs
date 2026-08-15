// Corre la logica de overlap de test-matrices-payload.ts contra archivos
// LOCALES del corpus cacheado (sin Drive, sin browser). Usa el mismo camino
// de parseo real (girarTransform + logica del parser) reimplementado aca
// para comparar candidatas.
//
//   node --experimental-strip-types scripts/test-matrices-local.mjs <nombre1> [nombre2...]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { ZipArchive, BufferSource } from "../src/VisorConcept/zip.ts";

const CACHE_DIR = path.resolve(".cache/concepts");
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));

function dummyEncode() { return new Uint8Array(); }
const extensionCodec = new ExtensionCodec();
extensionCodec.register({ type: 1, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; } });
extensionCodec.register({ type: 2, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; } });
extensionCodec.register({ type: 4, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)]; } });
extensionCodec.register({ type: 5, encode: dummyEncode, decode: (d) => { const hex = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; } });
extensionCodec.register({ type: 7, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); const m = []; for (let i = 0; i < 16; i++) m.push(v.getFloat32(i * 4, true)); return m; } });

function girarTransform(m) { const s = m.slice(); for (const i of [0, 1, 4, 5, 12, 13]) s[i] = -s[i]; return s; }

async function analizar(localPath) {
  const buf = await readFile(localPath);
  const zip = await ZipArchive.open(new BufferSource(buf));
  const nombreTree = zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) return { error: "sin tree.pack" };
  const bytes = await zip.read(nombreTree);
  const tree = decode(bytes, { extensionCodec });

  const imagenes = [];
  const trazos = [];

  const visitarItem = (item) => {
    if (!Array.isArray(item) || item.length === 0) return;
    const tipo = item[0];
    const cuerpo = item.length > 1 ? item[1] : null;
    if ((tipo === 8 || tipo === 7) && Array.isArray(cuerpo)) {
      const interno = Array.isArray(cuerpo[1]) ? cuerpo[1] : null;
      const tam = cuerpo.find((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
      const internoMat = interno ? interno.find((x) => Array.isArray(x) && x.length === 16) || null : null;
      if (tam) imagenes.push({ width: tam[0], height: tam[1], internoMat, tipo });
      return;
    }
    buscarTrazos(item);
  };
  const buscarTrazos = (o) => {
    if (!Array.isArray(o)) return;
    const blobs = o.filter((x) => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);
    if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
      const blob = blobs[0];
      const n = Math.floor(blob.length / 16);
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const gx = -view.getFloat32(i * 16, true), gy = -view.getFloat32(i * 16 + 4, true);
        if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
      }
      trazos.push({ minX, minY, maxX, maxY });
      return;
    }
    for (const x of o) buscarTrazos(x);
  };
  const visitarCapa = (nodo) => {
    const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
    for (const item of items) visitarItem(item);
  };

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;
  const docCapas = Array.isArray(docData)
    ? docData.find((x) => Array.isArray(x) && x.length > 0 && x.every((c) => Array.isArray(c) && c.length > 0 && c[0] === 1))
    : null;
  if (docCapas) docCapas.forEach((c) => visitarCapa(c));
  else if (Array.isArray(docData)) { visitarItem(docData); buscarTrazos(docData); }

  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const caja = (m, w, h, centrado) => {
    const gm = girarTransform(m);
    const a = gm[0], b = gm[1], c = gm[4], d = gm[5], e = gm[12], f = gm[13];
    const local = centrado
      ? [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]
      : [[0, 0], [w, 0], [0, h], [w, h]];
    const esquinas = local.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = esquinas.map((p) => p[0]), ys = esquinas.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const overlapPct = (cajas) => {
    if (!trazos.length) return null;
    let n = 0;
    for (const t of trazos) {
      const cx = (t.minX + t.maxX) / 2, cy = (t.minY + t.maxY) / 2;
      if (cajas.some((c) => cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1)) n++;
    }
    return +((n / trazos.length) * 100).toFixed(1);
  };

  const claveDe = (m) => `${m[0].toFixed(6)},${m[1].toFixed(6)},${m[4].toFixed(6)},${m[5].toFixed(6)}`;
  const conteoT8 = new Map();
  for (const im of imagenes) {
    if (im.tipo !== 8) continue;
    const k = claveDe(im.internoMat || IDENT);
    conteoT8.set(k, (conteoT8.get(k) || 0) + 1);
  }

  // Logica EXACTA hoy en produccion (parser.ts): identidad lineal -> siempre
  // centrado. El fallback "compartidaTipo8" solo se activa si overlap()==0%,
  // asi que se calcula el base primero.
  const cajaBase = imagenes.map((im) => {
    const m = im.internoMat || IDENT;
    const esLinealIdent = m[0] === 1 && m[1] === 0 && m[4] === 0 && m[5] === 1;
    return caja(m, im.width, im.height, esLinealIdent);
  });
  let overlapBase = overlapPct(cajaBase);

  let overlapFinal = overlapBase;
  let fallbackAplicado = false;
  if (overlapBase === 0) {
    fallbackAplicado = true;
    const cajaFallback = imagenes.map((im) => {
      const m = im.internoMat || IDENT;
      const esLinealIdent = m[0] === 1 && m[1] === 0 && m[4] === 0 && m[5] === 1;
      const compartidaT8 = im.tipo === 8 && (conteoT8.get(claveDe(m)) || 0) >= 2;
      return caja(m, im.width, im.height, esLinealIdent || compartidaT8);
    });
    overlapFinal = overlapPct(cajaFallback);
  }

  return {
    imagenes: imagenes.length, trazos: trazos.length,
    overlapSinCentrarNunca: overlapPct(imagenes.map((im) => caja(im.internoMat || IDENT, im.width, im.height, false))),
    overlapProduccion: overlapFinal,
    fallbackAplicado,
    escalas: imagenes.map((im) => { const m = im.internoMat || IDENT; return +Math.hypot(m[0], m[1]).toFixed(3); }),
  };
}

const nombres = process.argv.slice(2);
const objetivo = nombres.length ? manifest.files.filter((f) => nombres.some((n) => f.name.includes(n))) : [];
if (!objetivo.length) {
  console.error("Uso: node scripts/test-matrices-local.mjs <substring del nombre> [...]");
  process.exit(1);
}
for (const f of objetivo) {
  console.log(`\n${f.name} (${(f.size / 1048576).toFixed(1)}MB) — ${f.folderPath}`);
  try {
    const r = await analizar(f.localPath);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error("FALLO:", String(e).slice(0, 300));
  }
}
