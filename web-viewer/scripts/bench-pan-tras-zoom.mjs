// Reproduce el bug reportado: "zoom sobre un plano y luego paneo, se rompe
// y recarga el dibujo que ya tenia cargado" (incluye el "mini flash" del
// cartel "Afinando..."). Encuadra UN plano a resolucion plena y despues lo
// panea repetidamente dentro/cerca de si mismo, midiendo:
//   - cuantas veces se re-rasteriza (window.__viewerStats().tiempos.n)
//   - si el cartel ".viewer-refinando" (el "mini flash" visual) llega a
//     aparecer durante el asentado de cada gesto (polling cada 40ms)
//   - el detalle de decisiones via window.__viewerDebugCache (logs "[cache]")
//
//   node scripts/bench-pan-tras-zoom.mjs [fileId]

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
const logs = [];
page.on("console", (msg) => {
  if (msg.text().startsWith("[cache]")) logs.push(msg.text());
});

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
await page.evaluate(() => { window.__viewerDebugCache = true; });

const stats = () => page.evaluate(() => window.__viewerStats());
const hot = () => page.evaluate(() => window.__viewerHotCache());
const flashVisible = () => page.evaluate(() => !!document.querySelector(".viewer-refinando"));

const cajas = await page.evaluate(() => window.__viewerCajas());
const anchoCss = 1440, altoCss = 900;
const grande = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
if (!grande) throw new Error("el documento no tiene planos");

async function fijar(zoom, panX, panY) {
  await page.evaluate((z, x, y) => window.__viewerFijarVista({ zoom: z, panX: x, panY: y }), zoom, panX, panY);
}

const ZOOM_MULT = process.env.ZOOM_MULT ? Number(process.env.ZOOM_MULT) : 3;
const GESTOS = process.env.GESTOS ? Number(process.env.GESTOS) : 8;
const w = grande.x1 - grande.x0, h = grande.y1 - grande.y0;
const zoom = Math.max(anchoCss / w, altoCss / h) * ZOOM_MULT;
const cx = (grande.x0 + grande.x1) / 2, cy = (grande.y0 + grande.y1) / 2;
let panX = anchoCss / 2 - cx * zoom;
let panY = altoCss / 2 - cy * zoom;

console.log(`encuadrar el plano a resolucion plena (zoom x${ZOOM_MULT} sobre su ajuste)...`);
await fijar(zoom, panX, panY);
await new Promise((r) => setTimeout(r, 7000));
let s0 = await stats();
let h0 = await hot();
console.log(`  n=${s0.tiempos.n} fallos=${s0.cache.fallos} hotFifo=${h0.hotFifo.map((x) => x.slice(0, 8))}`);
await page.screenshot({ path: path.join(CACHE_DIR, "pan-tras-zoom-1-antes.png") });
logs.length = 0; // solo interesan los logs generados DESDE aca (durante el paneo)

console.log("\npanear repetidas veces (gestos cortos, como un dedo arrastrando)...");
let nAnterior = s0.tiempos.n;
let reraster = 0;
let flashes = 0;
for (let i = 0; i < GESTOS; i++) {
  // arrastre corto tipico: unos 150-300px, en varios pasos rapidos
  for (let step = 0; step < 5; step++) {
    panX -= 40;
    panY -= 20;
    await fijar(zoom, panX, panY);
    await new Promise((r) => setTimeout(r, 60));
  }
  // Poll fino durante el asentado (debounce 220ms + posible raster) para
  // pescar el cartel "Afinando..." aunque sea breve.
  let vistoFlash = false;
  for (let t = 0; t < 1200; t += 40) {
    if (await flashVisible()) vistoFlash = true;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (vistoFlash) flashes++;
  const s = await stats();
  const cambio = s.tiempos.n !== nAnterior;
  if (cambio) reraster++;
  console.log(
    `  gesto ${i + 1}: n=${s.tiempos.n} fallos=${s.cache.fallos} recortados=${s.recortados} ${cambio ? "-> RE-RASTERIZO" : "(cacheado, ok)"} ${vistoFlash ? "  [FLASH 'Afinando...' VISTO]" : ""}`
  );
  nAnterior = s.tiempos.n;
  if (i === 0) await page.screenshot({ path: path.join(CACHE_DIR, "pan-tras-zoom-2-tras-1-gesto.png") });
}

const hFinal = await hot();
console.log(`\nhotFifo final=${hFinal.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${hFinal.enMemoria.length}`);
console.log(`Re-rasterizados durante el paneo: ${reraster}/${GESTOS}`);
console.log(`Cartel "Afinando..." visto durante el paneo: ${flashes}/${GESTOS}`);
const idCorto = grande.resourceId.slice(0, 8);
const propios = logs.filter((l) => l.includes(idCorto));
console.log(`\nLogs [cache] para el plano objetivo (${idCorto}): ${propios.length}`);
propios.slice(0, 20).forEach((l) => console.log("  " + l));
console.log(`\nTotal logs [cache] (todos los recursos, incluye el anillo): ${logs.length}`);
console.log(`errores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);

await page.screenshot({ path: path.join(CACHE_DIR, "pan-tras-zoom-3-tras-8-gestos.png") });
await browser.close();
process.exit(reraster === 0 && flashes === 0 ? 0 : 1);
