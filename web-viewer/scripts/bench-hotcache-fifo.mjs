// Verifica el tope FIFO de 2 imagenes a resolucion plena (hotFifoRef en
// Viewer.tsx), agregado para el bug reportado: "cuando me acerco a un plano
// y cargo full HD y paneo te carga de nuevo".
//
// Usa `window.__viewerCajas()` (cajas de imagenes en coordenadas del
// documento) y `window.__viewerFijarVista()` (fija zoom/pan exactos) para
// encuadrar UN plano concreto por vez con precision, en vez de simular
// gestos de rueda/arrastre que son dificiles de apuntar sin conocer el
// layout real del dibujo.
//
// Secuencia:
//   1. Encuadra el plano A a resolucion plena (> UMBRAL_HOT_LADO_PX).
//   2. Encuadra el plano B (A queda fuera de pantalla): con solo 2 hot,
//      ninguno se desaloja.
//   3. Vuelve a encuadrar A (para "usarlo" de nuevo) y confirma que SIGUE
//      en memoria (no tuvo que re-rasterizar).
//   4. Encuadra un plano C: like FIFO estricto, debe salir A (el mas viejo),
//      no B, aunque A se haya revisitado en el paso 3 (eso lo distingue de
//      un LRU).
//
//   node scripts/bench-hotcache-fifo.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);
const target = process.argv[2] ? disponibles.find((f) => f.id === process.argv[2]) : disponibles[0];
if (!target) throw new Error("archivo no encontrado en el cache local");

console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB)\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 200)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
const botones = await page.$$("button");
for (const b of botones) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) {
    await b.click();
    break;
  }
}

const input = await page.$('input[type="file"]');
if (!input) throw new Error("no se encontro el input de subida");
await input.uploadFile(target.localPath);
await page.waitForSelector(".canvas-wrapper canvas", { timeout: 180000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000, polling: 500 });
await new Promise((r) => setTimeout(r, 1000));

const hot = () => page.evaluate(() => (window.__viewerHotCache ? window.__viewerHotCache() : null));

// Todas las cajas de imagenes/planos colocados, ordenadas por tamaño (los
// planos "de lectura" son los mas grandes; las fotitos adjuntas son
// diminutas y no sirven para este test).
const cajas = await page.evaluate(() => window.__viewerCajas());
const anchoCss = 1440,
  altoCss = 900;

/**
 * Encuadra una caja del documento a pantalla completa "cover" (llena TODO
 * el viewport con la caja, recortandola un poco si hace falta) en vez de
 * "contain" (que deja margen a los costados). En dibujos con planos
 * apilados SIN separacion, un margen de apenas unos px ya asoma una franja
 * a ancho completo del plano vecino, que cruza el umbral "hot" igual que si
 * fuera el plano principal y contamina el test. Con "cover" y un inset del
 * 2% el viewport queda estrictamente DENTRO de la caja pedida.
 */
async function encuadrar(caja) {
  const w = caja.x1 - caja.x0;
  const h = caja.y1 - caja.y0;
  const zoom = Math.max(anchoCss / w, altoCss / h) * 1.02;
  const cx = (caja.x0 + caja.x1) / 2;
  const cy = (caja.y0 + caja.y1) / 2;
  const panX = anchoCss / 2 - cx * zoom;
  const panY = altoCss / 2 - cy * zoom;
  await page.evaluate(
    (zoom, panX, panY) => window.__viewerFijarVista({ zoom, panX, panY }),
    zoom,
    panX,
    panY
  );
  // Debounce (220ms) + rasterizado real de un PDF (~4-5 s medido).
  await new Promise((r) => setTimeout(r, 7000));
}

// Elige 3 planos grandes y bien separados entre si (para que encuadrar uno
// deje a los otros claramente fuera de pantalla).
const grandes = cajas
  .filter((c) => Math.max(c.x1 - c.x0, c.y1 - c.y0) > 0)
  .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
const distancia = (a, b) => Math.hypot((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);

const vistos = new Set();
const distintos = [];
for (const c of grandes) {
  if (vistos.has(c.resourceId)) continue;
  vistos.add(c.resourceId);
  distintos.push(c);
  if (distintos.length === 3) break;
}
if (distintos.length < 3) throw new Error(`el documento no tiene 3 planos distintos (encontrados: ${distintos.length})`);
const [A, B, C] = distintos;
console.log(`planos elegidos: A=${A.resourceId.slice(0, 8)} B=${B.resourceId.slice(0, 8)} C=${C.resourceId.slice(0, 8)}\n`);

console.log("encuadrar A a resolucion plena...");
await encuadrar(A);
let s1 = await hot();
console.log(`  hotFifo=${s1.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s1.enMemoria.length}`);

console.log("encuadrar B (A queda fuera de pantalla)...");
await encuadrar(B);
let s2 = await hot();
console.log(`  hotFifo=${s2.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s2.enMemoria.length}`);
const capOk = s2.hotFifo.length <= 2;
console.log(capOk ? "  OK  el tope nunca supera 2" : `  FALLA el tope supera 2 (${s2.hotFifo.length})`);

console.log("volver a encuadrar A (revisitarlo no deberia salvarlo de salir despues)...");
await encuadrar(A);
let s3 = await hot();
const siguePrimero = s3.enMemoria.includes(A.resourceId);
console.log(`  A: ${siguePrimero ? "seguia en memoria, no recargo" : "NO estaba, tuvo que recargar"}`);
const noRecargoOk = siguePrimero;

console.log("encuadrar C (deberia desalojar A, el mas viejo, aunque se revisito)...");
await encuadrar(C);
let s4 = await hot();
console.log(`  hotFifo=${s4.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s4.enMemoria.length}`);
const capOk2 = s4.hotFifo.length <= 2;
const fifoOk = !s4.enMemoria.includes(A.resourceId);
const bOk = s4.enMemoria.includes(B.resourceId);
console.log(capOk2 ? "  OK  el tope sigue en 2" : `  FALLA el tope supera 2 (${s4.hotFifo.length})`);
console.log(fifoOk ? "  OK  A (el mas viejo) salio pese a haberse revisitado -> es FIFO, no LRU" : "  FALLA A sigue en memoria");
console.log(bOk ? "  OK  B (mas nuevo que A) sigue en memoria" : "  FALLA B tambien salio (no deberia)");

console.log(`\nerrores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);

const todoOk = capOk && noRecargoOk && capOk2 && fifoOk && bOk;
console.log(todoOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");

await page.screenshot({ path: path.join(CACHE_DIR, "bench-hotcache-fifo.png") });
await browser.close();
process.exit(todoOk ? 0 : 1);
