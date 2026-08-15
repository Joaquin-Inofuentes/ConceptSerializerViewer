// Exporta el PDF REAL que produce la app (no una reimplementacion): abre el
// dibujo, aprieta Exportar > PDF, y captura el Blob que genera jsPDF
// interceptando createObjectURL y el click del <a download>. Asi lo que se
// guarda es exactamente lo que baja un usuario.
//
//   node scripts/exportar-pdf.mjs <fileId> <salida.pdf>
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const ID = process.argv[2];
const SALIDA = path.resolve(process.argv[3] || ".cache/export/dibujo.pdf");
const BASE = process.env.BASE_URL || "http://localhost:5173";
const ORIGEN = process.env.ORIGEN || "http://127.0.0.1:8788";
await mkdir(path.dirname(SALIDA), { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[err]", e.message.slice(0, 200)));
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

await page.evaluateOnNewDocument(() => {
  window.__capturado = null;
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    if (obj instanceof Blob) window.__ultimoBlob = obj;
    return origCreate(obj);
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && window.__ultimoBlob) {
      window.__capturado = { nombre: this.download, blob: window.__ultimoBlob };
      return; // no dispares la descarga real
    }
    return origClick.call(this);
  };
});

await page.goto(`${BASE}/?tier=alta&file=${ID}&origen=${encodeURIComponent(ORIGEN)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 6000));

const abrio = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button.btn-tool")].find((x) => x.getAttribute("title") === "Exportar");
  if (!b) return false;
  b.click();
  return true;
});
if (!abrio) { console.error("no encontre el boton Exportar"); await browser.close(); process.exit(1); }
await new Promise((r) => setTimeout(r, 600));

const clickeo = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("PDF"));
  if (!b) return false;
  b.click();
  return true;
});
if (!clickeo) { console.error("no encontre el boton PDF"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => window.__capturado !== null, { timeout: 600000 });
const b64 = await page.evaluate(async () => {
  const c = window.__capturado;
  const buf = await c.blob.arrayBuffer();
  let s = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { nombre: c.nombre, tipo: c.blob.type, datos: btoa(s) };
});
await writeFile(SALIDA, Buffer.from(b64.datos, "base64"));
console.log(`guardado: ${SALIDA}`);
console.log(`  nombre que usa la app: ${b64.nombre}`);
console.log(`  tipo: ${b64.tipo}  tamaño: ${(Buffer.from(b64.datos, "base64").length / 1048576).toFixed(2)} MB`);
await browser.close();
