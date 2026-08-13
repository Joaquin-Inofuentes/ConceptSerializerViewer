// Genera las miniaturas de todos los .concepts bajados por crawl-drive.mjs y
// las sube a Supabase (tabla concept_thumbnails), usando el MISMO codigo que
// la app (src/VisorConcept/parser.ts + src/Gallery/thumbnail.ts) dentro de un
// Chrome headless — asi la miniatura cacheada es identica a la que generaria
// el navegador del usuario.
//
// De paso mide, por archivo: tiempo de parseo, cantidad de trazos/puntos/
// imagenes y tiempo de render. Ese perfil queda en .cache/concepts/stats.json
// y es lo que se usa para decidir que optimizar.
//
// Requisitos: el dev server de Vite tiene que estar corriendo en :5173
// (sirve los .ts transpilados en vivo, que es lo que importa la pagina).
//
//   node scripts/gen-thumbnails.mjs [--no-upload] [--only <driveFileId>]

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer";

const SUPABASE_URL = "https://kuhcxzusnrttkywgalgk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const CACHE_DIR = path.resolve(".cache/concepts");
const DEV_URL = "http://localhost:5173/";
const FILE_PORT = 8788;
const THUMBNAIL_SIZE = 192; // igual que src/config.ts

const noUpload = process.argv.includes("--no-upload");
const onlyIdx = process.argv.indexOf("--only");
const onlyId = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
let files = manifest.files.filter((f) => f.size && f.localPath);
if (onlyId) files = files.filter((f) => f.id === onlyId);
files.sort((a, b) => b.size - a.size); // los pesados primero: fallan antes si algo rompe

// Servidor local de bytes: pasar 20 MB por CDP con page.evaluate es lentisimo,
// asi que la pagina se los baja por HTTP desde aca.
const fileServer = createServer(async (req, res) => {
  const id = decodeURIComponent((req.url || "").replace(/^\//, ""));
  const entry = manifest.files.find((f) => f.id === id);
  if (!entry?.localPath) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    return res.end("no encontrado");
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

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=8192"],
  // Sin esto, un archivo que se cuelga deja el proceso esperando para
  // siempre (y con el, el puerto tomado).
  protocolTimeout: 240000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  [page error]", e.message));
await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });

// Carga los modulos reales de la app una sola vez y los deja en window.
const cargarModulos = async () => {
  await page.evaluate(async () => {
    const parser = await import("/src/VisorConcept/parser.ts");
    const thumb = await import("/src/Gallery/thumbnail.ts");
    window.__cs = {
      parseConceptsFile: parser.parseConceptsFile,
      renderThumbnailDataUrl: thumb.renderThumbnailDataUrl,
      thumbnailFromEmbedded: thumb.thumbnailFromEmbedded,
    };
  });
};
await cargarModulos();

const stats = [];
let subidas = 0;
let fallos = 0;

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const etiqueta = `[${i + 1}/${files.length}] ${f.name} (${(f.size / 1048576).toFixed(2)} MB)`;
  try {
    const r = await page.evaluate(async (id, port) => {
      const t0 = performance.now();
      const res = await fetch(`http://localhost:${port}/${encodeURIComponent(id)}`);
      const buf = await res.arrayBuffer();
      const tFetch = performance.now() - t0;

      // Camino rapido: la vista previa que Concepts guarda en el archivo.
      const t1 = performance.now();
      let thumbnail = await window.__cs.thumbnailFromEmbedded(buf);
      const tEmbedded = performance.now() - t1;
      if (thumbnail) {
        return {
          thumbnail,
          fuente: "embebida",
          tFetch: Math.round(tFetch),
          tParse: 0,
          tRender: Math.round(tEmbedded),
        };
      }

      const t2 = performance.now();
      const doc = await window.__cs.parseConceptsFile(buf);
      const tParse = performance.now() - t2;

      let strokes = 0;
      let points = 0;
      let images = 0;
      for (const layer of doc.layers) {
        strokes += layer.strokes.length;
        images += layer.images.length;
        for (const s of layer.strokes) points += s.points.length;
      }

      const t3 = performance.now();
      thumbnail = await window.__cs.renderThumbnailDataUrl(doc);
      const tRender = performance.now() - t3;

      return {
        thumbnail,
        fuente: "redibujada",
        tFetch: Math.round(tFetch),
        tParse: Math.round(tParse),
        tRender: Math.round(tRender),
        layers: doc.layers.length,
        strokes,
        points,
        images,
        resources: Object.keys(doc.resources).length,
      };
    }, f.id, FILE_PORT);

    stats.push({ id: f.id, name: f.name, folderPath: f.folderPath, size: f.size, ...r, thumbnail: undefined });
    console.log(
      `${etiqueta}\n    ${r.fuente} | fetch ${r.tFetch}ms | parse ${r.tParse}ms | render ${r.tRender}ms` +
        (r.fuente === "redibujada" ? ` | ${r.strokes} trazos, ${r.points} pts, ${r.resources} recursos` : "")
    );

    if (!noUpload) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/concept_thumbnails`, {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          drive_file_id: f.id,
          file_name: f.name,
          thumbnail_base64: r.thumbnail,
          source_size_bytes: f.size,
          width: THUMBNAIL_SIZE,
          height: THUMBNAIL_SIZE,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
      subidas++;
    }
  } catch (e) {
    fallos++;
    console.error(`${etiqueta}\n    ! ${e.message}`);
    stats.push({ id: f.id, name: f.name, folderPath: f.folderPath, size: f.size, error: e.message });
  }

  // El parseo deja documentos enormes vivos; recargar cada tanto evita que
  // Chrome se quede sin heap procesando 170 archivos seguidos. Tambien se
  // recarga despues de un archivo grande, que es donde se acumula.
  if ((i + 1) % 8 === 0 || f.size > 60 * 1048576) {
    // Recargar puede fallar si la pagina quedo ocupada con un archivo enorme;
    // no vale la pena abortar todo el lote por eso.
    try {
      await page.goto(DEV_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
      await cargarModulos();
    } catch (e) {
      console.warn(`  (no se pudo recargar la pagina: ${String(e).slice(0, 120)})`);
    }
  }
}

await writeFile(path.join(CACHE_DIR, "stats.json"), JSON.stringify(stats, null, 2));
await browser.close();
fileServer.close();

const ok = stats.filter((s) => !s.error);
const embebidas = ok.filter((s) => s.fuente === "embebida").length;
console.log(`\n== ${subidas} miniaturas subidas, ${fallos} fallos`);
console.log(`   ${embebidas} desde la vista previa del archivo, ${ok.length - embebidas} redibujadas`);
const lentos = [...ok].sort((a, b) => b.tRender - a.tRender).slice(0, 8);
console.log("\nTop 8 mas lentos:");
lentos.forEach((s, i) =>
  console.log(`  ${i + 1}. ${s.tRender}ms (${s.fuente}) — ${s.name} (${(s.size / 1048576).toFixed(1)} MB)`)
);
const fallidos = stats.filter((s) => s.error);
if (fallidos.length) {
  console.log("\nFallaron:");
  fallidos.forEach((s) => console.log(`  - ${s.name}: ${s.error.slice(0, 160)}`));
}
