// Prueba a mano el boton nuevo de "rotar 90 a la derecha" en la vista de
// una foto: abre el dibujo, abre la Galeria de imagenes, hace click en la
// primera foto, rota, y guarda screenshots antes/despues.
//
//   node scripts/cap-rotar.mjs <driveFileId>

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
if (!FILE) {
  console.error("Uso: node scripts/cap-rotar.mjs <driveFileId>");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text().slice(0, 200)); });
await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${FILE}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// Abre el menu "Galeria" (icono de imagen).
const abrioMenu = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const btn = btns.find((b) => /^Imágenes:/.test(b.title || ""));
  if (!btn) return false;
  btn.click();
  return true;
});
console.log("abrio menu imagenes:", abrioMenu);
await new Promise((r) => setTimeout(r, 2500));

// Click en la primera foto que ya tenga preview cargado.
const abrioFoto = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".gallery-item")].filter((it) => !it.classList.contains("gallery-item-lejos"));
  if (!items.length) return false;
  items[0].click();
  return true;
});
console.log("abrio foto:", abrioFoto);
await new Promise((r) => setTimeout(r, 1500));

await page.screenshot({ path: path.join(OUT, "rotar-0-antes.png") });

// Click en el boton de rotar (title "Rotar 90...").
for (let i = 1; i <= 3; i++) {
  const roto = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.title || "").startsWith("Rotar 90"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(OUT, `rotar-${i}-despues.png`) });
  console.log(`rotacion #${i} click:`, roto);
}

await browser.close();
