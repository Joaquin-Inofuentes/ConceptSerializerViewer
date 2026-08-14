// ¿Las imagenes estan colocadas donde corresponde, o hay dibujos "flotando"?
//
//   node scripts/audit-colocacion.mjs                (los N mas pesados)
//   node scripts/audit-colocacion.mjs <driveFileId>
//   TOP=5 node scripts/audit-colocacion.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const TOP = Number(process.env.TOP || 3);

if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error("Solo corre contra el dev server (importa modulos .ts sueltos).");
  process.exit(1);
}

const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = process.argv[2]
  ? [manifest.files.find((f) => f.id === process.argv[2])].filter(Boolean)
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const salida = [];

for (const f of objetivos) {
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  console.log(`\n${"=".repeat(78)}\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n${"=".repeat(78)}`);
  try {
    const r = await page.evaluate(
      async (url, headers) => {
        const mod = await import("/scripts/browser/audit-colocacion-payload.ts");
        return mod.auditarColocacion(url, headers);
      },
      `${FN}?action=download&fileId=${f.id}`,
      { apikey: K, Authorization: `Bearer ${K}` }
    );
    salida.push({ archivo: f.name, id: f.id, ...r });

    console.log(
      `  ${r.capas} capas | ${r.trazos} trazos | ${r.imagenes} colocaciones | ${r.recursos} recursos | necesita ${r.bytesNecesariosMB} MB de ${r.totalMB}`
    );
    console.log(
      `  bbox trazos: ${r.bboxTrazos ? `${r.bboxTrazos.x0},${r.bboxTrazos.y0} .. ${r.bboxTrazos.x1},${r.bboxTrazos.y1}` : "sin trazos"}`
    );
    console.log(
      `  trazos sobre alguna imagen: ${r.trazosSobreImagen}/${r.trazos} (${r.pctTrazosSobreImagen}%)  <- 'flotando' = el resto`
    );

    const c = r.colocaciones;
    const dupes = c.filter((x) => x.duplicadaDe).length;
    const lejos = c.filter((x) => x.distanciaATrazos > 0).length;
    const degeneradas = c.filter((x) => !(x.ancho > 1) || !(x.alto > 1)).length;
    const areas = c.map((x) => x.area).sort((a, b) => a - b);
    const rotaciones = [...new Set(c.map((x) => x.rotacion))].sort((a, b) => a - b);
    console.log(
      `  duplicadas en el mismo lugar: ${dupes} | fuera del bloque de trazos: ${lejos} | degeneradas: ${degeneradas}`
    );
    console.log(
      `  area (unid^2): min ${areas[0]} | mediana ${areas[Math.floor(areas.length / 2)]} | max ${areas[areas.length - 1]}`
    );
    console.log(`  rotaciones distintas: ${rotaciones.join(", ")}`);
    console.log(`  primeras 8 colocaciones:`);
    c.slice(0, 8).forEach((x) =>
      console.log(
        `    ${x.resourceId.slice(0, 8)} capa${x.capa} caja ${x.ancho}x${x.alto} en ${x.x0},${x.y0} esc ${x.escalaX}x${x.escalaY} rot ${x.rotacion} dist ${x.distanciaATrazos}${x.duplicadaDe ? ` DUP(${x.duplicadaDe})` : ""}`
      )
    );
  } catch (e) {
    console.error(`  FALLO: ${String(e).slice(0, 500)}`);
  }
  await page.close();
}

await mkdir(CACHE_DIR, { recursive: true });
await writeFile(path.join(CACHE_DIR, "audit-colocacion.json"), JSON.stringify(salida, null, 2));
console.log(`\nGuardado en .cache/concepts/audit-colocacion.json`);
await browser.close();
