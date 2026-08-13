// Recorre TODO el arbol de la carpeta publica de Drive (via el edge function
// concepts-drive) y baja cada .concepts a disco. Deja un manifest.json con el
// arbol completo + tamaño de cada archivo, para despues generar thumbnails
// offline sin volver a pegarle a Drive.
//
//   node scripts/crawl-drive.mjs [carpetaDestino]
//
// Por defecto baja a ./.cache/concepts (gitignoreado).

import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SUPABASE_URL = "https://kuhcxzusnrttkywgalgk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
const ROOT_FOLDER = "1lAlcv9-g6HmWVKkYMcrQQWBD3ew15i5Q";

const OUT_DIR = path.resolve(process.argv[2] || ".cache/concepts");

const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drive corta con 429/403 (que el edge function reporta como 502) cuando se
// le piden muchos archivos seguidos, asi que el backoff es exponencial y
// largo: bajar 170 archivos de una sentada supera el limite si no se espera.
async function withRetry(fn, label, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const wait = 3000 * 2 ** i;
      console.warn(`  reintento ${i + 1}/${attempts} en ${wait / 1000}s (${label}): ${e.message}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function listFolder(folderId) {
  return withRetry(async () => {
    const res = await fetch(
      `${FUNCTIONS_URL}/concepts-drive?action=list&folderId=${encodeURIComponent(folderId)}`,
      { headers }
    );
    if (!res.ok) throw new Error(`list ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "list fallo");
    return { folders: data.folders || [], files: data.files || [] };
  }, `list ${folderId}`);
}

async function downloadFile(fileId) {
  return withRetry(async () => {
    const res = await fetch(
      `${FUNCTIONS_URL}/concepts-drive?action=download&fileId=${encodeURIComponent(fileId)}`,
      { headers }
    );
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Un .concepts es un zip: si no arranca con "PK" es la pagina de error de Drive.
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`respuesta no-zip (${buf.length} bytes)`);
    }
    return buf;
  }, `download ${fileId}`);
}

const manifest = { folders: [], files: [] };

async function crawl(folderId, folderName, breadcrumb) {
  const listing = await listFolder(folderId);
  console.log(`[carpeta] ${breadcrumb} -> ${listing.folders.length} subcarpetas, ${listing.files.length} archivos`);
  manifest.folders.push({
    folder_id: folderId,
    name: folderName,
    path: breadcrumb,
    subfolders: listing.folders,
    files: listing.files,
  });

  for (const f of listing.files) {
    // La carpeta tambien tiene PDFs sueltos; el visor solo abre .concepts.
    if (!/\.concepts$/i.test(f.name)) {
      manifest.files.push({ ...f, folderId, folderPath: breadcrumb, size: null, skipped: "no es .concepts" });
      continue;
    }
    const dest = path.join(OUT_DIR, `${f.id}.concepts`);
    let size;
    if (existsSync(dest)) {
      size = (await stat(dest)).size;
      console.log(`  = ${f.name} (cacheado, ${(size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      try {
        const buf = await downloadFile(f.id);
        await writeFile(dest, buf);
        size = buf.length;
        console.log(`  + ${f.name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        await sleep(700); // no atropellar a Drive
      } catch (e) {
        console.error(`  ! ${f.name}: ${e.message}`);
        manifest.files.push({ ...f, folderId, folderPath: breadcrumb, size: null, error: e.message });
        continue;
      }
    }
    manifest.files.push({ ...f, folderId, folderPath: breadcrumb, size, localPath: dest });
  }

  for (const sub of listing.folders) {
    await crawl(sub.id, sub.name, `${breadcrumb}/${sub.name}`);
  }
}

await mkdir(OUT_DIR, { recursive: true });
await crawl(ROOT_FOLDER, "Inicio", "Inicio");

manifest.files.sort((a, b) => (b.size || 0) - (a.size || 0));
await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

const ok = manifest.files.filter((f) => f.size);
const totalMb = ok.reduce((n, f) => n + f.size, 0) / 1024 / 1024;
console.log(`\n== ${ok.length} archivos, ${totalMb.toFixed(2)} MB, ${manifest.folders.length} carpetas`);
console.log("Top 10 mas pesados:");
ok.slice(0, 10).forEach((f, i) =>
  console.log(`  ${i + 1}. ${(f.size / 1024 / 1024).toFixed(2)} MB  ${f.name}  [${f.folderPath}]`)
);
const fallidos = manifest.files.filter((f) => !f.size);
if (fallidos.length) {
  console.log(`\n${fallidos.length} fallaron:`);
  fallidos.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
}
