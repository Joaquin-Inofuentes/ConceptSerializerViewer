// Mide TODO el corpus local de .concepts: tiempo de parseo, trazos, puntos,
// recursos embebidos y su peso. Responde "donde esta el costo" sobre datos
// reales en vez de sobre un archivo suelto.
//
//   node scripts/stats-corpus.mjs        (requiere dev server en :5173)

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";
const FILE_PORT = 8790;

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const files = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size);

const fileServer = createServer(async (req, res) => {
  const id = decodeURIComponent((req.url || "").replace(/^\//, ""));
  const entry = manifest.files.find((f) => f.id === id);
  if (!entry?.localPath) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    return res.end();
  }
  const buf = await readFile(entry.localPath);
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/octet-stream",
    "Content-Length": buf.length,
  });
  res.end(buf);
});
await new Promise((r) => fileServer.listen(FILE_PORT, r));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page error]", e.message));
await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });

const out = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  try {
    const r = await page.evaluate(async (id, port) => {
      const mod = await import("/scripts/browser/stats-payload.ts");
      return mod.medir(`http://localhost:${port}/${encodeURIComponent(id)}`);
    }, f.id, FILE_PORT);
    out.push({ id: f.id, name: f.name, folderPath: f.folderPath, MB: +(f.size / 1048576).toFixed(2), ...r });
    console.log(
      `[${i + 1}/${files.length}] ${(f.size / 1048576).toFixed(1)}MB ${f.name} -> parse ${r.tParse}ms, ${r.strokes} trazos/${r.points} pts, ${r.recursos} recursos (${r.MBrecursos}MB)`
    );
  } catch (e) {
    out.push({ id: f.id, name: f.name, MB: +(f.size / 1048576).toFixed(2), error: String(e).slice(0, 160) });
    console.error(`[${i + 1}/${files.length}] ${f.name} -> ERROR ${String(e).slice(0, 120)}`);
  }
  if ((i + 1) % 15 === 0) await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
}

await writeFile(path.join(CACHE_DIR, "stats-corpus.json"), JSON.stringify(out, null, 2));
await browser.close();
fileServer.close();

const ok = out.filter((s) => !s.error);
const top = (campo, n = 8) =>
  [...ok].sort((a, b) => b[campo] - a[campo]).slice(0, n)
    .map((s) => `    ${s[campo]} — ${s.name} (${s.MB}MB)`).join("\n");
console.log(`\n== ${ok.length} archivos medidos, ${out.length - ok.length} con error`);
console.log(`  puntos totales max:\n${top("points")}`);
console.log(`  parse ms max:\n${top("tParse")}`);
console.log(`  recursos max:\n${top("recursos")}`);
console.log(`  MB de recursos max:\n${top("MBrecursos")}`);
