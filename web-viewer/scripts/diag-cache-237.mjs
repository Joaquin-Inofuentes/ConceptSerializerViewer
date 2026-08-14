// Por que el cache del dibujo de 237 MB acierta 4 de 6: compara las claves
// que se GUARDAN contra las que se BUSCAN al reabrir.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const PERFIL = path.resolve(".cache/perfil-237");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const f = manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[1];

await rm(PERFIL, { recursive: true, force: true });
const browser = await puppeteer.launch({
  headless: "new",
  userDataDir: PERFIL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const leerFilas = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((res) => {
      const q = indexedDB.open("concepts-raster", 2);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(null);
    });
    if (!db) return [];
    return new Promise((res) => {
      const req = db.transaction("bitmaps", "readonly").objectStore("bitmaps").getAll();
      req.onsuccess = () =>
        res(
          req.result.map((r) => ({
            recurso: r.resourceId?.slice(0, 8),
            pedido: `${r.pedidoW}x${r.pedidoH}`,
            guardado: `${r.width}x${r.height}`,
            kb: Math.round((r.bytes || 0) / 1024),
          }))
        );
      req.onerror = () => res([]);
    });
  });

async function abrir(etiqueta) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(m.text().slice(0, 200));
  });

  await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      return c && c.width > 1;
    },
    { timeout: 300000 }
  );
  try {
    await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 });
  } catch {
    /* sigue */
  }
  await new Promise((r) => setTimeout(r, 5000)); // que terminen los guardados

  const stats = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
  const filas = await leerFilas(page);
  const enMemoria = await page.evaluate(() => {
    // Que tamaño se pidio para cada recurso en ESTA apertura.
    return window.__viewerStats ? window.__viewerStats().recursosEnMemoria : null;
  });

  console.log(`\n[${etiqueta}] cache ${JSON.stringify(stats?.cache)} | en memoria ${enMemoria}`);
  console.log(`  filas guardadas: ${filas.length}`);
  filas.forEach((r) => console.log(`    ${r.recurso} pedido=${r.pedido} guardado=${r.guardado} ${r.kb}KB`));
  if (errores.length) console.log(`  errores: ${[...new Set(errores)].slice(0, 4).join(" | ")}`);
  await page.close();
}

console.log(`${f.name} (${(f.size / 1048576).toFixed(1)} MB), ${f.id}`);
await abrir("1a vez");
await abrir("2a vez");
await browser.close();
