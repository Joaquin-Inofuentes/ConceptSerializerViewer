// ¿De verdad se esta rasterizando fuera del hilo principal?
//
// El perfil mostraba pdf.js corriendo EN el hilo principal durante los gestos,
// que es justo lo que el pool de workers deberia evitar. Este diagnostico
// responde si los workers se crean, si el navegador soporta OffscreenCanvas y
// cuantas veces se cayo al camino del hilo principal.
//
//   ORIGEN=http://127.0.0.1:8788 node scripts/diag-workers.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const f = manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[0];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
const errores = [];
page.on("pageerror", (e) => errores.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 200)}`);
});
const workers = [];
page.on("workercreated", (w) => workers.push(w.url().split("/").pop().split("?")[0]));
await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const url = `${BASE}/?tier=baja&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });

const soporta = await page.evaluate(async () => {
  const m = await import("/src/device.ts");
  return {
    offscreen: m.soportaOffscreen(),
    tier: m.getBudgets().tier,
    concurrency: m.getBudgets().concurrency,
    tieneOffscreenCanvas: typeof OffscreenCanvas !== "undefined",
    tieneConvertToBlob:
      typeof OffscreenCanvas !== "undefined" && typeof OffscreenCanvas.prototype.convertToBlob === "function",
  };
});

await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));

const stats = await page.evaluate(() => window.__viewerStats?.() ?? null);

console.log(`archivo: ${f.name}`);
console.log(`soportaOffscreen: ${soporta.offscreen}  (OffscreenCanvas ${soporta.tieneOffscreenCanvas}, convertToBlob ${soporta.tieneConvertToBlob})`);
console.log(`tier ${soporta.tier}, concurrency ${soporta.concurrency}`);
const cuenta = workers.reduce((a, w) => ((a[w] = (a[w] || 0) + 1), a), {});
console.log(`workers creados: ${workers.length ? JSON.stringify(cuenta) : "NINGUNO"}`);
console.log(`recursos rasterizados: ${stats?.tiempos?.n ?? "?"} | en hilo principal: ${stats?.tiempos?.enMainMs !== undefined ? `${(stats.tiempos.enMainMs / 1000).toFixed(1)}s` : "(sin dato)"}`);
console.log(`errores: ${errores.length ? [...new Set(errores)].slice(0, 6).join("\n         ") : "ninguno"}`);
await browser.close();
