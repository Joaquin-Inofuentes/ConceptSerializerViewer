// ¿Los planos se ven estirados? Compara el tamaño que el parser cree que
// tiene cada imagen contra el REAL del archivo embebido.
//
//   node scripts/audit-imagenes.mjs                 (varios, empezando por los de 1 sola imagen)
//   node scripts/audit-imagenes.mjs <driveFileId>

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
let stats = [];
try {
  stats = JSON.parse(await readFile(path.join(CACHE_DIR, "stats-corpus.json"), "utf8"));
} catch {
  /* opcional */
}

let objetivos;
if (process.argv[2]) {
  objetivos = [manifest.files.find((f) => f.id === process.argv[2])].filter(Boolean);
} else {
  // Primero los que tienen UNA sola imagen: ahi cualquier deformacion se ve
  // sin ambiguedad. Despues el mas pesado, que es el que se reporto mal.
  const unaSola = stats.filter((x) => x.images === 1).sort((a, b) => a.MB - b.MB).slice(0, 3);
  const pesado = manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size)[0];
  objetivos = [...unaSola.map((s) => manifest.files.find((f) => f.id === s.id)), pesado].filter(Boolean);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

for (const f of objetivos) {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  console.log(`\n${"=".repeat(78)}\n${f.name} (${(f.size / 1048576).toFixed(2)} MB)\n${"=".repeat(78)}`);
  try {
    const r = await page.evaluate(
      async (url, headers) => {
        const mod = await import("/scripts/browser/audit-imagen-payload.ts");
        return mod.auditarImagenes(url, headers);
      },
      `${FN}?action=download&fileId=${f.id}`,
      { apikey: K, Authorization: `Bearer ${K}` }
    );
    console.log(`  trazos: ${r.trazos} | bbox ${r.bboxTrazos}`);
    for (const x of r.recursos) {
      if (x.error) {
        console.log(`  ${x.id}: ${x.error}`);
        continue;
      }
      const alerta = Math.abs(x.deformacion - 1) > 0.02 ? "  <<< DEFORMADO" : "";
      console.log(
        `  ${x.id} ${x.tipo}: declarado=${x.declarado} real=${x.real} | aspecto ${x.aspectoDeclarado} vs ${x.aspectoReal} | deformacion ${x.deformacion}${alerta}`
      );
      console.log(
        `      escala=${x.escala} rot=${x.rotacion}deg caja=${x.caja} en ${x.traslacion}` +
          (x.rotatePdf !== undefined
            ? ` | /Rotate=${x.rotatePdf} sinRotar=${x.real} rotado=${x.rotado}`
            : "")
      );
    }
  } catch (e) {
    console.error(`  FALLO: ${String(e).slice(0, 300)}`);
  }
  await page.close();
}

await browser.close();
