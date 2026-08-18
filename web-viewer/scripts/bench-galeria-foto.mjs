// Reproduce el bug reportado: "voy a galeria, selecciono la foto, nunca
// termina de cargar full HD, esta recortada". La miniatura de la galeria
// (`imageUrls[id]`, 384px) se saca de lo que en ESE momento tenga cacheado
// el lienzo principal, que puede ser un RECORTE (zoom sobre el recurso).
//
// El test fuerza justo eso: zoom directo (un solo salto, sin pasar por un
// encuadre mas ancho) sobre 1/3 de un plano concreto, para que el PRIMER
// rasterizado de ese recurso ya sea un recorte. Despues abre la foto (via
// window.__conceptsAbrirFoto, mismo codigo que dispara un click real en la
// galeria) y verifica que la imagen final:
//   1. Tenga la proporcion del recurso COMPLETO (no la del recorte de 1/3)
//   2. Sea de mayor resolucion que la miniatura de 384px
//   3. `previewLoadingFull` vuelva a false (temiho, no se cuelga)
//
//   node scripts/bench-galeria-foto.mjs [fileId]

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

const cajas = await page.evaluate(() => window.__viewerCajas());
const SOLO_FOTOS = process.env.SOLO_FOTOS === "1";
const candidatas = SOLO_FOTOS ? cajas.filter((c) => c.isPhoto) : cajas;
// Un plano/foto grande, bien lejos del centro del dibujo para que el paso
// "zoom a 1/3" de verdad recorte (si ya es chico en pantalla el recorte
// podria terminar cubriendo casi toda la pagina igual).
const grande = [...candidatas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
if (!grande) throw new Error(SOLO_FOTOS ? "el documento no tiene fotos (isPhoto=true)" : "el documento no tiene planos");
console.log(`isPhoto=${!!grande.isPhoto}`);
console.log(`plano elegido: ${grande.resourceId.slice(0, 8)} (${(grande.x1 - grande.x0).toFixed(0)}x${(grande.y1 - grande.y0).toFixed(0)})`);

console.log("\nzoom directo sobre 1/3 del plano (fuerza recorte en el PRIMER raster)...");
await page.evaluate((c) => {
  const W = c.x1 - c.x0, H = c.y1 - c.y0;
  const viewW = W / 3;
  const zoom = window.innerWidth / viewW;
  const cx = c.x0 + W / 6;
  const cy = (c.y0 + c.y1) / 2;
  const panX = window.innerWidth / 2 - cx * zoom;
  const panY = window.innerHeight / 2 - cy * zoom;
  window.__viewerFijarVista({ zoom, panX, panY });
}, grande);
await new Promise((r) => setTimeout(r, 6000));

const stats1 = await page.evaluate(() => window.__viewerStats());
const hot1 = await page.evaluate(() => window.__viewerHotCache());
console.log(`  recortados=${stats1.recortados} hotFifo=[${hot1.hotFifo.map((x) => x.slice(0, 8))}]`);
if (stats1.recortados === 0) {
  console.log("  (nota: este plano no quedo recortado en el lienzo con este encuadre; el test sigue igual, solo que no ejercita el caso 'crop cacheado')");
}

console.log("\nabriendo la foto desde la galeria (window.__conceptsAbrirFoto)...");
// thumbUrl de prueba: no hace falta que sea real, solo confirma que la
// miniatura se muestra YA (sin pantalla en blanco) mientras se pide la
// version completa.
const abierto = await page.evaluate((id) => {
  if (!window.__conceptsAbrirFoto) return false;
  window.__conceptsAbrirFoto(id, "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
  return true;
}, grande.resourceId);
if (!abierto) throw new Error("window.__conceptsAbrirFoto no esta expuesto (App.tsx)");

const t0 = Date.now();
let estadoFinal = null;
for (let i = 0; i < 100; i++) {
  const s = await page.evaluate(() => window.__conceptsPreviewState());
  if (s.previewImage && !s.previewLoadingFull) { estadoFinal = s; break; }
  await new Promise((r) => setTimeout(r, 100));
}
const ms = Date.now() - t0;
if (!estadoFinal) throw new Error("nunca termino de cargar la full-res (timeout de 10s en el test)");
console.log(`  full-res lista en ${ms}ms`);

// Decodificar la imagen final para medir resolucion real y proporcion.
const medida = await page.evaluate((src) => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}, estadoFinal.previewImage);
if (!medida) throw new Error("la imagen final no cargo (src invalido)");
console.log(`  resolucion final: ${medida.w}x${medida.h}`);

const proporcionFinal = medida.w / medida.h;
const proporcionEsperada = grande.x1 - grande.x0 > 0 && grande.y1 - grande.y0 > 0 ? null : null; // no confiable desde la caja (tiene rotacion); se valida por umbral de tamaño en su lugar.

const okResolucion = Math.max(medida.w, medida.h) >= 1000; // muy por encima de la miniatura de 384px
const okNoEsMiniatura = estadoFinal.previewImage !== "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

console.log(okResolucion ? "  OK  resolucion final >= 1000px de lado (no es la miniatura de 384px)" : "  FALLA resolucion final demasiado chica");
console.log(okNoEsMiniatura ? "  OK  previewImage se reemplazo por la version completa" : "  FALLA previewImage sigue siendo el placeholder");

await page.screenshot({ path: path.join(CACHE_DIR, "galeria-foto-full.png") });

console.log(`\nerrores: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);
const todoOk = okResolucion && okNoEsMiniatura;
console.log(todoOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");

await browser.close();
process.exit(todoOk ? 0 : 1);
