// Zoom MUY cerrado sobre un trazo puntual que cae dentro de una imagen, para
// ver a ojo si la marca de lapiz queda exactamente donde deberia sobre la
// foto (o si hay un corrimiento).
//
//   node scripts/cap-trazo.mjs <driveFileId>

import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
if (!FILE) {
  console.error("Uso: node scripts/cap-trazo.mjs <driveFileId>");
  process.exit(1);
}
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 200)));
await page.setViewport({ width: 1000, height: 1000, deviceScaleFactor: 2 });

// 1) Geometria via el parser directo (mismo patron que los otros audits).
await page.goto(BASE, { waitUntil: "domcontentloaded" });
const geo = await page.evaluate(
  async (url, headers) => {
    const mod = await import("/scripts/browser/audit-colocacion-payload.ts");
    return mod.auditarColocacion(url, headers);
  },
  `${FN}?action=download&fileId=${FILE}`,
  { apikey: K, Authorization: `Bearer ${K}` }
);

// Trazos individuales con su bbox, para elegir uno chico y preciso dentro de
// una imagen. auditarColocacion no devuelve trazos individuales, asi que se
// recalculan aca con el mismo modulo del parser.
const trazos = await page.evaluate(
  async (url, headers) => {
    const { openConceptsRemote } = await import("/src/VisorConcept/parser.ts");
    const archivo = await openConceptsRemote(url, headers);
    const doc = await archivo.parse();
    const lista = [];
    for (const l of doc.layers) {
      for (const s of l.strokes) {
        lista.push({
          area: (s.bbox.maxX - s.bbox.minX) * (s.bbox.maxY - s.bbox.minY),
          cx: (s.bbox.minX + s.bbox.maxX) / 2,
          cy: (s.bbox.minY + s.bbox.maxY) / 2,
          bbox: s.bbox,
        });
      }
    }
    doc.close();
    archivo.close();
    return lista;
  },
  `${FN}?action=download&fileId=${FILE}`,
  { apikey: K, Authorization: `Bearer ${K}` }
);

const img = geo.colocaciones[0];
const dentro = trazos
  .filter((t) => t.cx >= img.x0 && t.cx <= img.x1 && t.cy >= img.y0 && t.cy <= img.y1)
  .sort((a, b) => a.area - b.area);
console.log(`trazos dentro de la primera imagen: ${dentro.length}/${trazos.length}`);
if (!dentro.length) {
  console.log("Ninguno cae dentro: eligiendo el mas cercano igual.");
}
const elegidos = (dentro.length ? dentro : trazos).slice(0, 3);

// 2) Ahora si, abrir el visor real y navegar a esos trazos.
await page.goto(`${BASE}/?tier=alta&file=${FILE}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

let i = 0;
for (const t of elegidos) {
  await page.evaluate(
    (cx, cy, anchoObjetivo) => {
      const canvas = document.querySelector("canvas");
      const zoom = Math.min(canvas.clientWidth, canvas.clientHeight) / anchoObjetivo;
      window.__viewerFijarVista({
        zoom,
        panX: canvas.clientWidth / 2 - cx * zoom,
        panY: canvas.clientHeight / 2 - cy * zoom,
      });
    },
    t.cx,
    t.cy,
    80
  );
  await new Promise((r) => setTimeout(r, 4000));
  const salida = path.join(OUT, `trazo-${i}.png`);
  await page.screenshot({ path: salida });
  console.log(`trazo ${i}: area=${t.bbox ? ((t.bbox.maxX - t.bbox.minX) * (t.bbox.maxY - t.bbox.minY)).toFixed(0) : "?"} cx=${t.cx.toFixed(1)} cy=${t.cy.toFixed(1)} -> ${salida}`);
  i++;
}

await browser.close();
