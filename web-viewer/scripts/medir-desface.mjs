import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/comparacion");
const BASE = "http://localhost:5173";
const ORIGEN = "http://127.0.0.1:8788";
await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const filas = [];
for (const id of process.argv.slice(2)) {
  const f = manifest.files.find(x => x.id === id);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", e => console.error(" [err]", e.message.slice(0,160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(async (url) => {
      const mod = await import("/scripts/browser/medir-desface-payload.ts");
      return mod.medirDesface(url, 1100);
    }, `${ORIGEN}/${encodeURIComponent(id)}.concepts`);
    if (r.error) console.log(`${f.name}: ${r.error}`);
    else {
      console.log(`${f.name}`);
      console.log(`   zona thumb: corr=${r.zona.corr} girado=${r.zona.girado}`);
      console.log(`   DESFACE trazos vs imagenes = (${r.desface.x}, ${r.desface.y}) unidades doc`);
      console.log(`   correlacion: sin corregir ${r.corrSinCorregir} -> corregido ${r.corrCorregido}`);
      const b = f.name.replace(/[^\w-]+/g,"_").slice(0,26);
      await writeFile(path.join(OUT, `D-${b}-1-THUMB.png`), Buffer.from(r.thumbPng.split(",")[1],"base64"));
      await writeFile(path.join(OUT, `D-${b}-2-ACTUAL.png`), Buffer.from(r.recorteSinCorregir.split(",")[1],"base64"));
      await writeFile(path.join(OUT, `D-${b}-3-CORREGIDO.png`), Buffer.from(r.recorteCorregido.split(",")[1],"base64"));
      filas.push({ archivo: f.name, id, desface: r.desface, corrSinCorregir: r.corrSinCorregir, corrCorregido: r.corrCorregido, zonaCorr: r.zona.corr });
    }
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
await writeFile(path.join(OUT, "desface.json"), JSON.stringify(filas, null, 2));
