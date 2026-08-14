// Audita la geometria de los .concepts mas pesados: ¿las imagenes estan
// espejadas/rotadas? ¿los trazos caen encima de los planos o al lado?
//
//   node scripts/audit-geometria.mjs [--top N]

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = process.env.BASE_URL || "http://localhost:5173";
const TOP = Number(process.env.TOP || 3);

const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesados = manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

for (const f of pesados) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 150)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  console.log(`\n${"=".repeat(70)}\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n${"=".repeat(70)}`);
  try {
    const r = await page.evaluate(
      async (url, headers) => {
        const mod = await import("/scripts/browser/audit-payload.ts");
        return mod.auditar(url, headers);
      },
      `${FN}?action=download&fileId=${f.id}`,
      { apikey: K, Authorization: `Bearer ${K}` }
    );
    console.log(`  trazos: ${r.trazos} | bbox ${r.bboxTrazos}`);
    console.log(`  imagenes: ${r.total} | bbox ${r.bboxImagenes}`);
    console.log(`  solape imagenes/trazos: ${r.solapeConTrazosPct}%`);
    console.log(`  ESPEJADAS (determinante < 0): ${r.conDeterminanteNegativo}/${r.total}`);
    console.log(`  ROTADAS (> 0.5 grados):       ${r.conRotacion}/${r.total}`);
    console.log(`  detalle (primeras 6):`);
    r.imagenes.slice(0, 6).forEach((i) =>
      console.log(
        `    ${i.id} nat=${i.nativo} det=${i.determinante} escala=${i.escalaX}x${i.escalaY} rot=${i.rotacionGrados}deg signos=a${i.signos.a},b${i.signos.b},c${i.signos.c},d${i.signos.d} caja=${i.caja}`
      )
    );
  } catch (e) {
    console.error(`  FALLO: ${String(e).slice(0, 300)}`);
  }
  await page.close();
}

await browser.close();
