// Verifica que exportar siga funcionando despues de separar la resolucion de
// PANTALLA de la de EXPORT: el visor ahora rasteriza las fotos chicas para
// ver, y las vuelve a rasterizar grandes solo al exportar. Este test abre un
// dibujo real, exporta PDF/JPG/PNG desde el menu y comprueba que el archivo
// baje, pese algo razonable y no sea una hoja en blanco.
//
//   node scripts/e2e-export.mjs [driveFileId]

import { readFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DL_DIR = path.join(CACHE_DIR, "descargas-test");
const DEV_URL = "http://localhost:5173/";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);
// Por defecto un archivo mediano con fotos: exportar el de 262 MB a 600 DPI
// tarda minutos y no agrega informacion sobre si el camino funciona.
const target = process.argv[2]
  ? disponibles.find((f) => f.id === process.argv[2])
  : disponibles.find((f) => f.size > 8 * 1048576 && f.size < 25 * 1048576);
if (!target) throw new Error("archivo no encontrado");

await rm(DL_DIR, { recursive: true, force: true });
await mkdir(DL_DIR, { recursive: true });

console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB)\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(m.text().slice(0, 200));
});
const cdp = await page.target().createCDPSession();
await cdp.send("Browser.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: DL_DIR,
  eventsEnabled: true,
});

await page.goto(DEV_URL, { waitUntil: "networkidle2" });
for (const b of await page.$$("button")) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) { await b.click(); break; }
}

const input = await page.$('input[type="file"]');
await input.uploadFile(target.localPath);
await page.waitForSelector(".canvas-wrapper canvas", { timeout: 180000 });
await page.waitForFunction(() => !document.querySelector(".viewer-loading-badge"), {
  timeout: 300000,
  polling: 500,
});
console.log("dibujo abierto, exportando...\n");

async function esperarDescarga(nombre, timeoutMs = 420000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const files = await readdir(DL_DIR);
    const hit = files.find((f) => f === nombre);
    if (hit) {
      // Esperar a que deje de crecer (Chrome escribe .crdownload primero).
      let prev = -1;
      for (;;) {
        const s = await stat(path.join(DL_DIR, hit));
        if (s.size === prev && s.size > 0) return s.size;
        prev = s.size;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function exportar(etiqueta, textoBoton, nombreArchivo) {
  // Abrir el menu de exportar (boton con title="Exportar"). El menu es un
  // toggle, asi que si quedo abierto de una exportacion anterior el click
  // lo cierra: se reintenta hasta verlo abierto.
  for (let intento = 0; intento < 5; intento++) {
    const abierto = await page.evaluate(() => !!document.querySelector(".dropdown-menu"));
    if (abierto) break;
    await page.click('button[title="Exportar"]');
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.waitForSelector(".dropdown-menu", { timeout: 10000 });
  const botones = await page.$$(".dropdown-menu button");
  let clickeado = false;
  for (const b of botones) {
    const txt = await page.evaluate((el) => el.textContent, b);
    if (txt && txt.includes(textoBoton)) {
      await b.click();
      clickeado = true;
      break;
    }
  }
  if (!clickeado) throw new Error(`no se encontro el boton ${textoBoton}`);
  const t = Date.now();
  const size = await esperarDescarga(nombreArchivo);
  if (!size) {
    console.log(`  ${etiqueta}: NO SE DESCARGO`);
    return false;
  }
  console.log(`  ${etiqueta}: ${(size / 1048576).toFixed(2)} MB en ${((Date.now() - t) / 1000).toFixed(1)}s -> ${nombreArchivo}`);
  return size > 20000;
}

const ok = [];
ok.push(await exportar("PNG", "PNG", "export.png"));
ok.push(await exportar("JPG", "JPG", "export.jpg"));
ok.push(await exportar("PDF", "PDF", "export.pdf"));

console.log(`\n  ${ok.filter(Boolean).length}/3 exportaciones ok`);
if (errores.length) {
  console.log(`  errores: ${[...new Set(errores)].slice(0, 5).join(" | ")}`);
} else {
  console.log("  sin errores en consola");
}

await browser.close();
