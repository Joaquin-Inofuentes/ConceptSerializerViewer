// Exporta el PDF REAL que produce la app: abre el dibujo, aprieta
// Exportar > PDF y deja que Chrome escriba la descarga en disco (via CDP
// Page.setDownloadBehavior). Asi lo que se guarda es exactamente el archivo
// que baja un usuario, no una reimplementacion del export.
//
//   node scripts/exportar-pdf.mjs <fileId> [carpetaSalida] [pdf|jpg|png]
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const ID = process.argv[2];
const DIR = path.resolve(process.argv[3] || ".cache/export");
const FORMATO = (process.argv[4] || "pdf").toUpperCase();
const BASE = process.env.BASE_URL || "http://localhost:5173";
const ORIGEN = process.env.ORIGEN || "http://127.0.0.1:8788";
await mkdir(DIR, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 1800000 });
const page = await browser.newPage();
page.setDefaultTimeout(1500000);
page.on("pageerror", (e) => console.error("[err]", e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text().slice(0, 160)); });
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

const cdp = await page.createCDPSession();
await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DIR });

await page.goto(`${BASE}/?tier=alta&file=${ID}&origen=${encodeURIComponent(ORIGEN)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 600000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 600000 }).catch(() => {});
// Deja que terminen de llegar y rasterizarse los planos antes de exportar.
await page.waitForFunction(() => {
  const s = window.__viewerStats ? window.__viewerStats() : null;
  return s && s.recursosEnMemoria > 0;
}, { timeout: 600000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 12000));

const antes = new Set(await readdir(DIR));

const abrio = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button.btn-tool")].find((x) => x.getAttribute("title") === "Exportar");
  if (!b) return false;
  b.click();
  return true;
});
if (!abrio) { console.error("no encontre el boton Exportar"); await browser.close(); process.exit(1); }
await new Promise((r) => setTimeout(r, 800));

const clickeo = await page.evaluate((fmt) => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").toUpperCase().includes(fmt));
  if (!b) return false;
  b.click();
  return true;
}, FORMATO);
if (!clickeo) { console.error(`no encontre el boton ${FORMATO}`); await browser.close(); process.exit(1); }
console.log(`click en ${FORMATO}, esperando la descarga...`);

// Espera a que aparezca un archivo nuevo y deje de crecer.
let salida = null;
for (let i = 0; i < 300; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const ahora = await readdir(DIR);
  const nuevos = ahora.filter((n) => !antes.has(n) && !n.endsWith(".crdownload"));
  if (nuevos.length) {
    const f = path.join(DIR, nuevos[0]);
    const a = (await stat(f)).size;
    await new Promise((r) => setTimeout(r, 2500));
    const b = (await stat(f)).size;
    if (a === b && b > 0) { salida = f; break; }
  }
}
if (!salida) { console.error("la descarga no aparecio"); await browser.close(); process.exit(1); }
const tam = (await stat(salida)).size;
console.log(`guardado: ${salida}`);
console.log(`  tamaño: ${(tam / 1048576).toFixed(2)} MB`);
await browser.close();
