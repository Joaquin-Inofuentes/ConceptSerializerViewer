// Dos comprobaciones puntuales que el test general no cubria bien:
//
//  1. NITIDEZ al hacer zoom. Se mide con "energia de bordes": una imagen
//     nitida tiene muchos saltos bruscos de luminancia entre pixeles vecinos;
//     una borrosa, pocos. Se compara el mismo encuadre antes y despues del
//     refinado por region, asi el numero significa algo en vez de ser una
//     impresion a ojo.
//  2. El limite de 3 archivos del cache, escribiendo entradas de 5 archivos
//     distintos a proposito (los dibujos reales no siempre tienen recursos,
//     asi que abrirlos no garantiza que el cache se llene).
//
//   node scripts/e2e-zoom-cache.mjs

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/capturas-zoom");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const f = manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[0];

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 150)));

/** Energia de bordes del canvas: suma de |diferencia de luminancia| entre
 * pixeles horizontalmente vecinos, normalizada. Mas alto = mas detalle fino. */
const nitidez = () =>
  page.evaluate(() => {
    const c = document.querySelector("canvas");
    const ctx = c.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let suma = 0;
    let n = 0;
    for (let y = 0; y < height; y += 3) {
      for (let x = 1; x < width; x += 3) {
        const i = (y * width + x) * 4;
        const j = (y * width + x - 1) * 4;
        const l1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const l2 = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
        suma += Math.abs(l1 - l2);
        n++;
      }
    }
    return +(suma / n).toFixed(3);
  });

console.log(`${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n`);
await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
// Primero el lienzo: esperar solo a que se vaya la barra da un falso positivo
// porque la barra todavia no aparecio.
await page.waitForFunction(
  () => {
    const c = document.querySelector("canvas");
    return c && c.width > 1;
  },
  { timeout: 300000 }
);
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 });
await new Promise((r) => setTimeout(r, 1500));

console.log(`nitidez con el dibujo completo: ${await nitidez()}`);

// Zoom fuerte al centro.
await page.evaluate(async () => {
  const el = document.querySelector("canvas").parentElement;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 22; i++) {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
  }
});

// Antes de que corra el refinado (debounce 400 ms + rasterizado).
await new Promise((r) => setTimeout(r, 600));
const antes = await nitidez();
await page.screenshot({ path: path.join(OUT, "zoom-sin-refinar.png") });

await new Promise((r) => setTimeout(r, 12000));
const despues = await nitidez();
const stats = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
await page.screenshot({ path: path.join(OUT, "zoom-refinado.png") });

console.log(`nitidez con zoom, sin refinar: ${antes}`);
console.log(`nitidez con zoom, refinado:    ${despues}`);
console.log(`mejora: ${(despues / Math.max(antes, 0.001)).toFixed(2)}x`);
console.log(`recursos recortados: ${stats?.recortados ?? "?"} de ${stats?.recursosEnMemoria ?? "?"} | ${stats?.ramImagenesMB} MB`);
console.log(errores.length ? `errores: ${errores.slice(0, 3).join(" | ")}` : "sin errores");

// --------------------------------------------------- limite de 3 archivos
const cache = await page.evaluate(async () => {
  const abrir = () =>
    new Promise((res) => {
      const q = indexedDB.open("concepts-raster", 4);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(null);
    });
  const db = await abrir();
  if (!db) return { error: "sin indexedDB" };
  const poner = (fila) =>
    new Promise((res) => {
      const tx = db.transaction("bitmaps", "readwrite");
      tx.objectStore("bitmaps").put(fila);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    });
  // Cinco archivos ficticios, con marcas de tiempo separadas para que la cola
  // tenga un orden claro.
  const base = Date.now() - 100000;
  for (let i = 0; i < 5; i++) {
    await poner({
      key: `fake${i}|r0|100x100`,
      fileId: `fake${i}`,
      resourceId: "r0",
      pedidoW: 100,
      pedidoH: 100,
      blob: new Blob([new Uint8Array(1024)]),
      width: 100,
      height: 100,
      bytes: 1024,
      usadoEn: base + i * 1000,
    });
  }
  const antes = await new Promise((res) => {
    const req = db.transaction("bitmaps", "readonly").objectStore("bitmaps").getAll();
    req.onsuccess = () => res([...new Set(req.result.map((x) => x.fileId))]);
  });
  // Dispara la poda guardando uno mas por el camino normal de la app.
  const mod = await import("/src/Gallery/rasterCache.ts");
  const lienzo = document.createElement("canvas");
  lienzo.width = 8;
  lienzo.height = 8;
  await mod.guardarRaster("fakeNuevo", "r0", 8, 8, lienzo);
  await new Promise((r) => setTimeout(r, 1500));
  const despues = await new Promise((res) => {
    const req = db.transaction("bitmaps", "readonly").objectStore("bitmaps").getAll();
    req.onsuccess = () => res([...new Set(req.result.map((x) => x.fileId))]);
  });
  return { antes: antes.length, despues, max: mod.MAX_ARCHIVOS_CACHEADOS };
});

console.log(`\ncache: ${cache.antes} archivos antes -> ${cache.despues?.length} despues (tope ${cache.max})`);
console.log(`quedaron: ${(cache.despues || []).join(", ")}`);
console.log(
  (cache.despues?.length ?? 99) <= (cache.max ?? 3)
    ? "  OK  la cola desaloja los mas viejos"
    : " FALLA el cache no respeta el tope"
);

await browser.close();
