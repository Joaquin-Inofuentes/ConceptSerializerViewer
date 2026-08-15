// Escanea el corpus LOCAL cacheado (.cache/concepts) y mide, para cada
// archivo, cuanta variacion real hay entre las matrices de sus imagenes
// colocadas (escala, rotacion, cuantos grupos "compartidos" vs "unicos").
// Sirve para elegir, sin adivinar, el archivo mas exigente para probar la
// logica de centrado (que depende justamente de esa variacion).
//
//   node scripts/variance-scan.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { ZipArchive, BufferSource } from "../src/VisorConcept/zip.ts";

const CACHE_DIR = path.resolve(".cache/concepts");
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const files = manifest.files.filter((f) => f.size && f.localPath);

function dummyEncode() { return new Uint8Array(); }
const extensionCodec = new ExtensionCodec();
extensionCodec.register({ type: 1, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; } });
extensionCodec.register({ type: 2, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true)]; } });
extensionCodec.register({ type: 4, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)]; } });
extensionCodec.register({ type: 5, encode: dummyEncode, decode: (d) => { const hex = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; } });
extensionCodec.register({ type: 7, encode: dummyEncode, decode: (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); const m = []; for (let i = 0; i < 16; i++) m.push(v.getFloat32(i * 4, true)); return m; } });

function stats(arr) {
  if (!arr.length) return { min: 0, max: 0, range: 0, n: arr.length };
  const min = Math.min(...arr), max = Math.max(...arr);
  return { min, max, range: max - min, n: arr.length };
}

async function analizar(f) {
  const buf = await readFile(f.localPath);
  const zip = await ZipArchive.open(new BufferSource(buf));
  const nombreTree = zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) return null;
  const bytes = await zip.read(nombreTree);
  const tree = decode(bytes, { extensionCodec });

  const imagenes = [];
  const claveDe = (m) => `${m[0].toFixed(6)},${m[1].toFixed(6)},${m[4].toFixed(6)},${m[5].toFixed(6)}`;

  const visitarItem = (item) => {
    if (!Array.isArray(item) || item.length === 0) return;
    const tipo = item[0];
    const cuerpo = item.length > 1 ? item[1] : null;
    if ((tipo === 8 || tipo === 7) && Array.isArray(cuerpo)) {
      const interno = Array.isArray(cuerpo[1]) ? cuerpo[1] : null;
      const tam = cuerpo.find((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
      const internoMat = interno ? interno.find((x) => Array.isArray(x) && x.length === 16) || null : null;
      if (tam && internoMat) {
        const a = internoMat[0], b = internoMat[1], c = internoMat[4], d = internoMat[5];
        const escalaX = Math.hypot(a, b);
        const escalaY = Math.hypot(c, d);
        const rotDeg = (Math.atan2(b, a) * 180) / Math.PI;
        imagenes.push({ tipo, escalaX, escalaY, rotDeg, m: internoMat });
      }
      return;
    }
    visitarChildren(item);
  };
  const visitarChildren = (o) => { if (Array.isArray(o)) for (const x of o) visitarItem(x); };
  const visitarCapa = (nodo) => {
    const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
    for (const item of items) visitarItem(item);
  };

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;
  const docCapas = Array.isArray(docData)
    ? docData.find((x) => Array.isArray(x) && x.length > 0 && x.every((c) => Array.isArray(c) && c.length > 0 && c[0] === 1))
    : null;
  if (docCapas) docCapas.forEach((c) => visitarCapa(c));
  else if (Array.isArray(docData)) visitarItem(docData);

  if (!imagenes.length) return null;
  const conteo = new Map();
  for (const im of imagenes) conteo.set(claveDe(im.m), (conteo.get(claveDe(im.m)) || 0) + 1);
  const gruposUnicos = conteo.size;

  return {
    id: f.id, name: f.name, folderPath: f.folderPath, MB: +(f.size / 1048576).toFixed(1),
    imagenes: imagenes.length,
    escalaX: stats(imagenes.map((i) => i.escalaX)),
    escalaY: stats(imagenes.map((i) => i.escalaY)),
    rotDeg: stats(imagenes.map((i) => i.rotDeg)),
    gruposUnicos,
    // "variedad" = cuanto varian escala y rotacion entre las imagenes del
    // mismo documento, ponderado por cuantas imagenes hay (mas colocaciones
    // = mas chances de encontrar un caso limite real).
    score: 0,
  };
}

const out = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  try {
    const r = await analizar(f);
    if (r) {
      r.score = (r.escalaX.range + r.escalaY.range) * 2 + r.rotDeg.range / 45 + Math.min(r.imagenes, 30) * 0.3 + r.gruposUnicos * 0.5;
      out.push(r);
    }
  } catch (e) {
    console.error(`[${i + 1}/${files.length}] ERROR ${f.name}: ${String(e).slice(0, 150)}`);
  }
  if ((i + 1) % 20 === 0) console.error(`... ${i + 1}/${files.length}`);
}

out.sort((a, b) => b.score - a.score);
console.log("\n== TOP 15 por variedad (escala+rotacion+cantidad+grupos unicos) ==");
for (const r of out.slice(0, 15)) {
  console.log(
    `score=${r.score.toFixed(1)}  imgs=${r.imagenes}  escalaX[${r.escalaX.min.toFixed(2)}-${r.escalaX.max.toFixed(2)}]  rot[${r.rotDeg.min.toFixed(0)}..${r.rotDeg.max.toFixed(0)}]deg  gruposUnicos=${r.gruposUnicos}  ${r.MB}MB  ${r.name}  (${r.folderPath})`
  );
}
await writeTop(out);

async function writeTop(out) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(CACHE_DIR, "variance-scan.json"), JSON.stringify(out, null, 2));
}
