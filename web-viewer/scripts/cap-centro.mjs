// Prueba decisiva: agarra un trazo que HOY (esquina superior-izquierda) queda
// flotando sin ninguna foto debajo, y renderiza la foto real con las dos
// convenciones de origen (esquina vs centro) para ver cual la deja tapando
// el trazo de verdad. No es circular: el trazo se elige por estar FUERA de
// toda imagen segun la interpretacion actual.
//
//   node scripts/cap-centro.mjs <driveFileId>

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
if (!FILE) {
  console.error("Uso: node scripts/cap-centro.mjs <driveFileId>");
  process.exit(1);
}
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 250)));
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const r = await page.evaluate(
  async (url, headers) => {
    const mod = await import("/scripts/browser/centro-payload.ts");
    return mod.probarCentro(url, headers);
  },
  `${FN}?action=download&fileId=${FILE}`,
  { apikey: K, Authorization: `Bearer ${K}` }
);

if (r.error) {
  console.error("Error:", r.error);
  await browser.close();
  process.exit(1);
}

console.log("trazo:", JSON.stringify(r.trazo));
console.log("imagen:", JSON.stringify({ id: r.img.resourceId.slice(0, 8), w: r.img.width, h: r.img.height }));
console.log("caja esquina (actual):", JSON.stringify(r.cajaEsquina));
console.log("caja centro (hipotesis):", JSON.stringify(r.cajaCentro));

const b64toFile = async (dataUrl, fname) => {
  const base64 = dataUrl.split(",")[1];
  await writeFile(path.join(OUT, fname), Buffer.from(base64, "base64"));
};
await b64toFile(r.esquinaPng, "centro-A-esquina-actual.png");
await b64toFile(r.centroPng, "centro-B-centrado-hipotesis.png");
console.log("guardado: centro-A-esquina-actual.png (como esta HOY) / centro-B-centrado-hipotesis.png (hipotesis)");

await browser.close();
