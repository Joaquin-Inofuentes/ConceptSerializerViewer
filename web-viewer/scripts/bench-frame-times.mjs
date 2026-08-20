// Perfila el costo REAL de cada frame (no la cadencia, el trabajo de
// dibujar) durante una secuencia de gestos representativos, y desglosa por
// fase (grilla, imagenes, trazos, trazos fusionados) para saber DONDE se va
// el tiempo, no solo cuanto.
//
// El desglose sale de `Viewer.tsx`: cada frame dibujado anota
// `statsRef.current.faseXMs` con `performance.now()` en los limites reales
// del propio loop de render, asi que el numero es el trabajo real y no una
// aproximacion externa.
//
//   node scripts/servir-corpus.mjs 8788     (en otra consola)
//   npm run dev                             (en otra consola)
//   node scripts/bench-frame-times.mjs [driveFileId] [--json salida.json]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");
const LIMITE_MS = Number(process.env.LIMITE_MS || 10);

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const JSON_OUT = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const FILE_ID = args.find((a) => !a.startsWith("--") && a !== JSON_OUT);

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const disponibles = manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size);
const target = FILE_ID ? disponibles.find((f) => f.id === FILE_ID) : disponibles[0];
if (!target) throw new Error("archivo no encontrado en el corpus local");

