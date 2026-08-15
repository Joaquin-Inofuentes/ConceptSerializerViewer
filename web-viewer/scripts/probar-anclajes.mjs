import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const OUT = path.resolve(".cache/comparacion");
await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.resolve(".cache/concepts/manifest.json"), "utf8"));
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
for (const id of process.argv.slice(2)) {
  const f = manifest.files.find(x => x.id === id);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", e => console.error(" [err]", e.message.slice(0,160)));
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(async (url) => {
      const mod = await import("/scripts/browser/anclaje-payload.ts");
      return mod.probarAnclajes(url, 1000);
    }, `http://127.0.0.1:8788/${encodeURIComponent(id)}.concepts`);
    if (r.error) { console.log(`${f.name}: ${r.error}`); }
    else {
      console.log(`\n${f.name}`);
      const orden = [...r.variantes].sort((a,b)=>b.tinta-a.tinta);
      for (const v of r.variantes)
        console.log(`   ${v.nombre.padEnd(20)} zona=${v.zonaCorr}  TINTA=${v.tinta}${v===orden[0]&&v.tinta>0?"   <== MEJOR":""}`);
      const b = f.name.replace(/[^\w-]+/g,"_").slice(0,24);
      await writeFile(path.join(OUT, `ANC-${b}-THUMB.png`), Buffer.from(r.thumbPng.split(",")[1],"base64"));
      for (const v of r.variantes)
        await writeFile(path.join(OUT, `ANC-${b}-a${v.alfa}-b${v.beta}.png`), Buffer.from(v.recorte.split(",")[1],"base64"));
    }
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
