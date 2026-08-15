import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/comparacion");
const BASE = "http://localhost:5173";
const ORIGEN = "http://127.0.0.1:8788";
await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const ids = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
for (const id of ids) {
  const f = manifest.files.find(x => x.id === id);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", e => console.error(" [err]", e.message.slice(0,160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(async (url) => {
      const mod = await import("/scripts/browser/centrado-ab-payload.ts");
      return mod.compararCentrado(url, 700);
    }, `${ORIGEN}/${encodeURIComponent(id)}.concepts`);
    const base = f.name.replace(/[^\w-]+/g,"_").slice(0,32);
    await writeFile(path.join(OUT, `AB-${base}-ANTES.png`), Buffer.from(r.antes.split(",")[1],"base64"));
    await writeFile(path.join(OUT, `AB-${base}-DESPUES.png`), Buffer.from(r.despues.split(",")[1],"base64"));
    console.log(`${f.name}: imgs=${r.imagenes} (nuncaMovidas=${r.nuncaMovidas}) trazos=${r.trazos} | desborde: actual=${r.desborde.antes} reglaAcotada=${r.desborde.despues} centrarTodas=${r.desborde.centrarTodas}`);
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
