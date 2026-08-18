// Verifica que un plano "hot" (ver hotFifoRef) TODAVIA se afine si el
// usuario sigue haciendo zoom despues de que se volvio hot (regresion del
// fix anterior, que congelaba la escala para siempre y dejaba el plano
// pixelado) — y que a la vez, a zoom EXTREMO (mas alla del presupuesto por
// recurso), no thrashee: deja de insistir en vez de re-pedir en cada gesto
// sin lograr nada mejor (ver topeAlcanzadoRef).
//
//   node scripts/bench-zoom-progresivo.mjs [fileId]

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
const cacheLogs = [];
page.on("console", (msg) => {
  if (msg.text().startsWith("[cache]")) cacheLogs.push(msg.text());
});

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
const grande = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
if (!grande) throw new Error("el documento no tiene planos");
console.log(`plano: ${grande.resourceId.slice(0, 8)}\n`);

async function fijarZoom(mult) {
  const w = grande.x1 - grande.x0, h = grande.y1 - grande.y0;
  const zoom = Math.max(1440 / w, 900 / h) * mult;
  const cx = (grande.x0 + grande.x1) / 2, cy = (grande.y0 + grande.y1) / 2;
  const panX = 1440 / 2 - cx * zoom;
  const panY = 900 / 2 - cy * zoom;
  await page.evaluate((z, x, y) => window.__viewerFijarVista({ zoom: z, panX: x, panY: y }), zoom, panX, panY);
}

const stats = () => page.evaluate(() => window.__viewerStats());

await page.evaluate(() => { window.__viewerDebugCache = true; });

const ZOOM1 = process.env.ZOOM1 ? Number(process.env.ZOOM1) : 1.3;
const ZOOM2 = process.env.ZOOM2 ? Number(process.env.ZOOM2) : 2.6;
const ZOOM3 = process.env.ZOOM3 ? Number(process.env.ZOOM3) : 8;

console.log(`PASO 1: zoom moderado (x${ZOOM1}), esperar a que se vuelva hot...`);
await fijarZoom(ZOOM1);
await new Promise((r) => setTimeout(r, 6000));
let s1 = await stats();
let hot1 = await page.evaluate(() => window.__viewerHotCache());
console.log(`  n=${s1.tiempos.n} hotFifo=${JSON.stringify(hot1.hotFifo.map((x) => x.slice(0, 8)))}`);
if (!hot1.hotFifo.includes(grande.resourceId)) console.log("  (nota: no llego a 'hot' con este zoom, el paso 2 igual es valido)");

console.log(`\nPASO 2: zoom MAS FUERTE (x${ZOOM2}) sobre el MISMO plano ya hot -> debe afinarse (mas pixeles), no quedarse pixelado...`);
const nAntesPaso2 = s1.tiempos.n;
cacheLogs.length = 0;
await fijarZoom(ZOOM2);
await new Promise((r) => setTimeout(r, 6000));
let s2 = await stats();
const idCorto = grande.resourceId.slice(0, 8);
console.log("  logs [cache] del propio plano tras el zoom x2.6:");
cacheLogs.filter((l) => l.includes(idCorto)).forEach((l) => console.log("    " + l));
const seAfino = s2.tiempos.n > nAntesPaso2 && s2.pixelesImagenes > s1.pixelesImagenes;
console.log(`  n=${s2.tiempos.n} (antes ${nAntesPaso2}) pixelesImagenes=${s2.pixelesImagenes} (antes ${s1.pixelesImagenes})`);
console.log(seAfino ? "  OK  se afino con el zoom (no quedo pixelado congelado)" : "  FALLA no se afino");

console.log(`\nPASO 3: zoom EXTREMO (x${ZOOM3}, mas alla de cualquier presupuesto razonable), despues 6 gestos de pan/zoom -> NO debe thrashear...`);
await fijarZoom(ZOOM3);
await new Promise((r) => setTimeout(r, 6000));
const nTrasExtremo = (await stats()).tiempos.n;
let ultimoN = nTrasExtremo;
let cambios = 0;
for (let i = 0; i < 6; i++) {
  const v = await page.evaluate(() => window.__viewerVista());
  await page.evaluate((vv) => window.__viewerFijarVista({ zoom: vv.zoom, panX: vv.panX - 30, panY: vv.panY - 15 }), v);
  await new Promise((r) => setTimeout(r, 700));
  const n = (await stats()).tiempos.n;
  if (n !== ultimoN) cambios++;
  ultimoN = n;
}
console.log(`  n tras zoom extremo=${nTrasExtremo}, cambios de 'n' en los 6 gestos siguientes=${cambios}`);
// Se tolera COMO MUCHO 1 (el ajuste natural al primer gesto tras el salto de
// zoom); si sigue subiendo en cada uno, es el thrash de vuelta.
const noThrashea = cambios <= 1;
console.log(noThrashea ? "  OK  no thrashea a zoom extremo" : "  FALLA sigue re-pidiendo en cada gesto sin mejorar");

console.log(`\nerrores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);
const todoOk = seAfino && noThrashea;
console.log(todoOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");

await page.screenshot({ path: path.join(CACHE_DIR, "zoom-progresivo-final.png") });
await browser.close();
process.exit(todoOk ? 0 : 1);
