// Prueba "zoom all" de verdad: abre el dibujo, hace click en el boton real
// "Ver todo el dibujo", y verifica que TODAS las imagenes colocadas queden
// dentro del encuadre resultante (no solo los trazos). Tambien confirma
// visualmente con captura.
//
//   node scripts/cap-zoomall.mjs <driveFileId>

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
if (!FILE) {
  console.error("Uso: node scripts/cap-zoomall.mjs <driveFileId>");
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

// Click el boton real "Ver todo el dibujo".
const clickeo = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.title === "Ver todo el dibujo");
  if (!btn) return false;
  btn.click();
  return true;
});
if (!clickeo) {
  console.error("No se encontro el boton 'Ver todo el dibujo'");
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1000));

const chequeo = await page.evaluate(() => {
  const cajas = window.__viewerCajas();
  const vista = window.__viewerVista();
  const canvas = document.querySelector("canvas");
  const anchoCss = canvas.clientWidth, altoCss = canvas.clientHeight;
  // Documento -> pantalla, con la vista actual: panX = anchoCss/2 - cx*zoom
  // => screenX = panX + x*zoom.
  const dentro = cajas.every((c) => {
    const corners = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]];
    return corners.every(([x, y]) => {
      const sx = vista.panX + x * vista.zoom;
      const sy = vista.panY + y * vista.zoom;
      // Con margen chico de tolerancia (padding del encuadre).
      return sx >= -5 && sx <= anchoCss + 5 && sy >= -5 && sy <= altoCss + 5;
    });
  });
  return { totalImagenes: cajas.length, todasDentro: dentro, vista, anchoCss, altoCss };
});

console.log(`imagenes=${chequeo.totalImagenes} todas-dentro-del-encuadre=${chequeo.todasDentro} zoom=${chequeo.vista.zoom.toFixed(4)}`);
if (!chequeo.todasDentro) console.error("  !!! ZOOM ALL NO INCLUYE TODAS LAS IMAGENES");

await new Promise((r) => setTimeout(r, 2000));
const salida = path.join(OUT, `zoomall-${FILE.slice(0, 8)}.png`);
await page.screenshot({ path: salida });
console.log("captura:", salida);

await browser.close();
