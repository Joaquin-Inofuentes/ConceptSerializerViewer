// Igual que bench-pan-tras-zoom.mjs, pero maneja el mouse DE VERDAD (wheel
// para zoom, drag para pan) en vez de window.__viewerFijarVista, para
// confirmar que los handlers reales (handleWheel/handleMouseMove) quedan
// cubiertos y no solo el atajo de test.
//
//   node scripts/bench-pan-tras-zoom-real.mjs [fileId]

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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
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

const cx = 720, cy = 450; // centro del canvas 1440x900

console.log("zoom real con rueda del mouse (12 ticks, centrado)...");
await page.mouse.move(cx, cy);
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel({ deltaY: -160 }); // negativo = zoom in en handleWheel
  await new Promise((r) => setTimeout(r, 90));
}
await new Promise((r) => setTimeout(r, 7000)); // asienta ultimo raster a full res
let s0 = await stats();
let h0 = await hot();
console.log(`  n=${s0.tiempos.n} fallos=${s0.cache.fallos} hotFifo=${h0.hotFifo.map((x) => x.slice(0, 8))} recortados=${s0.recortados}`);
await page.screenshot({ path: path.join(CACHE_DIR, "pan-real-1-tras-zoom.png") });
logs.length = 0;

console.log("\npanear con drag real del mouse (8 arrastres cortos)...");
let nAnterior = s0.tiempos.n;
let reraster = 0;
let flashes = 0;
for (let i = 0; i < 8; i++) {
  const x0 = cx, y0 = cy;
  const x1 = cx - 70, y1 = cy - 40;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // arrastre en varios pasos, como un dedo/mouse real
  const pasos = 6;
  for (let p = 1; p <= pasos; p++) {
    const x = x0 + ((x1 - x0) * p) / pasos;
    const y = y0 + ((y1 - y0) * p) / pasos;
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, 25));
  }
  await page.mouse.up();

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
    `  gesto ${i + 1}: n=${s.tiempos.n} fallos=${s.cache.fallos} recortados=${s.recortados} ${cambio ? "-> RE-RASTERIZO" : "(cacheado, ok)"} ${vistoFlash ? "  [FLASH VISTO]" : ""}`
  );
  nAnterior = s.tiempos.n;
}

const hFinal = await hot();
console.log(`\nhotFifo final=${hFinal.hotFifo.map((x) => x.slice(0, 8))} enMemoria=${hFinal.enMemoria.length}`);
console.log(`Re-rasterizados durante el paneo real: ${reraster}/8`);
console.log(`Cartel "Afinando..." visto durante el paneo real: ${flashes}/8`);
console.log(`\nLogs [cache] durante el paneo (${logs.length}):`);
logs.slice(0, 20).forEach((l) => console.log("  " + l));
console.log(`\nerrores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);

await page.screenshot({ path: path.join(CACHE_DIR, "pan-real-2-tras-paneo.png") });
await browser.close();
process.exit(reraster === 0 && flashes === 0 ? 0 : 1);
