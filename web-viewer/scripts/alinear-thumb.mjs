import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const man = JSON.parse(await readFile(path.resolve(".cache/concepts/manifest.json"), "utf8"));
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
for (const id of process.argv.slice(2)) {
  const f = man.files.find(x => x.id === id);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", e => console.error(" [err]", e.message.slice(0,160)));
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(async (url) => {
      const mod = await import("/scripts/browser/alinear-thumb-payload.ts");
      return mod.alinearConThumb(url, 1300);
    }, `http://127.0.0.1:8788/${encodeURIComponent(id)}.concepts`);
    console.log(`\n${f.name}  (thumb ${r.thumb})`);
    if (r.error) console.log("  ", r.error);
    else {
      console.log(`   imagen que muestra el thumb: #${r.mejorImagen.indice} corr=${r.mejorImagen.corr}`);
      console.log(`   ${r.comparacion}`);
      console.log(`   tinta segun THUMB   : ${JSON.stringify(r.tintaThumb)}`);
      console.log(`   tinta NUESTRA       : ${JSON.stringify(r.tintaNuestra)}`);
      console.log(`   DESFACE (mover nuestros trazos): ${JSON.stringify(r.desface)}`);
    }
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
