// Audita la COLOCACION de imagenes contra lo que dice el archivo, sobre todo
// el corpus local. Es la red de seguridad del fix de "fotos desfasadas".
//
//   node scripts/servir-corpus.mjs 8788        (en otra consola)
//   npm run dev                                (en otra consola)
//   node scripts/verificar-colocacion.mjs [cuantos]
//   node scripts/verificar-colocacion.mjs --solo <driveFileId>
//
// Comprueba tres cosas por archivo:
//
//  1. INVARIANTE DE COLOCACION. El centro con el que el visor dibuja cada
//     imagen tiene que ser exactamente `(e, -f)`, con `e`/`f` la traslacion
//     cruda de la matriz de cabecera del elemento. Es la unica conversion
//     compatible con la que se usa para los trazos (invertir solo Y). El bug
//     que esto vigila daba `(-e, -f)`: un espejo en X que mandaba cada
//     elemento descentrado al lado opuesto del dibujo.
//
//  2. LAS FOTOS QUEDAN DERECHAS. Concepts guarda el JPEG CRUDO (sin aplicar su
//     EXIF) y compensa esa rotacion en la matriz de colocacion, que es como la
//     foto termina derecha en el lienzo. O sea: la rotacion de la cabecera
//     tiene que ser la inversa de la del EXIF. Lo que se mide aca es el
//     RESIDUO — cuanto queda inclinada la foto despues de las dos — y tiene
//     que dar casi cero.
//
//     Es la propiedad que de verdad le importa al usuario, y ademas es la que
//     detecta una regresion en el manejo de EXIF: si se vuelve a deshacer mal,
//     los residuos se van en bloque a 90 o 180 grados en vez de repartirse
//     alrededor de cero.
//
//     Un residuo grande suelto NO es un error: es una foto que el usuario roto
//     a mano a proposito. Por eso se listan aparte y no cuentan como falla.
//
//  3. IMPACTO. Cuanto se movia cada imagen con el modelo viejo, en % de la
//     diagonal del dibujo. Sirve para saber que archivos se veian mal y
//     cuales no cambian.
//
// Sale con codigo != 0 si algun invariante falla, asi se puede usar en CI.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { decode, ExtensionCodec } from "@msgpack/msgpack";
import JSZip from "jszip";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");
// Tolerancia en unidades de documento. Los centros se comparan contra float32
// leidos del archivo, asi que el error admisible es de redondeo, no de modelo.
const TOL = 0.05;

const args = process.argv.slice(2);
const soloIdx = args.indexOf("--solo");
const SOLO = soloIdx >= 0 ? args[soloIdx + 1] : null;
const CUANTOS = Number(args.find((a) => /^\d+$/.test(a)) || 25);

// ---------------------------------------------------------------------------
// Lado node: leer el archivo crudo, sin pasar por el visor. Es la "verdad" con
// la que se contrasta lo que hace el parser.
// ---------------------------------------------------------------------------
const codec = new ExtensionCodec();
const par = (d) => {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return [v.getFloat32(0, true), v.getFloat32(4, true)];
};
for (const t of [0, 1, 2]) codec.register({ type: t, encode: () => new Uint8Array(), decode: par });
codec.register({
  type: 4,
  encode: () => new Uint8Array(),
  decode: (d) => {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return [0, 1, 2, 3].map((i) => v.getFloat32(i * 4, true));
  },
});
codec.register({
  type: 5,
  encode: () => new Uint8Array(),
  decode: (d) => {
    const hex = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});
codec.register({
  type: 7,
  encode: () => new Uint8Array(),
  decode: (d) => {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const m = [];
    for (let i = 0; i < 16; i++) m.push(v.getFloat32(i * 4, true));
    return m;
  },
});

/** Orientacion EXIF de un JPEG (1..8), 0 si no trae. */
function orientacionExif(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marcador = b[i + 1];
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (marcador === 0xe1) {
      const t = i + 4;
      if (b[t] === 0x45 && b[t + 1] === 0x78 && b[t + 2] === 0x69 && b[t + 3] === 0x66) {
        const tiff = t + 6;
        const le = b[tiff] === 0x49;
        const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o) =>
          le
            ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
            : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        const ifd = tiff + u32(tiff + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
      }
      return 0;
    }
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4) return 0;
    i += 2 + largo;
  }
  return 0;
}

/**
 * Grados que hay que rotar el JPEG CRUDO para verlo derecho, segun su EXIF.
 * En el sentido del canvas (Y hacia abajo), que es donde se compara.
 * Las orientaciones espejadas (2,4,5,7) no llevan rotacion pura: se devuelven
 * como null porque el residuo no tiene sentido para ellas.
 */
