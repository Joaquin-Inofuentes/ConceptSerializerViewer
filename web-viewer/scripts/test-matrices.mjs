import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
let stats = JSON.parse(await readFile(path.join(CACHE_DIR, "stats-corpus.json"), "utf8"));
const conAmbos = stats.filter((x) => x.strokes > 0 && x.images > 0).sort((a, b) => a.MB - b.MB);
const N = Number(process.env.N || 10);
// IDS=id1,id2 corre solo esos archivos puntuales; sin eso, mitad y mitad:
// los mas chicos (donde aparecio el problema) Y los mas pesados (donde ya se
// confirmo visualmente que el render es correcto) — asi una hipotesis que
// "arregla" los chicos pero rompe los pesados se detecta en la misma corrida.
const objetivos = process.env.IDS
  ? process.env.IDS.split(",").map((id) => stats.find((x) => x.id === id)).filter(Boolean)
  : [...conAmbos.slice(0, Math.ceil(N / 2)), ...conAmbos.slice(-Math.floor(N / 2))];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });

for (const s of objetivos) {
  const f = manifest.files.find((x) => x.id === s.id);
  if (!f) continue;
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => console.error("  [error]", e.message.slice(0, 150)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(
      async (url, headers) => {
        const mod = await import("/scripts/browser/test-matrices-payload.ts");
        return mod.testMatrices(url, headers);
      },
      `${FN}?action=download&fileId=${f.id}`,
      { apikey: K, Authorization: `Bearer ${K}` }
    );
    console.log(
      `${f.name.padEnd(35)} ${s.MB}MB img=${r.imagenes}(t7=${r.tipo7},t8=${r.tipo8}) trz=${r.trazos} linealIdent=${r.linealIdentidad} | interno=${r.overlap.soloInterno}% linealIdentCentrado=${r.overlap.linealIdentCentrado}%`
    );
  } catch (e) {
    console.error(`  FALLO ${f.name}: ${String(e).slice(0, 200)}`);
  }
  await page.close();
}
await browser.close();
