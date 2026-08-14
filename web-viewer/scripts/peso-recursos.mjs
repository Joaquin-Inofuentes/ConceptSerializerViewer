// ¿Cuanto pesa cada recurso y cuanto espacio ocupa en el dibujo?
//
// Cruza el tamano en BYTES de cada entrada del zip (leyendo el archivo local,
// sin navegador ni red) con el tamano en PANTALLA que le da el documento. Es
// lo que decide que vale la pena bajar y que no: un PDF de 3 MB que en el
// encuadre completo ocupa 3x3 px no aporta nada y cuesta lo mismo que uno que
// ocupa media pantalla.
//
//   node scripts/peso-recursos.mjs [driveFileId]

import { readFile } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.resolve(".cache/concepts");
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = process.argv[2]
  ? [manifest.files.find((f) => f.id === process.argv[2])]
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, Number(process.env.TOP || 3));

/** Indice central de un zip, leido del final del archivo. */
function leerIndice(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 128 * 1024; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  let offset = v.getUint32(eocd + 16, true);
  let count = v.getUint16(eocd + 10, true);
  if (offset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && v.getUint32(loc, true) === 0x07064b50) {
      const abs = Number(v.getBigUint64(loc + 8, true));
      if (v.getUint32(abs, true) === 0x06064b50) {
        count = Number(v.getBigUint64(abs + 32, true));
        offset = Number(v.getBigUint64(abs + 48, true));
      }
    }
  }
  const out = [];
  let p = offset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) break;
    let comp = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (comp === 0xffffffff) {
      let e = p + 46 + nameLen;
      const fin = e + extraLen;
      while (e + 4 <= fin) {
        const id = v.getUint16(e, true);
        const sz = v.getUint16(e + 2, true);
        if (id === 0x0001) {
          comp = Number(v.getBigUint64(e + 12, true));
          break;
        }
        e += 4 + sz;
      }
    }
    out.push({ name, comp });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const colocacion = JSON.parse(
  await readFile(path.join(CACHE_DIR, "audit-colocacion.json"), "utf8").catch(() => "[]")
);

for (const f of objetivos) {
  if (!f?.localPath) continue;
  const buf = await readFile(f.localPath);
  const entradas = leerIndice(buf).filter((e) => /^resources\//.test(e.name));
  const porUuid = new Map();
  for (const e of entradas) {
    const uuid = e.name.replace(/^resources\//, "").replace(/\.[^.]+$/, "").replace(/-/g, "");
    porUuid.set(uuid, e.comp);
  }

  const info = colocacion.find((c) => c.id === f.id);
  console.log(`\n${"=".repeat(72)}\n${f.name} — ${(f.size / 1048576).toFixed(1)} MB — ${entradas.length} recursos en el zip\n${"=".repeat(72)}`);

  if (!info) {
    console.log("  (sin audit-colocacion.json: corre antes node scripts/audit-colocacion.mjs)");
    continue;
  }

  // Area del encuadre completo, para saber que fraccion de pantalla ocupa cada uno.
  const filas = info.colocaciones.map((c) => {
    const uuid = c.resourceId.replace(/-/g, "");
    return { ...c, bytes: porUuid.get(uuid) ?? 0 };
  });
  const totalBytes = filas.reduce((n, x) => n + x.bytes, 0);

  const anchoDoc = Math.max(...filas.map((x) => x.x1)) - Math.min(...filas.map((x) => x.x0));
  const altoDoc = Math.max(...filas.map((x) => x.y1)) - Math.min(...filas.map((x) => x.y0));
  // Encuadre tipico de telefono.
  const zoom = Math.min(360 / anchoDoc, 700 / altoDoc);

  const conPx = filas
    .map((x) => ({ ...x, ladoPx: Math.max(x.ancho, x.alto) * zoom, mb: x.bytes / 1048576 }))
    .sort((a, b) => b.ladoPx - a.ladoPx);

  console.log(`  zoom de encuadre completo en 360x700: ${zoom.toFixed(4)}`);
  console.log(`  total de recursos colocados: ${(totalBytes / 1048576).toFixed(1)} MB`);
  for (const umbral of [4, 8, 16, 32, 64]) {
    const dentro = conPx.filter((x) => x.ladoPx >= umbral);
    const bytes = dentro.reduce((n, x) => n + x.bytes, 0);
    console.log(
      `  lado >= ${String(umbral).padStart(3)} px: ${String(dentro.length).padStart(3)} recursos, ${(bytes / 1048576).toFixed(1).padStart(6)} MB (${((bytes / totalBytes) * 100).toFixed(1)}%)`
    );
  }
  console.log(`  los 6 mas pesados:`);
  [...conPx].sort((a, b) => b.bytes - a.bytes).slice(0, 6).forEach((x) =>
    console.log(`    ${x.resourceId.slice(0, 8)}  ${x.mb.toFixed(1).padStart(6)} MB  lado ${x.ladoPx.toFixed(1)} px  caja ${x.ancho}x${x.alto}`)
  );
  console.log(`  los 6 mas chicos en pantalla:`);
  conPx.slice(-6).forEach((x) =>
    console.log(`    ${x.resourceId.slice(0, 8)}  ${x.mb.toFixed(1).padStart(6)} MB  lado ${x.ladoPx.toFixed(1)} px  caja ${x.ancho}x${x.alto}`)
  );
}
