// Mide cuanto se gana al REABRIR un dibujo ya visto (cache persistente de
// rasterizados en IndexedDB). Rasterizar un PDF con pdf.js cuesta ~1,5 s en
// desktop y ~9 s en gama baja, y ese costo se pagaba entero cada vez.
//
// Usa el MISMO perfil de navegador entre las dos aperturas (userDataDir), que
// es lo que hace que IndexedDB persista — como en un telefono real.
//
//   node scripts/bench-reapertura.mjs

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const PERFIL = path.resolve(".cache/perfil-chrome");
const BASE = process.env.BASE_URL || "http://localhost:5173";
const THROTTLE = Number(process.env.THROTTLE || 6);

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesados = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size).slice(0, 2);

// Perfil limpio, para que la primera apertura sea de verdad la primera.
await rm(PERFIL, { recursive: true, force: true });

async function abrir(browser, f, etiqueta) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  let bytes = 0;
  page.on("response", (res) => {
    if (res.url().includes("concepts-drive")) bytes += Number(res.headers()["content-length"] || 0);
  });

  await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
  await page.emulateCPUThrottling(THROTTLE);
  const t0 = Date.now();

  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      return c && c.width > 1;
    },
    { timeout: 180000 }
  );
  const msTrazos = Date.now() - t0;

  let msTodo = null;
  try {
    await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 });
    msTodo = Date.now() - t0;
  } catch {
    /* no termino */
  }

  const stats = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
  const c = stats?.cache;
  console.log(
    `  ${etiqueta}: trazos ${msTrazos}ms | completo ${msTodo ?? ">240s"}ms | ${(bytes / 1048576).toFixed(1)} MB | ${stats?.recursosEnMemoria ?? "?"} recursos | cache ${c ? `${c.aciertos} aciertos / ${c.fallos} fallos` : "?"}`
  );
  await page.close();
  return { msTrazos, msTodo, MB: +(bytes / 1048576).toFixed(1) };
}

const browser = await puppeteer.launch({
  headless: "new",
  userDataDir: PERFIL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const resultados = [];
for (const f of pesados) {
  console.log(`\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
  const primera = await abrir(browser, f, "1a vez ");
  const segunda = await abrir(browser, f, "2a vez ");
  const ganancia =
    primera.msTodo && segunda.msTodo ? +(primera.msTodo / segunda.msTodo).toFixed(1) : null;
  console.log(`  -> ${ganancia ? `${ganancia}x mas rapido al reabrir` : "no comparable"}`);
  resultados.push({ archivo: f.name, MB: +(f.size / 1048576).toFixed(1), primera, segunda, ganancia });
}

await browser.close();
console.log("\n" + JSON.stringify(resultados, null, 2));
