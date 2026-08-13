// Benchmark "gama baja": corre el pipeline real del visor con CPU throttling
// (por defecto 6x, ~J7 Neo / TCL 30 SE) y viewport de telefono, sobre los
// .concepts cacheados en .cache/concepts. Requiere el dev server en 5173.
//
//   node scripts/bench-lowend.mjs --top 3          (los N mas pesados)
//   node scripts/bench-lowend.mjs <id> [<id> ...]
//   THROTTLE=8 node scripts/bench-lowend.mjs --top 3

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";
const FILE_PORT = 8792;
const THROTTLE = Number(process.env.THROTTLE || 6);

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);

let objetivos;
if (process.argv[2] === "--top") {
  objetivos = disponibles.slice(0, Number(process.argv[3] || 3));
} else if (process.argv[2] === "--mix") {
  // El mas pesado, uno intermedio pesado en recursos y uno mediano tipico.
  const porNombre = (s) => disponibles.find((f) => f.name.includes(s));
  objetivos = [disponibles[0], porNombre("Sanitaria") || disponibles[5], disponibles[Math.floor(disponibles.length / 2)]].filter(Boolean);
} else {
  const ids = process.argv.slice(2);
  objetivos = ids.map((id) => disponibles.find((f) => f.id === id)).filter(Boolean);
}
if (objetivos.length === 0) throw new Error("no hay archivos para medir");

const cacheBytes = new Map();
const fileServer = createServer(async (req, res) => {
  const id = decodeURIComponent((req.url || "").replace(/^\//, ""));
  const entry = manifest.files.find((f) => f.id === id);
  if (!entry?.localPath) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    return res.end();
  }
  try {
    let buf = cacheBytes.get(entry.localPath);
    if (!buf) {
      buf = await readFile(entry.localPath);
      cacheBytes.set(entry.localPath, buf);
    }
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/octet-stream",
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (e) {
    console.error("  [file server]", String(e).slice(0, 200));
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end();
  }
});
fileServer.on("clientError", (e) => console.error("  [file server clientError]", e.message));
fileServer.requestTimeout = 0;
fileServer.headersTimeout = 0;
await new Promise((r) => fileServer.listen(FILE_PORT, r));

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192"],
});

console.log(`CPU throttling: ${THROTTLE}x — viewport 360x700 @ DPR2`);
const resultados = [];
for (const f of objetivos) {
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("  [page error]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  [console]", m.text().slice(0, 200));
  });
  await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
  await page.emulateCPUThrottling(THROTTLE);
  console.log(`\n== ${f.name} (${(f.size / 1048576).toFixed(1)} MB) — ${f.folderPath}`);
  try {
    const r = await page.evaluate(async (id, port) => {
      const mod = await import("/scripts/browser/lowend-payload.ts");
      return mod.medirGamaBaja(`http://localhost:${port}/${encodeURIComponent(id)}`);
    }, f.id, FILE_PORT);
    resultados.push({ id: f.id, name: f.name, MB: +(f.size / 1048576).toFixed(1), throttle: THROTTLE, ...r });
    console.log(
      `   parse ${r.tiempos.parse}ms | plan ${r.tiempos.planDeDibujo}ms | recursos ${r.tiempos.recursos}ms (1a foto +${r.msHastaPrimeraFoto - r.msHastaVerTrazos}ms)`
    );
    console.log(
      `   -> trazos ${r.msHastaVerTrazos}ms | todo ${r.totalHastaVerDibujo}ms | frame ${r.frameMedianaMs}ms (peor ${r.framePeorMs}ms) | previewsMenu ${r.msPreviewsMenu}ms`
    );
    console.log(
      `   heap PICO ${r.heapPeakMB}MB | imagenes ${r.ramImagenesMB}MB (${r.MpxImagenes}Mpx, ${r.recursosRasterizados} recursos)`
    );
    const z = r.zipStats;
    console.log(
      `   zip: total ${z.totalMB}MB | tree.pack ${z.treePackMB}MB (offset ${z.treeOffsetMB}MB) + thumb ${z.thumbKB}KB | recursos usados ${z.recursosUsadosMB}MB | NECESARIO ${z.necesarioTotalMB}MB (${((z.necesarioTotalMB / z.totalMB) * 100).toFixed(0)}%)`
    );
  } catch (e) {
    console.error(`   ERROR: ${String(e).slice(0, 300)}`);
    resultados.push({ id: f.id, name: f.name, MB: +(f.size / 1048576).toFixed(1), throttle: THROTTLE, error: String(e).slice(0, 300) });
  }
  await page.close();
}

await writeFile(path.join(CACHE_DIR, "bench-lowend.json"), JSON.stringify(resultados, null, 2));
await browser.close();
fileServer.close();
console.log("\nGuardado en .cache/concepts/bench-lowend.json");
