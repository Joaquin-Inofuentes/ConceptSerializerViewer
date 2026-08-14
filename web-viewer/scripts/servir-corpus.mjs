// Sirve los .concepts del corpus local por HTTP con soporte de Range.
//
// Existe para poder MEDIR: contra Drive cada rango tarda entre 0,3 y 3 s
// segun la hora, asi que la diferencia entre dos corridas del banco de pruebas
// es mas ruido que senal. Con el archivo local la parte de red es constante y
// lo que se mide de verdad es el trabajo del visor.
//
//   node scripts/servir-corpus.mjs [puerto]
//
// Se usa junto con ?origen=http://127.0.0.1:8788 en la URL de la app.

import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const DIR = path.resolve(".cache/concepts");
const PUERTO = Number(process.argv[2] || process.env.PUERTO || 8788);

const manifest = JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8"));
const porId = new Map(manifest.files.map((f) => [f.id, f]));

const servidor = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "content-range, content-length, accept-ranges",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const nombre = decodeURIComponent((req.url || "").split("?")[0].replace(/^\/+/, ""));
  const id = nombre.replace(/\.concepts$/, "");
  const f = porId.get(id);
  const archivo = f?.localPath || path.join(DIR, `${id}.concepts`);

  let info;
  try {
    info = await stat(archivo);
  } catch {
    res.writeHead(404, cors);
    res.end("no existe");
    return;
  }

  const rango = req.headers.range;
  if (!rango) {
    res.writeHead(200, { ...cors, "content-length": info.size, "accept-ranges": "bytes" });
    createReadStream(archivo).pipe(res);
    return;
  }

  // `bytes=a-b` y tambien el sufijo `bytes=-n`, que es como el lector pide el
  // indice del zip sin conocer todavia el tamano del archivo.
  const m = /bytes=(\d*)-(\d*)/.exec(rango);
  if (!m) {
    res.writeHead(416, cors);
    res.end();
    return;
  }
  let desde;
  let hasta;
  if (m[1] === "") {
    const n = Number(m[2]);
    desde = Math.max(0, info.size - n);
    hasta = info.size - 1;
  } else {
    desde = Number(m[1]);
    hasta = m[2] === "" ? info.size - 1 : Math.min(Number(m[2]), info.size - 1);
  }
  if (desde > hasta) {
    res.writeHead(416, cors);
    res.end();
    return;
  }

  res.writeHead(206, {
    ...cors,
    "content-range": `bytes ${desde}-${hasta}/${info.size}`,
    "content-length": hasta - desde + 1,
    "accept-ranges": "bytes",
    // El lector lo usa para no re-resolver el interstitial de Drive; aca es
    // fijo, pero se manda igual para recorrer el mismo camino de codigo.
    "x-drive-total": String(info.size),
  });
  createReadStream(archivo, { start: desde, end: hasta }).pipe(res);
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`corpus en http://127.0.0.1:${PUERTO}  (${porId.size} archivos)`);
});
