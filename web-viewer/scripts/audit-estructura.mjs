// ¿Por que un .concepts con recursos pesados no muestra ninguna imagen?
// Compara lo que hay en el zip contra lo que el parser encuentra en el arbol.
//
//   node scripts/audit-estructura.mjs <driveFileId> [<driveFileId> ...]

import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error("Solo corre contra el dev server (importa modulos .ts sueltos).");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("uso: node scripts/audit-estructura.mjs <driveFileId> [...]");
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

for (const id of ids) {
  const f = manifest.files.find((x) => x.id === id) || { name: id, size: 0 };
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  console.log(`\n${"=".repeat(78)}\n${f.name} (${(f.size / 1048576).toFixed(2)} MB)\n${"=".repeat(78)}`);
  try {
    const r = await page.evaluate(
      async (url, headers) => {
        const mod = await import("/scripts/browser/audit-estructura-payload.ts");
        return mod.auditarEstructura(url, headers);
      },
      `${FN}?action=download&fileId=${id}`,
      { apikey: K, Authorization: `Bearer ${K}` }
    );
    if (r.error) {
      console.log("  ", r.error);
    } else {
      console.log(
        `  ZIP: ${r.zip.entradas} entradas | ${r.zip.recursosPesados} recursos pesados (${r.zip.MBrecursos} MB)`
      );
      r.zip.muestraNombres.forEach((n) => console.log(`       ${n}`));
      console.log(
        `  ARBOL: profundidad ${r.arbol.profundidadMax} | ${r.arbol.uuids} uuids | ${r.arbol.matrices16} matrices de 16`
      );
      console.log(`  tipos: ${r.arbol.tiposMasComunes.map(([t, n]) => `${t}x${n}`).join("  ")}`);
      r.arbol.ejemplosMatriz.forEach((m, i) => console.log(`       matriz ${i}: [${m.join(", ")}]`));
      console.log(`  uuids: ${(r.arbol.uuidsMuestra || []).join(", ") || "(ninguno)"}`);
      (r.arbol.ejemplos || []).forEach((e) => console.log(`    ${e}`));
      console.log(
        `  PARSER ve: ${r.parser.capas} capas, ${r.parser.imagenes} imagenes, ${r.parser.recursoIds} recursos`
      );
      console.log(`  por capa: ${r.porCapa.map((c) => `#${c.capa}(${c.trazos}t/${c.imagenes}i)`).join(" ")}`);
    }
  } catch (e) {
    console.error(`  FALLO: ${String(e).slice(0, 400)}`);
  }
  await page.close();
}

await browser.close();
