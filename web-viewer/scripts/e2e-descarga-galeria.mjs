// Prueba la descarga multiple desde la galeria (varios dibujos seleccionados
// -> un PDF con secciones, o un .zip con un JPG por dibujo). Toca el camino
// de renderDocumentCanvas, que es el que rasteriza los recursos a resolucion
// de papel.
//
//   node scripts/e2e-descarga-galeria.mjs ["Ruta/De/Carpeta"] [pdf|jpg]

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const DEV_URL = "http://localhost:5173/";
const CACHE_DIR = path.resolve(".cache/concepts");
const DL_DIR = path.join(CACHE_DIR, "descargas-galeria");
const ruta = (process.argv[2] || "Fede y Franco/Concepts/V1").split("/");
const formato = (process.argv[3] || "pdf").toLowerCase();

await rm(DL_DIR, { recursive: true, force: true });
await mkdir(DL_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192"],
  defaultViewport: { width: 1280, height: 900 },
  protocolTimeout: 900000,
});
const page = await browser.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errores.push(m.text().slice(0, 200)); });
const cdp = await page.target().createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL_DIR, eventsEnabled: true });

await page.goto(DEV_URL, { waitUntil: "networkidle2" });
for (const b of await page.$$("button")) {
  const t = await page.evaluate((el) => el.textContent, b);
  if (t && t.includes("sin nombre")) { await b.click(); break; }
}
await page.waitForSelector(".gallery-card", { timeout: 60000 });

for (const nombre of ruta) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll(".folder-card .gallery-name")].some((e) => e.textContent === n),
    { timeout: 60000, polling: 100 },
    nombre
  );
  await page.evaluate((n) => {
    [...document.querySelectorAll(".folder-card")]
      .find((e) => e.querySelector(".gallery-name")?.textContent === n)
      .click();
  }, nombre);
}
await page.waitForFunction(
  () => !document.querySelector(".gallery-card.skeleton") && !document.querySelector(".gallery-status"),
  { timeout: 300000, polling: 500 }
);

// Seleccionar hasta 3 dibujos con el checkbox de cada tarjeta.
const seleccionados = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".gallery-grid:not(.gallery-folders-grid) .gallery-card")].slice(0, 3);
  cards.forEach((c) => c.querySelector(".gallery-checkbox")?.click());
  return cards.map((c) => c.querySelector(".gallery-name")?.textContent);
});
console.log(`seleccionados: ${seleccionados.join(", ")}`);

await page.waitForSelector(".gallery-toolbar", { timeout: 15000 });
await page.evaluate(() => {
  [...document.querySelectorAll(".gallery-toolbar-btn")].find((b) => b.textContent.includes("Descargar")).click();
});
await page.waitForSelector(".gallery-modal-option", { timeout: 15000 });
await page.evaluate((f) => {
  [...document.querySelectorAll(".gallery-modal-option")]
    .find((b) => b.textContent.toUpperCase().includes(f.toUpperCase()))
    .click();
}, formato);

const t0 = Date.now();
const esperado = formato === "pdf" ? /\.pdf$/ : /\.zip$/;
let archivo = null;
while (Date.now() - t0 < 900000) {
  const files = (await readdir(DL_DIR)).filter((f) => esperado.test(f));
  if (files.length) {
    let prev = -1;
    for (;;) {
      const s = await stat(path.join(DL_DIR, files[0]));
      if (s.size === prev && s.size > 0) { archivo = { name: files[0], size: s.size }; break; }
      prev = s.size;
      await new Promise((r) => setTimeout(r, 500));
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (archivo) {
  console.log(`descargado: ${archivo.name} — ${(archivo.size / 1048576).toFixed(2)} MB en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.log("NO SE DESCARGO NADA");
}
console.log(errores.length ? `errores: ${[...new Set(errores)].slice(0, 5).join(" | ")}` : "sin errores en consola");

await browser.close();
