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
      const fotos = r.filas.filter(x => !x.esPdf);
      const rotadas = fotos.filter(x => x.orientacion >= 5 && x.orientacion <= 8);
      const peligro = rotadas.filter(x => x.deformacion !== null && x.deformacion < 1.05);
      const malas = r.filas.filter(x => x.deformacion !== null && x.deformacion > 1.01);
      console.log(`  ${r.filas.length} colocaciones · ${fotos.length} fotos · ${rotadas.length} con EXIF 5-8 · ${malas.length} deformadas`);
      console.log(`  RIESGO (EXIF 5-8 pero NO deformadas, el fix las rompería): ${peligro.length}`);
      for (const x of malas.slice(0,6)) {
        const ce = x.conExif ? `${x.conExif.w}x${x.conExif.h}` : "-";
        const factorExif = x.conExif ? `${(x.declarado.w/x.conExif.w).toFixed(4)} / ${(x.declarado.h/x.conExif.h).toFixed(4)}` : "-";
        console.log(`    ${x.resourceId} ${x.esPdf?"PDF":"img"} declarado ${x.declarado.w}x${x.declarado.h} vs nativo ${x.nativo.w}x${x.nativo.h} -> deformacion ${x.deformacion}`);
        console.log(`        con EXIF aplicado: ${ce}   factor entonces: ${factorExif}`);
      }
    }
  } catch(e) { console.error("FALLO", String(e).slice(0,300)); }
  await page.close();
}
await browser.close();
