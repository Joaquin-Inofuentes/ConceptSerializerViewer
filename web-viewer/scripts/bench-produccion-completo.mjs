// Test integral contra PRODUCCION (unx-concept.vercel.app) sobre una URL
// real de dibujo:
//   1. Zoom + pan repetidos sobre el lienzo -> NO debe recargar lo ya cargado
//   2. Abrir la foto desde la galeria -> pan, zoom, rotar, descargar (PDF/JPG/PNG)
//   3. Chequea en Supabase (visor_eventos) que "abrir" (via URL directa) NO
//      se loguea, pero "descargar" (foto) SI, para confirmar que lectura de
//      codigo empirica.
//
//   node scripts/bench-produccion-completo.mjs [url]

import puppeteer from "puppeteer";
import path from "node:path";

const URL_DIBUJO =
  process.argv[2] ||
  "https://unx-concept.vercel.app/guada-y-flor-re/concepts/acuna-de-figueroa-1587/af-calculo-de-anclajes-1er-y-2do";
const CACHE_DIR = path.resolve(".cache/concepts");

console.log(`URL: ${URL_DIBUJO}\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 300)));
const cacheLogs = [];
page.on("console", (msg) => {
  if (msg.text().startsWith("[cache]")) cacheLogs.push(msg.text());
});

await page.goto(URL_DIBUJO, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 1500));
const botones0 = await page.$$("button");
for (const b of botones0) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) { await b.click(); break; }
}
await page.waitForFunction(() => typeof window.__viewerCajas === "function", { timeout: 60000, polling: 300 });
await page.waitForFunction(() => window.__viewerCajas().length > 0, { timeout: 60000, polling: 300 });
await new Promise((r) => setTimeout(r, 4000));

console.log("=".repeat(60));
console.log("PARTE 1: zoom + pan repetido no debe recargar");
console.log("=".repeat(60));

await page.evaluate(() => { window.__viewerDebugCache = true; });
const caja = await page.evaluate(() => window.__viewerCajas()[0]);
await page.evaluate((c) => {
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  const zoom = Math.max(window.innerWidth / w, window.innerHeight / h) * 4;
  const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
  const panX = window.innerWidth / 2 - cx * zoom;
  const panY = window.innerHeight / 2 - cy * zoom;
  window.__viewerFijarVista({ zoom, panX, panY });
}, caja);
await new Promise((r) => setTimeout(r, 5000));
const nInicial = (await page.evaluate(() => window.__viewerStats())).tiempos.n;
console.log(`zoom a resolucion plena listo (n=${nInicial}, hot=${JSON.stringify((await page.evaluate(() => window.__viewerHotCache())).hotFifo)})`);

let reraster = 0;
for (let i = 0; i < 8; i++) {
  const v = await page.evaluate(() => window.__viewerVista());
  await page.evaluate((vv) => {
    window.__viewerFijarVista({ zoom: vv.zoom, panX: vv.panX - 40, panY: vv.panY - 20 });
  }, v);
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 1200));
const nFinal = (await page.evaluate(() => window.__viewerStats())).tiempos.n;
const flashVisto = await page.evaluate(() => !!document.querySelector(".viewer-refinando"));
console.log(`n antes=${nInicial} n despues de 8 paneos=${nFinal}  ${nFinal === nInicial ? "OK  no recargo" : "FALLA  recargo"}`);
console.log(`cartel 'Afinando...' visible ahora: ${flashVisto ? "SI (mala señal)" : "no"}`);
const parte1Ok = nFinal === nInicial;

console.log("\n" + "=".repeat(60));
console.log("PARTE 2: seleccionar la foto y probar pan/zoom/rotar/descargar");
console.log("=".repeat(60));

// Abrir el menu "Galeria" (icono de imagenes) con un click real.
const botonGaleria = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => (b.title || "").startsWith("Imágenes"))
);
if (await page.evaluate((b) => b === null, botonGaleria)) throw new Error("no se encontro el boton de Galeria");
await botonGaleria.asElement().click();
await new Promise((r) => setTimeout(r, 1500));

const itemGaleria = await page.evaluateHandle(() => document.querySelector(".image-gallery .gallery-item"));
if (await page.evaluate((b) => b === null, itemGaleria)) throw new Error("la galeria no tiene items (¿el recurso no bajo a tiempo?)");
await itemGaleria.asElement().click();
await new Promise((r) => setTimeout(r, 300));

let previewOk = false;
for (let i = 0; i < 100; i++) {
  const s = await page.evaluate(() => window.__conceptsPreviewState());
  if (s.previewImage && !s.previewLoadingFull) { previewOk = true; break; }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(previewOk ? "OK  la foto abrio y termino de cargar full-res" : "FALLA  la foto nunca termino de cargar");

// --- PAN real (drag) ---
const antesTransform = await page.evaluate(() => document.querySelector(".fullscreen-preview > div")?.style.transform);
await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.move(720 - 120, 450 - 60, { steps: 8 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 200));
const despuesPanTransform = await page.evaluate(() => document.querySelector(".fullscreen-preview > div")?.style.transform);
const panOk = antesTransform !== despuesPanTransform;
console.log(panOk ? "OK  pan (arrastre) cambio el transform" : "FALLA  el pan no cambio nada");
console.log(`  antes:   ${antesTransform}`);
console.log(`  despues: ${despuesPanTransform}`);

// --- ZOOM real (wheel) ---
await page.mouse.move(720, 450);
await page.mouse.wheel({ deltaY: -300 });
await new Promise((r) => setTimeout(r, 250));
const despuesZoomTransform = await page.evaluate(() => document.querySelector(".fullscreen-preview > div")?.style.transform);
const zoomOk = despuesZoomTransform !== despuesPanTransform;
console.log(zoomOk ? "OK  zoom (rueda) cambio el transform" : "FALLA  el zoom no cambio nada");
console.log(`  despues: ${despuesZoomTransform}`);

// --- ROTAR ---
const rotarBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("Rotar"))
);
if (await page.evaluate((b) => b === null, rotarBtn)) throw new Error("no se encontro el boton de rotar");
await rotarBtn.asElement().click();
await new Promise((r) => setTimeout(r, 200));
const trasRotar1 = await page.evaluate(() => document.querySelector(".fullscreen-preview > div")?.style.transform);
const rotarOk1 = /rotate\(90deg\)/.test(trasRotar1 || "");
console.log(rotarOk1 ? "OK  1er click en rotar -> rotate(90deg)" : `FALLA  no rotó (transform: ${trasRotar1})`);
await rotarBtn.asElement().click();
await new Promise((r) => setTimeout(r, 200));
const trasRotar2 = await page.evaluate(() => document.querySelector(".fullscreen-preview > div")?.style.transform);
const rotarOk2 = /rotate\(180deg\)/.test(trasRotar2 || "");
console.log(rotarOk2 ? "OK  2do click en rotar -> rotate(180deg)" : `FALLA  no rotó bien (transform: ${trasRotar2})`);

// --- DESCARGAR (PDF / JPG / PNG), capturando el resultado sin disparar la
// descarga real del navegador. ---
await page.evaluate(() => {
  window.__descargasCapturadas = [];
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      window.__descargasCapturadas.push({ nombre: this.download, len: (this.href || "").length, href0: (this.href || "").slice(0, 30) });
      return; // no dispara la descarga real
    }
    return origClick.call(this);
  };
  // jsPDF (pdf.save()) NO llama a <a>.click(): internamente usa FileSaver,
  // que arma un blob, un ObjectURL, y dispara el click con
  // `dispatchEvent(new MouseEvent("click"))` en vez de `.click()` — eso NO
  // pasa por el parche de arriba (son dos entradas distintas al sistema de
  // eventos). Se intercepta en su lugar `URL.createObjectURL`, que es el
  // paso previo y comun a cualquier variante de ese patron.
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = origCreateObjectURL(blob);
    window.__descargasCapturadas.push({ nombre: `blob.${(blob.type || "").split("/")[1] || "bin"}`, len: blob.size, href0: url.slice(0, 30) });
    return url;
  };
});

// OJO: el lienzo de FONDO tambien tiene un boton titulado "Exportar"
// (App.tsx) — hay que buscar el de ADENTRO de .fullscreen-preview, si no
// (como paso en la primera version de este script) se clickea el de atras.
const exportarBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll(".fullscreen-preview button")].find((b) => (b.title || "") === "Exportar")
);
if (await page.evaluate((b) => b === null, exportarBtn)) throw new Error("no se encontro el boton Exportar");

for (const formato of ["PDF", "JPG", "PNG"]) {
  // El boton "Exportar" es un TOGGLE del menu: solo abrirlo si esta cerrado
  // (si ya esta abierto de la vuelta anterior, clickearlo de nuevo lo cierra).
  // Se busca el dropdown DENTRO de .fullscreen-preview: la galeria de fondo
  // (App.tsx) tiene su propio .dropdown-menu y confundia el selector global.
  const abierto = await page.evaluate(() => !!document.querySelector(".fullscreen-preview .dropdown-menu"));
  if (!abierto) {
    await exportarBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 200));
  }
  const btnFormato = await page.evaluateHandle(
    (f) => [...document.querySelectorAll(".fullscreen-preview .dropdown-menu button")].find((b) => b.textContent.includes(f)),
    formato
  );
  const esNulo = await page.evaluate((b) => b === null, btnFormato);
  if (esNulo) { console.log(`FALLA  no se encontro el boton de ${formato}`); continue; }
  const antesLen = await page.evaluate(() => window.__descargasCapturadas.length);
  await btnFormato.asElement().click();
  // jsPDF/pdf.js pueden tener cold-start de varios segundos (carga del
  // modulo + worker) la primera vez en la sesion — se espera activamente en
  // vez de un timeout fijo corto.
  for (let i = 0; i < 100; i++) {
    const len = await page.evaluate(() => window.__descargasCapturadas.length);
    if (len > antesLen) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}
await new Promise((r) => setTimeout(r, 1000));
const capturadas = await page.evaluate(() => window.__descargasCapturadas);
console.log("\ndescargas capturadas (sin disparar el guardado real):");
for (const d of capturadas) {
  console.log(`  ${d.nombre}  (${d.len} chars, ${d.href0}...)  ${d.len > 5000 ? "OK" : "FALLA (muy chico)"}`);
}
const descargaOk = ["pdf", "jpg", "png"].every((ext) => capturadas.some((d) => d.nombre.endsWith(`.${ext}`) && d.len > 5000));

await page.screenshot({ path: path.join(CACHE_DIR, "produccion-completo-final.png") });

console.log(`\nerrores JS: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);

const todoOk = parte1Ok && panOk && zoomOk && rotarOk1 && rotarOk2 && descargaOk && previewOk;
console.log(todoOk ? "\nRESULTADO GENERAL: OK" : "\nRESULTADO GENERAL: FALLA");

await browser.close();
process.exit(todoOk ? 0 : 1);
