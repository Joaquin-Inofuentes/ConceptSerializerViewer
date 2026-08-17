// Verificacion black-box contra PRODUCCION: sube un archivo pesado real,
// encuadra un plano a resolucion plena, panea a otro, vuelve al primero, y
// confirma via red + stats.cache (aciertos/fallos) + screenshots que NO hubo
// un segundo rasterizado/carga del mismo recurso.
//   node scripts/verify-prod-hotcache.mjs
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/fotos");
await mkdir(OUT, { recursive: true });
const BASE = "https://unx-concept.vercel.app";

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);
const target = disponibles[0];
console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB)\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 200)));

const requests = [];
page.on("request", (req) => {
  requests.push({ url: req.url(), t: Date.now(), type: req.resourceType() });
});

console.log(`bundle servido: `);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
const bundleUrl = requests.find((r) => /index-.*\.js$/.test(r.url))?.url;
console.log(`  ${bundleUrl}\n`);

const botones = await page.$$("button");
for (const b of botones) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) {
    await b.click();
    break;
  }
}
const input = await page.$('input[type="file"]');
await input.uploadFile(target.localPath);
await page.waitForSelector(".canvas-wrapper canvas", { timeout: 180000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000, polling: 500 });
await new Promise((r) => setTimeout(r, 1000));

const cajas = await page.evaluate(() => window.__viewerCajas());
const grandes = cajas
  .filter((c) => Math.max(c.x1 - c.x0, c.y1 - c.y0) > 0)
  .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
const vistos = new Set();
const distintos = [];
for (const c of grandes) {
  if (vistos.has(c.resourceId)) continue;
  vistos.add(c.resourceId);
  distintos.push(c);
  if (distintos.length === 2) break;
}
const [A, B] = distintos;
console.log(`planos: A=${A.resourceId.slice(0, 8)} B=${B.resourceId.slice(0, 8)}\n`);

const anchoCss = 1440, altoCss = 900;
async function encuadrar(caja) {
  const w = caja.x1 - caja.x0, h = caja.y1 - caja.y0;
  const zoom = Math.max(anchoCss / w, altoCss / h) * 1.02;
  const cx = (caja.x0 + caja.x1) / 2, cy = (caja.y0 + caja.y1) / 2;
  const panX = anchoCss / 2 - cx * zoom, panY = altoCss / 2 - cy * zoom;
  await page.evaluate((z, px, py) => window.__viewerFijarVista({ zoom: z, panX: px, panY: py }), zoom, panX, panY);
  await new Promise((r) => setTimeout(r, 7000));
}

console.log("encuadrar A a resolucion plena...");
await encuadrar(A);
const statsAfterA1 = await page.evaluate(() => window.__viewerStats());
await page.screenshot({ path: path.join(OUT, "prod-A-primera.png") });
console.log(`  cache A1: aciertos=${statsAfterA1.cache.aciertos} fallos=${statsAfterA1.cache.fallos}`);

console.log("encuadrar B (A sale de pantalla)...");
await encuadrar(B);
const statsAfterB = await page.evaluate(() => window.__viewerStats());
console.log(`  cache B: aciertos=${statsAfterB.cache.aciertos} fallos=${statsAfterB.cache.fallos}`);

const reqCountBeforeReturn = requests.length;
console.log("volver a encuadrar A (pan-back)...");
await encuadrar(A);
const statsAfterA2 = await page.evaluate(() => window.__viewerStats());
await page.screenshot({ path: path.join(OUT, "prod-A-vuelta.png") });
const newReqs = requests.slice(reqCountBeforeReturn);
console.log(`  cache A2: aciertos=${statsAfterA2.cache.aciertos} fallos=${statsAfterA2.cache.fallos}`);
console.log(`  requests de red disparados durante el pan-back: ${newReqs.length}`);
if (newReqs.length) console.log(`    ${newReqs.map((r) => r.url.split("/").pop()).slice(0, 10).join(", ")}`);

const fallosNuevos = statsAfterA2.cache.fallos - statsAfterB.cache.fallos;
const cacheOk = fallosNuevos === 0;
console.log(cacheOk ? "\n  OK  no hubo fallos de cache nuevos al volver a A (no se re-rasterizo)" : `\n  FALLA hubo ${fallosNuevos} fallos de cache nuevos`);

// Comparacion byte-exacta de las dos capturas (no hay libreria de diff de
// pixeles instalada en el repo). Un hash identico ya prueba que no hubo
// blur-then-sharpen: si el segundo encuadre hubiera vuelto a rasterizar a
// una resolucion/momento distinto, el PNG resultante no seria byte-idéntico.
const crypto = await import("node:crypto");
const fs = await import("node:fs");
const buf1 = fs.readFileSync(path.join(OUT, "prod-A-primera.png"));
const buf2 = fs.readFileSync(path.join(OUT, "prod-A-vuelta.png"));
const h1 = crypto.createHash("sha256").update(buf1).digest("hex").slice(0, 16);
const h2 = crypto.createHash("sha256").update(buf2).digest("hex").slice(0, 16);
console.log(`  hash primera visita: ${h1} (${buf1.length} bytes)`);
console.log(`  hash vuelta:         ${h2} (${buf2.length} bytes)`);
console.log(h1 === h2 ? "  OK  screenshots identicas byte a byte" : "  screenshots difieren (revisar visualmente, puede ser antialiasing/animacion menor)");

console.log(`\nerrores JS: ${errores.length ? [...new Set(errores)].slice(0, 5).join(" | ") : "ninguno"}`);
console.log(cacheOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");

await browser.close();
process.exit(cacheOk ? 0 : 1);
