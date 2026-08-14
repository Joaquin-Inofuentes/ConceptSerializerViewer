// Captura el plano completo y un detalle de la zona limite entre trazos e
// imagenes, para ver A OJO si hay desface (offset) entre notas y fotos.
//
//   node scripts/cap-desface.mjs <driveFileId>

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
if (!FILE) {
  console.error("Uso: node scripts/cap-desface.mjs <driveFileId>");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 200)));
await page.setViewport({ width: 1000, height: 1000, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${FILE}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

// 1) Vista completa: encuadra todo (trazos + imagenes) para ver el conjunto.
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
  return { x0, y0, x1, y1, zoom };
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: path.join(OUT, "desface-completo.png") });
console.log("completo:", JSON.stringify(full));

// 2) Detalle: zoom fuerte sobre el borde de la primera imagen, donde el
// bbox de trazos entra y sale de la caja de imagen (ahi cualquier corrimiento
// se nota).
const detalle = await page.evaluate(() => {
  const cajas = window.__viewerCajas();
  const canvas = document.querySelector("canvas");
  if (!cajas.length) return null;
  const img = cajas[0];
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
await page.screenshot({ path: path.join(OUT, "desface-detalle.png") });
console.log("detalle:", JSON.stringify(detalle));

await browser.close();
