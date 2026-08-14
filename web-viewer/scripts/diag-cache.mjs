// Diagnostico puntual del cache persistente de rasterizados: ¿se usa el
// worker o el fallback del hilo principal? ¿queda algo guardado en IndexedDB?
// ¿que claves? Contesta en una sola apertura, sin correr el benchmark entero.
//
//   node scripts/diag-cache.mjs [driveFileId]

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const PERFIL = path.resolve(".cache/perfil-diag");
const BASE = process.env.BASE_URL || "http://localhost:5173";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);
// Por defecto uno mediano: alcanza para saber si el mecanismo funciona.
const f = process.argv[2] ? disponibles.find((x) => x.id === process.argv[2]) : disponibles[5];
if (!f) throw new Error("archivo no encontrado");

await rm(PERFIL, { recursive: true, force: true });
const browser = await puppeteer.launch({
  headless: "new",
  userDataDir: PERFIL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function abrir(etiqueta) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const workers = [];
  page.on("workercreated", (w) => workers.push(w.url().split("/").pop()));
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message.slice(0, 150)));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(m.text().slice(0, 150));
  });
  let bytes = 0;
  page.on("response", (r) => {
    if (r.url().includes("concepts-drive")) bytes += Number(r.headers()["content-length"] || 0);
  });

  const t0 = Date.now();
  await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      return c && c.width > 1;
    },
    { timeout: 180000 }
  );
  try {
    await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 });
  } catch {
    /* sigue */
  }
  const ms = Date.now() - t0;

  // Dejar respirar a los guardados en IndexedDB (son fire-and-forget).
  await new Promise((r) => setTimeout(r, 3000));

  const idb = await page.evaluate(async () => {
    const abrirDb = () =>
      new Promise((res) => {
        const req = indexedDB.open("concepts-raster", 2);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
        req.onupgradeneeded = () => {
          try {
            req.result.createObjectStore("bitmaps", { keyPath: "key" });
          } catch {
            /* ya existe */
          }
        };
      });
    const db = await abrirDb();
    if (!db) return { error: "sin indexedDB" };
    if (!db.objectStoreNames.contains("bitmaps")) return { error: "sin store" };
    return new Promise((res) => {
      const tx = db.transaction("bitmaps", "readonly");
      const req = tx.objectStore("bitmaps").getAll();
      req.onsuccess = () => {
        const filas = req.result || [];
        res({
          filas: filas.length,
          bytes: filas.reduce((n, r) => n + (r.bytes || 0), 0),
          muestra: filas.slice(0, 3).map((r) => ({ key: r.key.slice(-42), wh: `${r.width}x${r.height}`, kb: Math.round((r.bytes || 0) / 1024) })),
        });
      };
      req.onerror = () => res({ error: "getAll fallo" });
    });
  });

  const stats = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
  console.log(`\n[${etiqueta}] ${ms}ms | ${(bytes / 1048576).toFixed(1)} MB de red`);
  console.log(`  workers creados: ${workers.length ? workers.join(", ") : "NINGUNO (fallback al hilo principal)"}`);
  console.log(`  cache en memoria: ${JSON.stringify(stats?.cache)}`);
  console.log(`  IndexedDB: ${JSON.stringify(idb)}`);
  if (errores.length) console.log(`  errores: ${[...new Set(errores)].slice(0, 3).join(" | ")}`);
  await page.close();
  return { ms, bytes };
}

console.log(`${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
const a = await abrir("1a vez");
const b = await abrir("2a vez");
console.log(
  `\n=> reapertura: ${a.ms}ms -> ${b.ms}ms (${(a.ms / b.ms).toFixed(1)}x) | red ${(a.bytes / 1048576).toFixed(1)} -> ${(b.bytes / 1048576).toFixed(1)} MB`
);

await browser.close();
