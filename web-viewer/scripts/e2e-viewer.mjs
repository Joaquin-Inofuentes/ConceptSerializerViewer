// Test end to end de la app real: abre la galeria, sube un .concepts por el
// input de "Subir .concepts" (el mismo camino que usa un usuario), espera a
// que el visor dibuje, y mide fluidez de pan y zoom con eventos de mouse
// reales via CDP.
//
// Se sube desde disco en vez de bajar de Drive para que el test mida el
// visor y no la conexion (el archivo demo pesa 262 MB).
//
//   node scripts/e2e-viewer.mjs [driveFileId]   (por defecto, el mas pesado)

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);
const target = process.argv[2] ? disponibles.find((f) => f.id === process.argv[2]) : disponibles[0];
if (!target) throw new Error("archivo no encontrado en el cache local");

console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB) — ${target.folderPath}\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 200)}`);
});

await page.goto(DEV_URL, { waitUntil: "networkidle2" });

// Sacar el cartel de nombre si aparece.
const botones = await page.$$("button");
for (const b of botones) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) {
    await b.click();
    break;
  }
}

const t0 = Date.now();
const input = await page.$('input[type="file"]');
if (!input) throw new Error("no se encontro el input de subida");
await input.uploadFile(target.localPath);

await page.waitForSelector(".canvas-wrapper canvas", { timeout: 180000 });
const msHastaCanvas = Date.now() - t0;

// Tiempo hasta que terminan de aparecer las fotos.
await page.waitForFunction(() => !document.querySelector(".viewer-loading-badge"), {
  timeout: 300000,
  polling: 500,
});
const msHastaTodo = Date.now() - t0;

const info = await page.evaluate(() => {
  const c = document.querySelector(".canvas-wrapper canvas");
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let conContenido = 0;
  let muestreados = 0;
  for (let i = 0; i < d.length; i += 4 * 53) {
    muestreados++;
    if (d[i + 3] > 0 && !(d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245)) conContenido++;
  }
  return {
    canvas: `${c.width}x${c.height}`,
    cssSize: `${c.style.width} x ${c.style.height}`,
    porcentajeDibujado: +((conContenido / muestreados) * 100).toFixed(1),
    titulo: document.querySelector(".filename-display")?.textContent ?? null,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
});

// --- Fluidez -------------------------------------------------------------
async function medirFrames(accion, etiqueta) {
  await page.evaluate(() => {
    window.__f = [];
    window.__stop = false;
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      window.__f.push(now - last);
      last = now;
      if (!window.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await accion();
  const r = await page.evaluate(() => {
    window.__stop = true;
    const f = window.__f.slice(3).sort((a, b) => a - b);
    if (f.length === 0) return null;
    const p = (q) => +f[Math.min(f.length - 1, Math.floor(f.length * q))].toFixed(1);
    return { frames: f.length, mediana: p(0.5), p90: p(0.9), peor: +f[f.length - 1].toFixed(1) };
  });
  console.log(
    `  ${etiqueta}: ${r.frames} frames | mediana ${r.mediana}ms (${Math.round(1000 / r.mediana)} fps) | p90 ${r.p90}ms | peor ${r.peor}ms`
  );
  return r;
}

const cx = 720;
const cy = 470;

const pan = await medirFrames(async () => {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx + i * 7, cy + Math.sin(i / 4) * 60);
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up();
}, "pan");

const zoom = await medirFrames(async () => {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel({ deltaY: i < 20 ? -120 : 120 });
    await new Promise((r) => setTimeout(r, 25));
  }
}, "zoom");

console.log(`\n  hasta ver el lienzo: ${msHastaCanvas}ms`);
console.log(`  hasta que cargan todas las fotos: ${msHastaTodo}ms`);
console.log(`  ${JSON.stringify(info)}`);
if (errores.length) {
  console.log(`\n  ERRORES EN LA PAGINA (${errores.length}):`);
  [...new Set(errores)].slice(0, 10).forEach((e) => console.log(`    - ${e}`));
} else {
  console.log(`\n  sin errores en consola`);
}

await page.screenshot({ path: path.join(CACHE_DIR, "e2e-visor.png") });
console.log(`  captura: ${path.join(CACHE_DIR, "e2e-visor.png")}`);

await browser.close();
