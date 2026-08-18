// Condiciones de carrera del flujo miniatura -> full HD (window.__conceptsAbrirFoto):
//   A) abrir foto 1, sin esperar abrir foto 2: el full-res tardio de la 1
//      NO debe pisar lo que se ve de la 2.
//   B) abrir una foto y cerrarla antes de que llegue el full-res: la
//      respuesta tardia NO debe reabrir el visor.
//
//   node scripts/bench-galeria-foto-carrera.mjs [fileId]

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

await page.goto(BASE, { waitUntil: "domcontentloaded" });
const botones = await page.$$("button");
for (const b of botones) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) { await b.click(); break; }
}
const input = await page.$('input[type="file"]');
await input.uploadFile(target.localPath);
await page.waitForSelector(".canvas-wrapper canvas", { timeout: 180000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000, polling: 500 });
await new Promise((r) => setTimeout(r, 1000));

const cajas = await page.evaluate(() => window.__viewerCajas());
const fotos = [...new Map(cajas.filter((c) => c.isPhoto).map((c) => [c.resourceId, c])).values()];
if (fotos.length < 2) throw new Error(`hacen falta 2 fotos distintas, hay ${fotos.length}`);
const [foto1, foto2] = fotos;
console.log(`foto1=${foto1.resourceId.slice(0, 8)} foto2=${foto2.resourceId.slice(0, 8)}\n`);

console.log("A) abrir foto1 y, sin esperar, abrir foto2...");
await page.evaluate((id) => window.__conceptsAbrirFoto(id, "thumb1"), foto1.resourceId);
await new Promise((r) => setTimeout(r, 30)); // dispara el pedido de full-res de foto1, no lo espera
await page.evaluate((id) => window.__conceptsAbrirFoto(id, "thumb2"), foto2.resourceId);

let finalA = null;
for (let i = 0; i < 100; i++) {
  const s = await page.evaluate(() => window.__conceptsPreviewState());
  if (s.previewImage && !s.previewLoadingFull) { finalA = s; break; }
  await new Promise((r) => setTimeout(r, 100));
}
if (!finalA) throw new Error("A) nunca asento (timeout)");
// Verificar que lo que quedo mostrado corresponde a foto2 (la ultima
// abierta), no a un resultado tardio de foto1 pisandola.
const medidaA = await page.evaluate(
  (src) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => resolve(null); img.src = src; }),
  finalA.previewImage
);
// Espera extra por si el pedido de foto1 (mas viejo) resuelve tarde y
// pisa el estado.
await new Promise((r) => setTimeout(r, 3000));
const s2 = await page.evaluate(() => window.__conceptsPreviewState());
const noSePiso = s2.previewImage === finalA.previewImage;
console.log(`  quedo mostrada una imagen de ${medidaA ? medidaA.w + "x" + medidaA.h : "??"}`);
console.log(noSePiso ? "  OK  el resultado tardio de foto1 no piso la vista de foto2" : "  FALLA foto1 (mas vieja) piso la vista de foto2 al resolver tarde");

console.log("\nB) abrir una foto y cerrar antes de que llegue el full-res...");
await page.evaluate((id) => window.__conceptsAbrirFoto(id, "thumb3"), foto1.resourceId);
await new Promise((r) => setTimeout(r, 30));
await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
await new Promise((r) => setTimeout(r, 100));
const sTrasCerrar = await page.evaluate(() => window.__conceptsPreviewState());
const cerroBien = sTrasCerrar.previewImage === null;
console.log(`  tras ESC: previewImage=${sTrasCerrar.previewImage}`);
console.log(cerroBien ? "  OK  se cerro" : "  FALLA no se cerro");

await new Promise((r) => setTimeout(r, 4000)); // deja tiempo a que la respuesta tardia (si llega) intente pisar
const sFinal = await page.evaluate(() => window.__conceptsPreviewState());
const siguioCerrado = sFinal.previewImage === null;
console.log(siguioCerrado ? "  OK  la respuesta tardia NO reabrio el visor" : "  FALLA la respuesta tardia reabrio el visor de fotos");

const todoOk = noSePiso && cerroBien && siguioCerrado;
console.log(todoOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");
await browser.close();
process.exit(todoOk ? 0 : 1);
