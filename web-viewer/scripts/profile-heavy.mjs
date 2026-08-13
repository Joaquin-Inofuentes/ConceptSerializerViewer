// Perfila EN DETALLE un .concepts pesado, reproduciendo lo que hace el visor
// al abrirlo: parseo y carga de cada recurso embebido (foto o PDF) con la
// MISMA formula de resolucion que usa Viewer.tsx. Reporta por recurso: tipo,
// bytes, tamaño nativo, tamaño realmente dibujado, escala pedida,
// megapixeles del canvas resultante y milisegundos.
//
// La logica de medicion vive en scripts/browser/profile-payload.ts (un modulo
// real servido por Vite, porque necesita import.meta.url para resolver el
// worker de pdf.js igual que la app). Requiere el dev server en :5173.
//
//   node scripts/profile-heavy.mjs <driveFileId>

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";
const FILE_PORT = 8789;

const fileId = process.argv[2];
if (!fileId) throw new Error("uso: node scripts/profile-heavy.mjs <driveFileId>");

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const entry = manifest.files.find((f) => f.id === fileId);
if (!entry?.localPath) throw new Error(`no hay copia local de ${fileId}`);

const bytes = await readFile(entry.localPath);
const fileServer = createServer((_req, res) => {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/octet-stream",
    "Content-Length": bytes.length,
  });
  res.end(bytes);
});
await new Promise((r) => fileServer.listen(FILE_PORT, r));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page error]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("[console]", m.text());
});
await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });

const result = await page
  .evaluate(async (port) => {
    const mod = await import("/scripts/browser/profile-payload.ts");
    return mod.perfilar("http://localhost:" + port + "/f");
  }, FILE_PORT)
  .catch((e) => ({ error: String(e) }));

console.log(`\n== ${entry.name} (${(entry.size / 1048576).toFixed(2)} MB) — ${entry.folderPath}\n`);
console.log(JSON.stringify(result, null, 2));
await writeFile(path.join(CACHE_DIR, `profile-${fileId}.json`), JSON.stringify({ entry, result }, null, 2));

await browser.close();
fileServer.close();
