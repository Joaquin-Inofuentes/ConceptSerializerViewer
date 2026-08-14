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
const objetivos = stats
  .filter((x) => x.strokes > 0 && x.images > 0)
  .sort((a, b) => a.MB - b.MB)
  .slice(0, Number(process.env.N || 10));

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
      `${f.name.padEnd(35)} img=${r.imagenes} trz=${r.trazos} identInterno=${r.internoIdentidad} identB=${r.matrixBIdentidad} | overlap: interno=${r.overlap.soloInterno}% matrixB=${r.overlap.soloMatrixB}% int∘B=${r.overlap.compuestaIntMB}% B∘int=${r.overlap.compuestaMBInt}%`
    );
  } catch (e) {
    console.error(`  FALLO ${f.name}: ${String(e).slice(0, 200)}`);
  }
  await page.close();
}
await browser.close();
