// ¿Nuestro render coincide con el que hace la propia app Concepts?
//
// Compara nuestro "zoom all" contra el thumb.jpg que el archivo trae adentro
// y deja las dos imagenes lado a lado en .cache/comparacion/ para mirarlas.
//
//   node scripts/comparar-thumb.mjs             (los TOP mas pesados)
//   node scripts/comparar-thumb.mjs <driveFileId>
//   TOP=5 SOLO_GRANDES=1 node scripts/comparar-thumb.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/comparacion");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const TOP = Number(process.env.TOP || 3);
const SOLO_GRANDES = process.env.SOLO_GRANDES === "1";

if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error("Solo corre contra el dev server (importa modulos .ts sueltos).");
  process.exit(1);
}

const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = process.argv[2]
  ? [manifest.files.find((f) => f.id === process.argv[2])].filter(Boolean)
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 900000,
});

const resumen = [];
for (const f of objetivos) {
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  console.log(`\n${"=".repeat(78)}\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n${"=".repeat(78)}`);
  const t0 = Date.now();
  try {
    const r = await page.evaluate(
      async (url, headers, soloGrandes) => {
        const mod = await import("/scripts/browser/comparar-thumb-payload.ts");
        return mod.compararConThumb(url, headers, { lado: 512, soloGrandes });
      },
      `${FN}?action=download&fileId=${f.id}`,
      { apikey: K, Authorization: `Bearer ${K}` },
      SOLO_GRANDES
    );
    if (r.error) {
      console.log(`  ${r.error}`);
    } else {
      const base = f.name.replace(/[^\w-]+/g, "_").slice(0, 40);
      await writeFile(path.join(OUT, `${base}-nuestro.png`), Buffer.from(r.render.split(",")[1], "base64"));
      await writeFile(path.join(OUT, `${base}-concepts.png`), Buffer.from(r.thumbPng.split(",")[1], "base64"));
      const { render, thumbPng, ...limpio } = r;
      resumen.push({ archivo: f.name, id: f.id, segundos: +((Date.now() - t0) / 1000).toFixed(1), ...limpio });
      console.log(`  trazos ${r.trazos} | imagenes ${r.imagenesDibujadas}/${r.imagenes} dibujadas`);
      console.log(`  encuadre ${r.encuadre.x0},${r.encuadre.y0} .. ${r.encuadre.x1},${r.encuadre.y1}`);
      console.log(`  aspecto: nuestro ${r.aspectoEncuadre} vs Concepts ${r.aspectoThumb} (thumb ${r.thumb})`);
      console.log(`  CORRELACION con el render de Concepts: ${r.correlacion}`);
      console.log(`     solo trazos:   ${r.correlacionSoloTrazos}`);
      console.log(`     solo imagenes: ${r.correlacionSoloImagenes}`);
      console.log(
        `  ${r.correlacion > 0.8 ? "OK   coincide" : r.correlacion > 0.5 ? "REGULAR  se parece pero hay diferencias" : "MAL  no se parece"}`
      );
      console.log(`  imagenes en ${path.join(OUT, base)}-{nuestro,concepts}.png (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  } catch (e) {
    console.error(`  FALLO: ${String(e).slice(0, 400)}`);
  }
  await page.close();
}

await writeFile(path.join(OUT, "resumen.json"), JSON.stringify(resumen, null, 2));
await browser.close();
