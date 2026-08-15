import { readFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const man = JSON.parse(await readFile(path.resolve(".cache/concepts/manifest.json"), "utf8"));
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
for (const id of process.argv.slice(2)) {
  const f = man.files.find(x => x.id === id);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", e => console.error(" [err]", e.message.slice(0,200)));
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  try {
    const r = await page.evaluate(async (url) => {
      const mod = await import("/scripts/browser/auditar-escala-payload.ts");
      return mod.auditarEscala(url);
    }, `http://127.0.0.1:8788/${encodeURIComponent(id)}.concepts`);
    console.log(`\n${f.name}`);
    if (r.error) { console.log("  ", r.error); }
    else {
      const malas = r.filas.filter(x => x.deformacion !== null && x.deformacion > 1.01);
      console.log(`  ${r.filas.length} colocaciones, ${malas.length} DEFORMADAS`);
      for (const x of malas) {
        console.log(`    ${x.resourceId} pag=${x.pagina} ${x.esPdf?"PDF":"img"} declarado ${x.declarado.w}x${x.declarado.h} (asp ${x.aspectoDeclarado}) vs nativo ${x.nativo.w}x${x.nativo.h} (asp ${x.aspectoNativo}) -> deformacion ${x.deformacion}`);
      }
    }
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