function girosDeExif(o) {
  if (o === 0 || o === 1) return 0;
  if (o === 3) return 180;
  if (o === 6) return 90;
  if (o === 8) return -90;
  return null;
}

/** Angulo de la parte lineal de una afin, en grados. */
const anguloDe = (a, b) => (Math.atan2(b, a) * 180) / Math.PI;

/** Lleva un angulo al rango (-180, 180]. */
function normalizar(g) {
  let x = ((g + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

async function leerArchivo(ruta) {
  const zip = await JSZip.loadAsync(await readFile(ruta));
  const nombres = Object.keys(zip.files);
  const nTree = nombres.find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nTree) return null;
  const tree = decode(await zip.file(nTree).async("uint8array"), { extensionCodec: codec });

  const imgs = [];
  const trazoBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const recorrer = (o, prof) => {
    if (!Array.isArray(o) || prof > 30) return;
    const blobs = o.filter((x) => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);
    if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
      const blob = blobs[0];
      const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      for (let i = 0; i < Math.floor(blob.length / 16); i++) {
        const x = v.getFloat32(i * 16, true);
        const y = v.getFloat32(i * 16 + 4, true);
        if (x < trazoBox.minX) trazoBox.minX = x;
        if (x > trazoBox.maxX) trazoBox.maxX = x;
        if (y < trazoBox.minY) trazoBox.minY = y;
        if (y > trazoBox.maxY) trazoBox.maxY = y;
      }
      return;
    }
    if ((o[0] === 7 || o[0] === 8) && Array.isArray(o[1])) {
      const cuerpo = o[1];
      const interno = Array.isArray(cuerpo[1]) ? cuerpo[1] : [];
      const rid = cuerpo.find((x) => typeof x === "string" && x.includes("-"));
      const tam = cuerpo.find((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
      const cab = interno.find((x) => Array.isArray(x) && x.length === 16);
      let segunda = null;
      for (const x of cuerpo) {
        if (x === interno) continue;
        if (Array.isArray(x) && x.length === 16 && x.every((n) => typeof n === "number")) segunda = x;
      }
      if (rid && tam && cab && tam[0] > 0 && tam[1] > 0) {
        imgs.push({
          tipo: o[0], rid, w: tam[0], h: tam[1],
          a: cab[0], b: cab[1], c: cab[4], d: cab[5], e: cab[12], f: cab[13],
          segunda,
        });
      }
      return;
    }
    for (const x of o) recorrer(x, prof + 1);
  };
  recorrer(tree, 0);

  for (const im of imgs) {
    if (im.tipo !== 7) continue;
    const plano = im.rid.split("#")[0].replace(/-/g, "");
    const entrada = nombres.find((n) => n.replace(/-/g, "").includes(plano));
    if (!entrada) continue;
    im.exif = orientacionExif(await zip.file(entrada).async("uint8array"));
  }
  return { imgs, trazoBox };
}

// ---------------------------------------------------------------------------
// Lado navegador: lo que de verdad hace el visor.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = new Set((await readdir(CACHE_DIR)).filter((n) => n.endsWith(".concepts")).map((n) => n.replace(/\.concepts$/, "")));
let objetivos = manifest.files.filter((f) => disponibles.has(f.id));
objetivos = SOLO ? objetivos.filter((f) => f.id === SOLO) : objetivos.slice(0, CUANTOS);

const navegador = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const pagina = await navegador.newPage();
pagina.setDefaultTimeout(600000);
pagina.on("pageerror", (e) => console.error("  [error de pagina]", e.message.slice(0, 160)));
await pagina.goto(BASE, { waitUntil: "domcontentloaded" });

let fallos = 0;
let fotosRevisadas = 0;
let imagenesRevisadas = 0;
let archivosAfectados = 0;
const porExif = {};
const desplazamientos = [];
const residuos = [];
const errorPos = [];
const rotadasAMano = [];

let ilegibles = 0;
for (const f of objetivos) {
  let local;
  try {
    local = await leerArchivo(f.localPath || path.join(CACHE_DIR, `${f.id}.concepts`));
  } catch (e) {
    // Una copia local incompleta del corpus no es un fallo del visor. Se avisa
    // y se sigue: si se contara como falla, el resultado del banco dependeria
    // de como quedo la descarga.
    console.log(`omitido ${f.name}: no se pudo leer el .concepts local (${String(e).slice(0, 60)})`);
    ilegibles++;
    continue;
  }
  if (!local || local.imgs.length === 0) continue;

  let visor;
  try {
    visor = await pagina.evaluate(async (url) => {
      const mod = await import("/scripts/browser/colocacion-payload.ts");
      return mod.colocacionDeImagenes(url);
    }, `${ORIGEN}/${encodeURIComponent(f.id)}.concepts`);
  } catch (e) {
    console.error(`FALLO al abrir ${f.name}:`, String(e).slice(0, 200));
    fallos++;
    continue;
  }

  // Diagonal del dibujo, para expresar el desplazamiento en % y no en unidades
  // sueltas (que no dicen nada sin saber la escala del archivo).
  const diag = Math.hypot(
    Math.max(local.trazoBox.maxX - local.trazoBox.minX, 1),
    Math.max(local.trazoBox.maxY - local.trazoBox.minY, 1)
  );

  const problemas = [];
  let maxDesplazamiento = 0;

  // Se comparan por posicion en el recorrido: node y el parser recorren el
  // mismo arbol en el mismo orden.
  if (visor.length !== local.imgs.length) {
    problemas.push(`el visor encontro ${visor.length} imagenes y el archivo tiene ${local.imgs.length}`);
  }
  const n = Math.min(visor.length, local.imgs.length);
  for (let i = 0; i < n; i++) {
    const esp = local.imgs[i];
    const obt = visor[i];
    imagenesRevisadas++;

    // (1) invariante de colocacion
    const dx = Math.abs(obt.centro[0] - esp.e);
    const dy = Math.abs(obt.centro[1] - -esp.f);
    // Se guarda el error aunque pase: sirve para distinguir "exacto salvo
    // redondeo de float32" de "casi bien, con un sesgo chico" — que es como se
    // veria un centro de rotacion o un anclaje corrido.
    errorPos.push(Math.max(dx, dy));
    if (dx > TOL || dy > TOL) {
      const espejado = Math.abs(obt.centro[0] + esp.e) <= TOL;
      problemas.push(
        `${esp.rid.slice(0, 8)}: centro (${obt.centro[0].toFixed(1)}, ${obt.centro[1].toFixed(1)}) ` +
          `pero el archivo dice (${esp.e.toFixed(1)}, ${(-esp.f).toFixed(1)})` +
          (espejado ? "  <-- ESPEJADO EN X (el bug viejo)" : "")
      );
    }

    // (3) impacto: cuanto se movia con el modelo viejo
    const mov = (2 * Math.abs(esp.e)) / diag;
    if (mov > maxDesplazamiento) maxDesplazamiento = mov;

    // (2) la foto queda derecha
    if (esp.tipo === 7 && esp.exif !== undefined) {
      fotosRevisadas++;
      porExif[esp.exif] = (porExif[esp.exif] || 0) + 1;

      if (obt.exif !== undefined && obt.exif !== esp.exif) {
        problemas.push(`${esp.rid.slice(0, 8)}: el visor leyo EXIF ${obt.exif} y el archivo trae ${esp.exif}`);
      }
      if ([2, 4, 5, 7].includes(esp.exif)) {
        console.warn(`  AVISO ${f.name} / ${esp.rid.slice(0, 8)}: EXIF ${esp.exif} (espejada). Se dibuja, pero no hay ningun caso asi en el corpus: mirala.`);
      }

      // Una foto no tiene que salir NUNCA espejada. El espejo no se ve como un
      // error: se ve como una foto normal con los carteles al reves, y hay que
      // fijarse en el contenido para notarlo — por eso conviene medirlo y no
      // mirarlo. Encadenando todo lo que se aplica (inversion de Y del
      // documento por fuera, volteo del bitmap por dentro, y el EXIF deshecho)
      // los dos espejos se cancelan, asi que el sentido final lo decide el
      // signo del determinante de la colocacion: positivo = derecha.
      const det = esp.a * esp.d - esp.b * esp.c;
      if (det < 0) {
        rotadasAMano.push(`${f.name} / ${esp.rid.slice(0, 8)}: colocada con determinante negativo (el usuario la espejo)`);
      }

      const giroExif = girosDeExif(esp.exif);
      if (giroExif !== null) {
        // Al pasar a canvas, la colocacion se compone con la inversion de Y del
        // documento por fuera y con el volteo del bitmap por dentro; el efecto
        // sobre el CONTENIDO es rotarlo por el angulo opuesto al de la matriz.
        const giroEnPantalla = -anguloDe(esp.a, esp.b);
        const residuo = normalizar(giroEnPantalla - giroExif);
        residuos.push(Math.abs(residuo));
        if (Math.abs(residuo) > 15) {
          rotadasAMano.push(`${f.name} / ${esp.rid.slice(0, 8)}: queda ${residuo.toFixed(0)}° inclinada (EXIF ${esp.exif})`);
        }
      }
    }
  }

  desplazamientos.push({ nombre: f.name, mov: maxDesplazamiento, imgs: local.imgs.length });
  if (maxDesplazamiento > 0.02) archivosAfectados++;

  if (problemas.length) {
    fallos += problemas.length;
    console.log(`\nFALLA  ${f.name}`);
    problemas.forEach((p) => console.log(`   - ${p}`));
  } else {
    console.log(
      `ok     ${f.name}  (${local.imgs.length} imgs, corrimiento del modelo viejo: ${(maxDesplazamiento * 100).toFixed(1)}%)`
    );
  }
}

await navegador.close();

console.log("\n--- resumen ---------------------------------------------------");
console.log(`archivos con imagenes revisados : ${desplazamientos.length}`);
console.log(`archivos locales ilegibles      : ${ilegibles} (copia incompleta, no cuentan)`);
console.log(`imagenes verificadas            : ${imagenesRevisadas}`);
console.log(`fotos verificadas               : ${fotosRevisadas}`);
console.log(`fotos por EXIF                  : ${JSON.stringify(porExif)}`);
console.log(`archivos que el bug movia >2%   : ${archivosAfectados}`);
if (errorPos.length) {
  const ord = [...errorPos].sort((a, b) => a - b);
  console.log(
    `error de centro (unidades doc)  : max ${ord[ord.length - 1].toExponential(1)}, ` +
      `mediana ${ord[Math.floor(ord.length / 2)].toExponential(1)}  (float32 ~1e-4 sobre estas magnitudes)`
  );
}
const peores = desplazamientos.sort((a, b) => b.mov - a.mov).slice(0, 8);
console.log("peores corrimientos del modelo viejo:");
for (const p of peores) console.log(`   ${(p.mov * 100).toFixed(1).padStart(6)}%  ${p.nombre}`);

// Las fotos derechas. Si el EXIF se deshiciera mal, esto no daria "casi todas
// a menos de 15 grados": daria un bloque entero a 90 o a 180.
if (residuos.length) {
  const derechas = residuos.filter((r) => r <= 15).length;
  const ordenados = [...residuos].sort((a, b) => a - b);
  const mediana = ordenados[Math.floor(ordenados.length / 2)];
  console.log(
    `\nfotos que quedan derechas       : ${derechas}/${residuos.length} ` +
      `(${((derechas / residuos.length) * 100).toFixed(1)}%), inclinacion mediana ${mediana.toFixed(1)}°`
  );

  // Reparto de las inclinaciones chicas. Importa mirarlo y no quedarse con la
  // mediana: un error sistematico de un par de grados (por ejemplo, un centro
  // de rotacion corrido) daria una mediana baja pero un reparto apretado
  // lejos de cero, mientras que el pulso de la mano da una cola suave.
  const cortes = [0.5, 1, 2, 5, 10, 15];
  let previo = 0;
  const tramos = [];
  for (const c of cortes) {
    tramos.push(`${previo}-${c}°: ${residuos.filter((r) => r > previo && r <= c).length}`);
    previo = c;
  }
  console.log(`   reparto  <=0.5°: ${residuos.filter((r) => r <= 0.5).length}  ${tramos.slice(1).join("  ")}  >15°: ${residuos.filter((r) => r > 15).length}`);
  const p90 = ordenados[Math.floor(ordenados.length * 0.9)];
  const p99 = ordenados[Math.floor(ordenados.length * 0.99)];
  console.log(`   percentiles p90 ${p90.toFixed(2)}°  p99 ${p99.toFixed(2)}°`);
  const enBloque = residuos.filter((r) => r > 60).length;
  if (enBloque > residuos.length * 0.05) {
    console.log(`   ATENCION: ${enBloque} fotos a mas de 60° — huele a EXIF deshecho al reves, no a rotaciones a mano.`);
    fallos += enBloque;
  }
  if (rotadasAMano.length) {
    console.log(`   ${rotadasAMano.length} rotada(s) a mano por el usuario (no es un error):`);
    for (const r of rotadasAMano.slice(0, 10)) console.log(`     ${r}`);
  }
}

console.log(fallos === 0 ? "\nTODOS LOS INVARIANTES PASAN" : `\n${fallos} PROBLEMA(S)`);
process.exit(fallos === 0 ? 0 : 1);