console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB)`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 200)));

// El sampler se inyecta ANTES de navegar (evaluateOnNewDocument), para que
// la apertura en frio tambien quede cubierta: es donde vive el trabajo mas
// pesado del hilo principal (parsear tree.pack, decodificar el primer JPEG,
// el primer commit de React con el documento entero) y un sampler que
// arranca DESPUES de que la app ya cargo no lo ve nunca.
await page.evaluateOnNewDocument(() => {
  window.__bench = { muestras: [] };
  let anterior = performance.now();
  const loop = () => {
    const ahora = performance.now();
    const s = window.__viewerStats?.();
    window.__bench.muestras.push({
      t: ahora,
      hueco: ahora - anterior,
      total: s ? s.ultimoFrameMs : 0,
      grid: s ? s.faseGridMs : 0,
      imagenes: s ? s.faseImagenesMs : 0,
      trazos: s ? s.faseTrazosMs : 0,
      fusionados: s ? s.faseTrazosFusionadosMs : 0,
      nImg: s ? s.itemsImagenDibujados : 0,
      nTrazo: s ? s.itemsTrazoDibujados : 0,
      nGrupos: s ? s.gruposFusionadosDibujados : 0,
      refinando: !!window.__viewerRefinando,
    });
    anterior = ahora;
    window.__bench.raf = requestAnimationFrame(loop);
  };
  window.__bench.raf = requestAnimationFrame(loop);
});

const tGoto = Date.now();
await page.goto(`${BASE}/?tier=alta&file=${target.id}&origen=${encodeURIComponent(ORIGEN)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log(`  (apertura hasta asentado: ${((Date.now() - tGoto) / 1000).toFixed(1)}s)`);

// Se cierra la tanda de apertura en frio y se recorta el primer hueco (mide
// desde antes de que el sampler realmente arrancara).
const tandaApertura = {
  nombre: "apertura en frio (goto -> asentado)",
  muestras: (await page.evaluate(() => window.__bench.muestras)).slice(1),
};

/**
 * Corre una tanda de gestos, muestreando el HUECO REAL entre callbacks de
 * requestAnimationFrame (no el costo que reporta el propio Viewer). Es la
 * misma distincion que ya explica el comentario de `ultimoFrameRef` en
 * Viewer.tsx: el trabajo de DIBUJAR puede ser rapido y el frame igual
 * sentirse trabado si algo mas —decodificar un JPEG, el GC, un commit de
 * React, el hilo principal atendiendo al worker— se comio el tiempo entre
 * un callback y el siguiente. Midiendo el hueco de un rAF corriendo aparte
 * (no el de Viewer, que se apaga cuando no hay nada que redibujar) se
 * captura ESE tiempo tambien, que es el que el usuario percibe como jank.
 *
 * En cada muestra se adjunta el ultimo desglose por fase que reporto el
 * Viewer: no es necesariamente el de ESE frame exacto, pero sirve como
 * contexto de que estaba dibujando el lienzo cuando el hueco fue grande.
 */
async function perfilarGestos(nombre, aplicarGestos, duracionMs = 2500) {
  await page.evaluate(() => {
    window.__bench = { muestras: [] };
    let anterior = performance.now();
    const loop = () => {
      const ahora = performance.now();
      const s = window.__viewerStats?.();
      window.__bench.muestras.push({
        t: ahora,
        hueco: ahora - anterior,
        total: s ? s.ultimoFrameMs : 0,
        grid: s ? s.faseGridMs : 0,
        imagenes: s ? s.faseImagenesMs : 0,
        trazos: s ? s.faseTrazosMs : 0,
        fusionados: s ? s.faseTrazosFusionadosMs : 0,
        nImg: s ? s.itemsImagenDibujados : 0,
        nTrazo: s ? s.itemsTrazoDibujados : 0,
        nGrupos: s ? s.gruposFusionadosDibujados : 0,
        refinando: !!window.__viewerRefinando,
      });
      anterior = ahora;
      window.__bench.raf = requestAnimationFrame(loop);
    };
    anterior = performance.now();
    window.__bench.raf = requestAnimationFrame(loop);
  });

  await aplicarGestos();
  await new Promise((r) => setTimeout(r, duracionMs));

  const muestras = await page.evaluate(() => {
    cancelAnimationFrame(window.__bench.raf);
    // El primer hueco mide desde ANTES de este `perfilarGestos` (setup del
    // loop), no un frame real: se descarta para no ensuciar el percentil.
    return window.__bench.muestras.slice(1);
  });
  return { nombre, muestras };
}

const cajas = await page.evaluate(() => window.__viewerCajas());
if (cajas.length === 0) throw new Error("el documento no tiene imagenes colocadas");
const planos = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
const grande = planos[0];

const fijar = (v) => page.evaluate((v) => window.__viewerFijarVista(v), v);
const encuadre = async (caja, margen = 1.1) => {
  const w = caja.x1 - caja.x0, h = caja.y1 - caja.y0;
  const c = await page.evaluate(() => {
    const el = document.querySelector("canvas");
    return { w: el.clientWidth, h: el.clientHeight };
  });
  const zoom = Math.min(c.w / (w * margen), c.h / (h * margen));
  const cx = caja.x0 + w / 2, cy = caja.y0 + h / 2;
  await fijar({ zoom, panX: c.w / 2 - cx * zoom, panY: c.h / 2 - cy * zoom });
  return { zoom, cx, cy, w: c.w, h: c.h };
};

const tandas = [tandaApertura];

// 1. Vista general (zoom-all): el peor caso para trazos fusionados/grilla.
tandas.push(
  await perfilarGestos("zoom-all (vista general)", async () => {
    const minX = Math.min(...cajas.map((c) => c.x0));
    const minY = Math.min(...cajas.map((c) => c.y0));
    const maxX = Math.max(...cajas.map((c) => c.x1));
    const maxY = Math.max(...cajas.map((c) => c.y1));
    await encuadre({ x0: minX, y0: minY, x1: maxX, y1: maxY }, 1.15);
  })
);

// 2. Paneo real dentro de la vista general (arrastre CSS, no teletransporte):
// ejercita el camino de gesto (marcarGesto) ademas del de asentado.
tandas.push(
  await perfilarGestos("arrastre en vista general", async () => {
    const c = await page.evaluate(() => {
      const el = document.querySelector("canvas");
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(c.x - i * 15, c.y - i * 8, { steps: 2 });
      await new Promise((r) => setTimeout(r, 16));
    }
    await page.mouse.up();
  }, 1500)
);

// 3. Zoom fuerte sobre el plano mas grande: el caso "afinando" con
// resolucion plena, el que mas sube el costo de la fase de imagenes.
tandas.push(
  await perfilarGestos(`zoom al plano mas grande (${grande.resourceId.slice(0, 8)})`, async () => {
    await encuadre(grande, 1.05);
  })
);

// 4. Esquina del plano grande a zoom extremo: el peor caso real, el mismo
// patron que probaba e2e-perdida-imagenes.
tandas.push(
  await perfilarGestos("esquina a zoom extremo", async () => {
    const w = grande.x1 - grande.x0, h = grande.y1 - grande.y0;
    await fijar({
      zoom: 0, // se recalcula abajo
      panX: 0,
      panY: 0,
    }).catch(() => {});
    const c = await page.evaluate(() => {
      const el = document.querySelector("canvas");
      return { w: el.clientWidth, h: el.clientHeight };
    });
    const zoom = Math.min(c.w, c.h) / (Math.max(w, h) / 8);
    const cx = grande.x0 + w * 0.88, cy = grande.y0 + h * 0.12;
    await fijar({ zoom, panX: c.w / 2 - cx * zoom, panY: c.h / 2 - cy * zoom });
  })
);

// 5. Rebote entre dos planos grandes (si hay mas de uno): ejercita el
// desalojo/carga del FIFO hot en caliente.
if (planos.length > 1) {
  tandas.push(
    await perfilarGestos("rebote entre dos planos", async () => {
      await encuadre(planos[0], 1.1);
      await new Promise((r) => setTimeout(r, 400));
      await encuadre(planos[1], 1.1);
    }, 1800)
  );
}

await browser.close();

// --- Reporte -----------------------------------------------------------
function stats(arr) {
  if (arr.length === 0) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const suma = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    media: +(suma / s.length).toFixed(2),
    p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

console.log(`\nLimite objetivo por frame: ${LIMITE_MS} ms (medido como hueco real entre rAF, no el costo que reporta el propio dibujado)\n`);
const resumen = [];
for (const t of tandas) {
  const huecos = t.muestras.map((m) => m.hueco);
  const st = stats(huecos);
  const sobreLimite = t.muestras.filter((m) => m.hueco > LIMITE_MS);
  console.log(`--- ${t.nombre} (${st.n} frames) ---`);
  if (st.n === 0) {
    console.log("  (sin frames muestreados en esta tanda)");
    continue;
  }
  console.log(`  hueco rAF:   media ${st.media}ms  p50 ${st.p50}ms  p95 ${st.p95}ms  max ${st.max}ms`);
  const draw = stats(t.muestras.map((m) => m.total));
  console.log(`  dibujado:    media ${draw.media ?? 0}ms  p95 ${draw.p95 ?? 0}ms  (lo que reporta Viewer.tsx del propio draw)`);
  console.log(`  > ${LIMITE_MS}ms: ${sobreLimite.length}/${st.n} (${((sobreLimite.length / st.n) * 100).toFixed(1)}%)`);
  if (sobreLimite.length > 0) {
    const peor = [...t.muestras].sort((a, b) => b.hueco - a.hueco)[0];
    console.log(
      `  PEOR hueco: ${peor.hueco.toFixed(2)}ms -- dibujado=${peor.total.toFixed(2)}ms ` +
        `(grid=${peor.grid.toFixed(2)} imagenes=${peor.imagenes.toFixed(2)}[${peor.nImg}] ` +
        `trazos=${peor.trazos.toFixed(2)}[${peor.nTrazo}] fusionados=${peor.fusionados.toFixed(2)}[${peor.nGrupos}]) ` +
        `refinando=${peor.refinando}`
    );
    if (peor.hueco - peor.total > LIMITE_MS) {
      console.log(`  -> ${(peor.hueco - peor.total).toFixed(2)}ms de ese hueco NO fueron dibujar: otra cosa bloqueo el hilo principal.`);
    }
  }
  resumen.push({ tanda: t.nombre, ...st, sobreLimite: sobreLimite.length, muestras: t.muestras });
}

if (errores.length) {
  console.log("\nErrores de pagina:");
  errores.forEach((e) => console.log("  ", e));
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ archivo: target.name, limiteMs: LIMITE_MS, tandas: resumen }, null, 1));
  console.log(`\nJSON guardado en ${JSON_OUT}`);
}

const todos = tandas.flatMap((t) => t.muestras.map((m) => m.hueco));
const peorGlobal = Math.max(...todos, 0);
const sobreTotal = todos.filter((h) => h > LIMITE_MS).length;
console.log(`\nPEOR HUECO GLOBAL: ${peorGlobal.toFixed(2)}ms  |  frames > ${LIMITE_MS}ms: ${sobreTotal}/${todos.length} (${((sobreTotal / todos.length) * 100).toFixed(1)}%)`);
process.exit(peorGlobal > LIMITE_MS * 3 ? 1 : 0);
