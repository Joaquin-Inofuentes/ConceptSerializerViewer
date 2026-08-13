// Benchmark del visor sobre uno o varios .concepts locales, usando el codigo
// real de la app. Reporta cuanto tarda en verse el dibujo y cuanto cuesta un
// frame de pan/zoom.
//
//   node scripts/bench-viewer.mjs <driveFileId> [<driveFileId> ...]
//   node scripts/bench-viewer.mjs --top 5      (los N mas pesados)

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";
const FILE_PORT = 8791;

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);

let objetivos;
if (process.argv[2] === "--top") {
  objetivos = disponibles.slice(0, Number(process.argv[3] || 5));
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
    // Precargado: leer 275 MB de disco dentro del handler hacia que Chrome
    // cortara la conexion antes de recibir nada ("Failed to fetch").
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

const resultados = [];
for (const f of objetivos) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("  [page error]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  [console]", m.text().slice(0, 200));
  });
  await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
  console.log(`\n== ${f.name} (${(f.size / 1048576).toFixed(1)} MB) — ${f.folderPath}`);
  try {
    const r = await page.evaluate(async (id, port) => {
      const mod = await import("/scripts/browser/bench-payload.ts");
      return mod.medirVisor(`http://localhost:${port}/${encodeURIComponent(id)}`);
    }, f.id, FILE_PORT);
    resultados.push({ id: f.id, name: f.name, MB: +(f.size / 1048576).toFixed(1), ...r });
    console.log(
      `   descarga ${r.tiempos.descarga}ms | parse ${r.tiempos.parse}ms | plan ${r.tiempos.planDeDibujo}ms | recursos ${r.tiempos.recursos}ms`
    );
    console.log(
      `   -> trazos visibles a los ${r.msHastaVerTrazos}ms | 1a foto ${r.msHastaPrimeraFoto ?? "-"}ms | todo ${r.totalHastaVerDibujo}ms | frame ${r.frameMedianaMs}ms (peor ${r.framePeorMs}ms)`
    );
    console.log(
      `   ${r.strokes} trazos / ${r.points} pts / ${r.recursosRasterizados} recursos = ${r.MpxImagenes} Mpx (${r.ramImagenesMB} MB RAM), heap ${r.heapMB} MB`
    );
  } catch (e) {
    console.error(`   ERROR: ${String(e).slice(0, 300)}`);
    resultados.push({ id: f.id, name: f.name, MB: +(f.size / 1048576).toFixed(1), error: String(e).slice(0, 300) });
  }
  await page.close();
}

await writeFile(path.join(CACHE_DIR, "bench.json"), JSON.stringify(resultados, null, 2));
await browser.close();
fileServer.close();
