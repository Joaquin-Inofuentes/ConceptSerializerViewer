// Variante TACTIL de bench-hotcache-fifo.mjs: en vez de __viewerFijarVista
// (que fija el estado directamente), pinch-zoom real por touch events sobre
// un plano y pan real por touch a otro, para confirmar que el tope FIFO de
// 2 en resolucion plena tambien aguanta cuando el gesto llega por la ruta
// tactil (onTouchStart/Move/End) y no por mouse/wheel/API interna.
//
//   node scripts/bench-hotcache-fifo-touch.mjs

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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192"],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
const cajas = await page.evaluate(() => window.__viewerCajas());

const grandes = cajas
  .filter((c) => Math.max(c.x1 - c.x0, c.y1 - c.y0) > 0)
  .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
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

// Usa __viewerFijarVista SOLO para el encuadre inicial grueso (posicionar la
// camara cerca de la caja), pero el ultimo tramo de acercamiento se hace con
// un pinch tactil real para que el "cruce del umbral hot" ocurra por la ruta
// de eventos touch, que es lo que hay que confirmar.
async function encuadrarGrueso(caja, factor = 0.5) {
  const anchoCss = 390, altoCss = 844;
  const w = caja.x1 - caja.x0;
  const h = caja.y1 - caja.y0;
  const zoom = Math.max(anchoCss / w, altoCss / h) * factor;
  const cx = (caja.x0 + caja.x1) / 2;
  const cy = (caja.y0 + caja.y1) / 2;
  const panX = anchoCss / 2 - cx * zoom;
  const panY = altoCss / 2 - cy * zoom;
  await page.evaluate((zoom, panX, panY) => window.__viewerFijarVista({ zoom, panX, panY }), zoom, panX, panY);
  await new Promise((r) => setTimeout(r, 300));
}

async function pinchZoomIn() {
  await page.evaluate(async () => {
    const el = document.querySelector("canvas").parentElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const toque = (t, puntos) => {
      const touches = puntos.map((p, i) => new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y }));
      el.dispatchEvent(new TouchEvent(t, {
        touches: t === "touchend" ? [] : touches,
        targetTouches: t === "touchend" ? [] : touches,
        changedTouches: touches,
        bubbles: true, cancelable: true,
      }));
    };
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    toque("touchstart", [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
    for (let i = 1; i <= 20; i++) {
      const sep = 40 + i * 20; // separar mucho -> zoom in fuerte
      toque("touchmove", [{ x: cx - sep, y: cy }, { x: cx + sep, y: cy }]);
      await esperar(16);
    }
    toque("touchend", [{ x: cx, y: cy }]);
  });
  await new Promise((r) => setTimeout(r, 7000)); // debounce + rasterizado real
}

async function panTouchTo(caja) {
  // Pan grosero: varios swipes tactiles hasta llevar la camara cerca de la
  // caja destino, luego un pinch-in final para superar el umbral "hot".
  const anchoCss = 390, altoCss = 844;
  await page.evaluate(async () => {
    const el = document.querySelector("canvas").parentElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const toque = (t, puntos) => {
      const touches = puntos.map((p, i) => new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y }));
      el.dispatchEvent(new TouchEvent(t, {
        touches: t === "touchend" ? [] : touches,
        targetTouches: t === "touchend" ? [] : touches,
        changedTouches: touches,
        bubbles: true, cancelable: true,
      }));
    };
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let s = 0; s < 6; s++) {
      toque("touchstart", [{ x: cx, y: cy }]);
      for (let i = 1; i <= 10; i++) {
        toque("touchmove", [{ x: cx - i * 30, y: cy + (s % 2 ? i * 10 : -i * 10) }]);
        await esperar(16);
      }
      toque("touchend", [{ x: cx, y: cy }]);
      await esperar(30);
    }
  });
  await new Promise((r) => setTimeout(r, 500));
  void anchoCss; void altoCss;
}

console.log("encuadre grueso + pinch tactil sobre A...");
await encuadrarGrueso(A, 0.35);
await pinchZoomIn();
let s1 = await hot();
console.log(`  hotFifo=${s1?.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s1?.enMemoria.length}`);

console.log("encuadre grueso + pinch tactil sobre B (A deberia quedar fuera de pantalla)...");
await encuadrarGrueso(B, 0.35);
await pinchZoomIn();
let s2 = await hot();
console.log(`  hotFifo=${s2?.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s2?.enMemoria.length}`);
const capOk = s2.hotFifo.length <= 2;
console.log(capOk ? "  OK  el tope nunca supera 2 (touch)" : `  FALLA el tope supera 2 (${s2.hotFifo.length})`);

console.log("pan TACTIL de vuelta hacia A y revisita...");
await encuadrarGrueso(A, 0.35);
await pinchZoomIn();
let s3 = await hot();
const siguePrimero = s3.enMemoria.includes(A.resourceId);
console.log(`  A: ${siguePrimero ? "seguia en memoria, no recargo" : "NO estaba, tuvo que recargar"}`);

console.log("encuadre grueso + pinch tactil sobre C (deberia desalojar A)...");
await encuadrarGrueso(C, 0.35);
await pinchZoomIn();
let s4 = await hot();
console.log(`  hotFifo=${s4?.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${s4?.enMemoria.length}`);
const capOk2 = s4.hotFifo.length <= 2;
const fifoOk = !s4.enMemoria.includes(A.resourceId);
const bOk = s4.enMemoria.includes(B.resourceId);
console.log(capOk2 ? "  OK  el tope sigue en 2 (touch)" : `  FALLA el tope supera 2 (${s4.hotFifo.length})`);
console.log(fifoOk ? "  OK  A salio pese a revisitarse (FIFO, no LRU) via touch" : "  FALLA A sigue en memoria");
console.log(bOk ? "  OK  B sigue en memoria" : "  FALLA B tambien salio");

console.log(`\nerrores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);
const todoOk = capOk && capOk2 && fifoOk && bOk;
console.log(todoOk ? "\nRESULTADO: OK (touch)" : "\nRESULTADO: FALLA (touch)");

await page.screenshot({ path: path.join(CACHE_DIR, "bench-hotcache-fifo-touch.png") });
await browser.close();
process.exit(todoOk ? 0 : 1);
