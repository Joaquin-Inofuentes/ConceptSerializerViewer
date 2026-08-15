// Igual que cap-desface.mjs pero contra el corpus LOCAL servido por
// servir-corpus.mjs (sin Drive), y guardando con nombre por archivo.
//
//   node scripts/servir-corpus.mjs 8788 &
//   node scripts/cap-desface-local.mjs <fileId> <etiqueta>

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "http://127.0.0.1:8788";
const FILE = process.argv[2];
const LABEL = process.argv[3] || FILE;
if (!FILE) {
  console.error("Uso: node scripts/cap-desface-local.mjs <fileId> <etiqueta>");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 200)));
await page.setViewport({ width: 1100, height: 1100, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${FILE}&origen=${encodeURIComponent(ORIGEN)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

const full = await page.evaluate(() => {
  const cajas = window.__viewerCajas();
  const canvas = document.querySelector("canvas");
  if (!cajas.length) return null;
  const x0 = Math.min(...cajas.map((c) => c.x0));
  const x1 = Math.max(...cajas.map((c) => c.x1));
  const y0 = Math.min(...cajas.map((c) => c.y0));
  const y1 = Math.max(...cajas.map((c) => c.y1));
  const margen = 1.15;
  const zoom = Math.min(canvas.clientWidth / ((x1 - x0) * margen), canvas.clientHeight / ((y1 - y0) * margen));
  window.__viewerFijarVista({
    zoom,
    panX: canvas.clientWidth / 2 - ((x0 + x1) / 2) * zoom,
    panY: canvas.clientHeight / 2 - ((y0 + y1) / 2) * zoom,
  });
  return { x0, y0, x1, y1, zoom, n: cajas.length };
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: path.join(OUT, `${LABEL}-completo.png`) });
console.log(`${LABEL} completo:`, JSON.stringify(full));

if (full) {
  const detalle = await page.evaluate(() => {
    const cajas = window.__viewerCajas();
    const canvas = document.querySelector("canvas");
    const img = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const cx = (img.x0 + img.x1) / 2;
    const cy = (img.y0 + img.y1) / 2;
    const zoom = Math.min(canvas.clientWidth, canvas.clientHeight) / ((img.x1 - img.x0) * 0.35);
    window.__viewerFijarVista({
      zoom,
      panX: canvas.clientWidth / 2 - cx * zoom,
      panY: canvas.clientHeight / 2 - cy * zoom,
    });
    return { cx, cy, zoom };
  });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: path.join(OUT, `${LABEL}-detalle.png`) });
  console.log(`${LABEL} detalle:`, JSON.stringify(detalle));
}

await browser.close();
