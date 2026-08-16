// Test de geometria sobre TODO el corpus local, usando el parser REAL.
//
// Importa `src/VisorConcept/parser.ts` directamente (node --experimental-strip-types)
// en vez de reimplementar la lectura: si el parser tiene un error, este test lo
// ve. El arnes de `verificar-geometria.mjs` hace lo contrario a proposito
// (decodifica por su cuenta) y sirve para contrastar; los dos juntos cubren
// tanto "el formato se entiende mal" como "el parser hace algo distinto de lo
// que creemos".
//
//   node --experimental-strip-types --import ./scripts/_hooks-ts.mjs scripts/test-corpus.mjs
//
// El `--import` hace falta porque el parser importa `./zip` sin extension: Vite
// lo resuelve solo, el cargador de node no (ver `_hooks-ts.mjs`).
//
// Que se mide, y por que estas y no otras:
//   cohesionP95 — los trazos con matriz identidad estan indiscutiblemente en su
//     lugar (nadie los movio). Se mide cuan lejos del area que ocupan caen los
//     trazos que SI tienen matriz, normalizado por la diagonal de esa area. Si
//     un grupo entero "vuela" (el bug que teniamos), esto se dispara. Es la
//     unica metrica que detecta ese fallo sin mirar pixeles.
//   sobreImagen — % de trazos cuyo centro cae sobre alguna imagen colocada.
//     Ruidosa por si sola (anotar al margen es legitimo), sirve para detectar
//     saltos bruscos entre versiones, no como nota absoluta.
//
// NO usar el aspecto del bbox contra el de thumb.jpg: el thumb tiene lienzo de
// tamaño FIJO (1024x640 o 640x1024) con el dibujo encajado adentro, asi que su
// proporcion no dice nada de la del documento. Se probo y da veredictos al azar.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConceptsFile } from "../src/VisorConcept/parser.ts";

const CACHE = path.resolve(".cache/concepts");
const archivos = readdirSync(CACHE).filter((f) => f.endsWith(".concepts")).sort();

const bboxDe = (pts) => {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const [x, y] of pts) {
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  return b;
};
const cajaImagen = (im) => {
  const m = im.transform, a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
  return bboxDe([[0, 0], [im.width, 0], [0, im.height], [im.width, im.height]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]));
};

const filas = [];
let fallos = 0;
for (const nombre of archivos) {
  const t0 = Date.now();
  try {
    const doc = await parseConceptsFile(readFileSync(path.join(CACHE, nombre)).buffer);
    const trazos = doc.layers.flatMap((l) => l.strokes);
    const imagenes = doc.layers.flatMap((l) => l.images);

    // Un trazo "movido" no se puede distinguir despues del parseo (la matriz ya
    // esta aplicada), asi que se usa como proxy la dispersion: se compara cada
    // trazo contra el area que ocupa el grueso del dibujo. Sirve igual para
    // detectar el grupo volador.
    const centros = trazos.filter((s) => s.points.length).map((s) => [
      (s.bbox.minX + s.bbox.maxX) / 2, (s.bbox.minY + s.bbox.maxY) / 2,
    ]);
    let cohesion = 0;
    if (centros.length >= 20) {
      const xs = centros.map((p) => p[0]).sort((a, b) => a - b);
      const ys = centros.map((p) => p[1]).sort((a, b) => a - b);
      const q = (arr, f) => arr[Math.floor(arr.length * f)];
      // Region robusta: el rango intercuartil, inmune a unos pocos outliers.
      const R = { x0: q(xs, 0.1), x1: q(xs, 0.9), y0: q(ys, 0.1), y1: q(ys, 0.9) };
      const diag = Math.hypot(R.x1 - R.x0, R.y1 - R.y0) || 1;
      const ds = centros.map(([x, y]) =>
        Math.hypot(Math.max(R.x0 - x, 0, x - R.x1), Math.max(R.y0 - y, 0, y - R.y1)) / diag
      ).sort((a, b) => a - b);
      cohesion = ds[Math.floor(ds.length * 0.95)] ?? 0;
    }

    const cajas = imagenes.map(cajaImagen);
    const sobre = centros.length && cajas.length
      ? centros.filter(([x, y]) => cajas.some((c) => x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1)).length / centros.length * 100
      : 0;

    const bb = doc.bbox;
    filas.push({
      archivo: nombre, ok: true, ms: Date.now() - t0,
      trazos: trazos.length, imagenes: imagenes.length, capas: doc.layers.length,
      camara: doc.camara ? +doc.camara.zoom.toFixed(2) : null,
      cohesionP95: +cohesion.toFixed(3), sobreImagen: +sobre.toFixed(1),
      ancho: Number.isFinite(bb.minX) ? Math.round(bb.maxX - bb.minX) : 0,
      alto: Number.isFinite(bb.minY) ? Math.round(bb.maxY - bb.minY) : 0,
    });
    doc.close();
  } catch (e) {
    fallos++;
    filas.push({ archivo: nombre, ok: false, error: String(e).slice(0, 120), ms: Date.now() - t0 });
  }
}

const ok = filas.filter((f) => f.ok);
const conTrazos = ok.filter((f) => f.trazos > 0);
const conAmbos = ok.filter((f) => f.trazos > 0 && f.imagenes > 0);
const voladores = conTrazos.filter((f) => f.cohesionP95 > 0.5);
const vacios = ok.filter((f) => f.trazos === 0 && f.imagenes === 0);
const conCamara = ok.filter((f) => f.camara !== null);

console.log(`archivos            : ${filas.length}`);
console.log(`parseados OK        : ${ok.length}   fallos: ${fallos}`);
console.log(`con trazos          : ${conTrazos.length}`);
console.log(`con trazos+imagenes : ${conAmbos.length}`);
console.log(`vacios (0 y 0)      : ${vacios.length}`);
console.log(`con camara guardada : ${conCamara.length}`);
console.log(`trazos totales      : ${ok.reduce((n, f) => n + (f.trazos || 0), 0)}`);
console.log(`imagenes totales    : ${ok.reduce((n, f) => n + (f.imagenes || 0), 0)}`);
const media = (a, k) => a.length ? (a.reduce((n, f) => n + f[k], 0) / a.length) : 0;
console.log(`\ncohesionP95 media   : ${media(conTrazos, "cohesionP95").toFixed(3)}  (bajo = los trazos forman un dibujo, no hay grupos volando)`);
console.log(`sobreImagen media   : ${media(conAmbos, "sobreImagen").toFixed(1)}%`);
console.log(`\ntrazos dispersos (cohesionP95 > 0.5): ${voladores.length}`);
voladores.sort((a, b) => b.cohesionP95 - a.cohesionP95).slice(0, 10)
  .forEach((f) => console.log(`   ${f.archivo.slice(0, 40).padEnd(42)} ${f.cohesionP95.toFixed(3)}  trazos=${f.trazos} img=${f.imagenes}`));
if (fallos) {
  console.log(`\nFALLOS:`);
  filas.filter((f) => !f.ok).forEach((f) => console.log(`   ${f.archivo}: ${f.error}`));
}
writeFileSync(".cache/test-corpus.json", JSON.stringify(filas, null, 1));
console.log(`\ndetalle -> .cache/test-corpus.json`);
process.exit(fallos ? 1 : 0);
