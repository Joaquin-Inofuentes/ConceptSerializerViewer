// Captura un plano MUY de cerca, para leer a ojo si el texto sale bien
// orientado y si las anotaciones caen donde corresponde.
//
//   ORIGEN=http://127.0.0.1:8788 node scripts/cap-detalle.mjs [indicePlano] [fraccionX]

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";
const INDICE = Number(process.argv[2] || 0);
const FRAC = Number(process.argv[3] || 0.06);
const ANCHO = Number(process.env.FRAC_ANCHO || 0.16);

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const f = process.env.FILE
  ? manifest.files.find((x) => x.id === process.env.FILE)
  : manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[0];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
// Pantalla grande: se trata de LEER el plano, no de simular un telefono.
await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

const info = await page.evaluate(
  ({ indice, frac, ancho }) => {
    const cajas = window.__viewerCajas();
    const planos = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    const c = planos[indice];
    const canvas = document.querySelector("canvas");
    const cubrir = (c.x1 - c.x0) * ancho;
    const zoom = Math.min(canvas.clientWidth, canvas.clientHeight) / cubrir;
    window.__viewerFijarVista({
      zoom,
      panX: canvas.clientWidth / 2 - (c.x0 + (c.x1 - c.x0) * frac) * zoom,
      panY: canvas.clientHeight / 2 - ((c.y0 + c.y1) / 2) * zoom,
    });
    return { plano: c.resourceId.slice(0, 8), zoom: +zoom.toFixed(3) };
  },
  { indice: INDICE, frac: FRAC, ancho: ANCHO }
);

// El refinado por region tarda: se le da tiempo para que la captura muestre la
// version nitida y no la de pantalla completa estirada.
await new Promise((r) => setTimeout(r, 14000));
const stats = await page.evaluate(() => window.__viewerStats());
const salida = path.join(OUT, `plano-${INDICE}-${FRAC}.png`);
await page.screenshot({ path: salida });
console.log(`${f.name} | plano ${info.plano} | zoom ${info.zoom}`);
console.log(`recortados ${stats.recortados}/${stats.recursosEnMemoria} | ${stats.ramImagenesMB} MB`);
console.log(salida);
await browser.close();
