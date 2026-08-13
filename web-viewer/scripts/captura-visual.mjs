// Captura pantallas del visor real para comprobar A OJO que las imagenes
// (planos PDF y fotos) se ven, no solo que el canvas tiene pixeles.
//
//   node scripts/captura-visual.mjs [--top N]

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/capturas");
const BASE = process.env.BASE_URL || "http://localhost:5173";
const TOP = Number(process.env.TOP || 3);

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesados = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

for (const f of pesados) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  // Viewport de telefono, que es el caso que nos importa.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  console.log(`\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
  try {
    await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });

    // 1) Placeholder (vista previa embebida)
    try {
      await page.waitForSelector(".viewer-placeholder-img", { timeout: 30000 });
      await page.screenshot({ path: path.join(OUT, `${f.id}-1-placeholder.png`) });
      console.log("  [1] placeholder capturado");
    } catch {
      console.log("  [1] sin placeholder");
    }

    // 2) Trazos ya dibujados, imagenes todavia cargando
    await page.waitForFunction(
      () => {
        const c = document.querySelector("canvas");
        return c && c.width > 1;
      },
      { timeout: 180000 }
    );
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(OUT, `${f.id}-2-trazos.png`) });
    console.log("  [2] trazos capturados");

    // 3) Todo cargado
    try {
      await page.waitForFunction(() => !document.querySelector(".viewer-loading-badge"), { timeout: 240000 });
    } catch {
      console.log("  (no termino de cargar, se captura igual)");
    }
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(OUT, `${f.id}-3-completo.png`) });
    console.log("  [3] completo capturado");

    // 4) Zoom al centro, para ver si los planos se leen de cerca
    await page.evaluate(async () => {
      const el = document.querySelector("canvas").parentElement;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (let i = 0; i < 8; i++) {
        el.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true })
        );
        await new Promise((r) => setTimeout(r, 60));
      }
      // Esperar el refinado por zoom (debounce 400 ms + rasterizado)
      await new Promise((r) => setTimeout(r, 6000));
    });
    await page.screenshot({ path: path.join(OUT, `${f.id}-4-zoom.png`) });
    console.log("  [4] zoom capturado");

    const stats = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
    console.log(`  stats: ${JSON.stringify(stats)}`);
  } catch (e) {
    console.log(`  ERROR: ${String(e).slice(0, 200)}`);
  }
  await page.close();
}

await browser.close();
console.log(`\nCapturas en ${OUT}`);
