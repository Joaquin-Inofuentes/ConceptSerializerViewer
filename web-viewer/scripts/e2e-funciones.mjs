// Verifica, una por una, las funciones nuevas sobre el dibujo MAS PESADO:
// barra de carga con porcentaje real, boton "ver todo", cambio de tema
// (galeria y lienzo), recientes, URL compartible, boton de restablecer,
// cache limitado a 3 archivos, y sobre todo: que el lienzo NO se rompa al
// hacer mucho zoom sobre las imagenes mas pesadas.
//
//   node scripts/e2e-funciones.mjs

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/capturas-funciones");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const THROTTLE = Number(process.env.THROTTLE || 4);
const PERFIL = path.resolve(".cache/perfil-funciones");

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesados = manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size);
const masPesado = pesados[0];

const browser = await puppeteer.launch({
  headless: "new",
  userDataDir: PERFIL,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errores = [];
page.on("pageerror", (e) => errores.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 160)}`);
});

const R = {};
const ok = (k, v, nota = "") => {
  R[k] = { ok: !!v, nota };
  console.log(`${v ? "  OK  " : " FALLA"} ${k}${nota ? " — " + nota : ""}`);
};

console.log(`Archivo mas pesado: ${masPesado.name} (${(masPesado.size / 1048576).toFixed(1)} MB)`);
console.log(`URL directa: ${BASE}/?file=${masPesado.id}\n`);

// ---------------------------------------------------------------- galeria
/** El prompt de nombre es un modal a pantalla completa: si queda abierto se
 * come los clicks de la cabecera y las pruebas de la UI fallan por una razon
 * que no tiene nada que ver con lo que se esta probando. */
async function cerrarPromptNombre(p) {
  try {
    await p.evaluate(() => {
      const botones = [...document.querySelectorAll("button")];
      const b = botones.find((x) => /sin nombre|continuar/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    /* no estaba */
  }
}

await page.goto(`${BASE}/?tier=baja`, { waitUntil: "domcontentloaded" });
await page.emulateCPUThrottling(THROTTLE);
await page.waitForSelector(".gallery-page", { timeout: 60000 });
await cerrarPromptNombre(page);

const temaInicial = await page.evaluate(() => document.documentElement.dataset.theme);
ok("tema oscuro por defecto", temaInicial === "oscuro", `data-theme=${temaInicial}`);

const galeriaOscura = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok("fondo de galeria sigue al tema", /rgb\((1[0-9]|[0-9]), /.test(galeriaOscura), galeriaOscura);

ok(
  "boton de restablecer en rojo",
  await page.evaluate(() => {
    const b = document.querySelector(".gallery-reset-btn");
    if (!b) return false;
    const c = getComputedStyle(b).color;
    const m = c.match(/\d+/g);
    return !!m && +m[0] > 150 && +m[1] < 130; // rojo dominante
  })
);

// Cambio de tema en la galeria.
await page.click(".gallery-tema-btn");
await new Promise((r) => setTimeout(r, 400));
const temaClaro = await page.evaluate(() => ({
  attr: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}));
ok("boton de tema cambia la galeria", temaClaro.attr === "claro", `${temaClaro.attr} / ${temaClaro.bg}`);
await page.click(".gallery-tema-btn"); // volver a oscuro
await new Promise((r) => setTimeout(r, 400));

// -------------------------------------------------------- abrir el pesado
let bytesRed = 0;
page.on("response", (res) => {
  if (res.url().includes("concepts-drive")) bytesRed += Number(res.headers()["content-length"] || 0);
});

const t0 = Date.now();
await page.goto(`${BASE}/?tier=baja&file=${masPesado.id}`, { waitUntil: "domcontentloaded" });
await page.emulateCPUThrottling(THROTTLE);

// Barra de carga: existe, tiene fases y porcentaje que avanza de verdad.
const muestras = [];
await page.waitForSelector(".viewer-carga", { timeout: 60000 });
const tBarra = Date.now() - t0;
const muestreo = setInterval(async () => {
  try {
    const m = await page.evaluate(() => {
      const c = document.querySelector(".viewer-carga");
      if (!c) return null;
      return {
        fase: c.querySelector(".viewer-carga-fase")?.textContent || null,
        pct: c.querySelector(".viewer-carga-pct")?.textContent || null,
        pie: c.querySelector(".viewer-carga-pie")?.textContent || null,
        anchoBarra: c.querySelector(".viewer-carga-relleno")?.style.width || null,
      };
    });
    if (m) muestras.push(m);
  } catch {
    /* la pagina puede estar navegando */
  }
}, 700);

await page.waitForFunction(
  () => {
    const c = document.querySelector("canvas");
    return c && c.width > 1;
  },
  { timeout: 180000 }
);
const tCanvas = Date.now() - t0;

await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 });
const tTodo = Date.now() - t0;
clearInterval(muestreo);

console.log(`\nTiempos: barra ${tBarra}ms | lienzo ${tCanvas}ms | completo ${tTodo}ms | red ${(bytesRed / 1048576).toFixed(1)} MB\n`);

const fases = [...new Set(muestras.map((m) => m.fase).filter(Boolean))];
const pcts = muestras.map((m) => (m.pct ? parseInt(m.pct) : null)).filter((n) => n !== null);
const crece = pcts.length > 1 && pcts[pcts.length - 1] >= pcts[0];
const monotona = pcts.every((v, i, a) => i === 0 || v >= a[i - 1] - 1);
ok("barra de carga con porcentaje", pcts.length > 0, `${pcts.length} muestras: ${pcts.slice(0, 8).join("% ")}%`);
ok("el porcentaje avanza (progreso real)", crece && monotona, `de ${pcts[0]}% a ${pcts[pcts.length - 1]}%`);
ok("muestra que esta haciendo", fases.length >= 2, fases.join(" -> "));
ok(
  "informa MB y velocidad",
  muestras.some((m) => m.pie && /MB/.test(m.pie)),
  muestras.find((m) => m.pie && /MB/.test(m.pie))?.pie?.slice(0, 60) || ""
);

// ------------------------------------------------- URL compartible + zoom
ok(
  "URL refleja el dibujo",
  await page.evaluate(() => location.pathname.length > 1),
  await page.evaluate(() => location.pathname)
);

ok("boton ver todo presente", await page.evaluate(() => !!document.querySelector('button[title="Ver todo el dibujo"]')));

// Estado del lienzo ANTES del zoom, para comparar despues.
const instantanea = async () =>
  page.evaluate(() => {
    const c = document.querySelector("canvas");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let noFondo = 0;
    const colores = new Set();
    for (let i = 0; i < d.length; i += 4 * 53) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      colores.add((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4));
      // "no fondo" = ni el blanco del tema claro ni el gris muy oscuro del oscuro
      if (!(r > 245 && g > 245 && b > 245) && !(r < 32 && g < 34 && b < 40)) noFondo++;
    }
    const total = Math.floor(d.length / (4 * 53));
    return {
      pctNoFondo: +((noFondo / total) * 100).toFixed(1),
      colores: colores.size,
      stats: window.__viewerStats ? window.__viewerStats() : null,
    };
  });

const antes = await instantanea();
await page.screenshot({ path: path.join(OUT, "1-completo.png") });

// ZOOM AGRESIVO sobre las imagenes: 25 pasos de rueda hacia adentro, que es
// lo que rompia antes (canvas gigantes al re-rasterizar).
await page.evaluate(async () => {
  const el = document.querySelector("canvas").parentElement;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 25; i++) {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 45));
  }
});
await new Promise((r) => setTimeout(r, 9000)); // que corra el refinado
const zoomEstado = await page.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
const despues = await instantanea();
await page.screenshot({ path: path.join(OUT, "2-zoom-profundo.png") });

const erroresZoom = errores.filter((e) => /drawImage|InvalidState|out of memory|Failed to execute/i.test(e));
ok("zoom profundo sin romper el lienzo", erroresZoom.length === 0 && despues.pctNoFondo > 1,
   `${despues.pctNoFondo}% con contenido, ${despues.colores} colores, ${erroresZoom.length} errores de dibujo`);
ok("RAM de imagenes acotada tras el zoom", (zoomEstado?.ramImagenesMB ?? 0) < 200,
   `${zoomEstado?.ramImagenesMB} MB en ${zoomEstado?.recursosEnMemoria} recursos`);

// Boton "ver todo": tiene que devolver el encuadre completo.
await page.click('button[title="Ver todo el dibujo"]');
await new Promise((r) => setTimeout(r, 2500));
const volvio = await instantanea();
await page.screenshot({ path: path.join(OUT, "3-tras-ver-todo.png") });
ok("ver todo reencuadra el dibujo", Math.abs(volvio.pctNoFondo - antes.pctNoFondo) < Math.max(6, antes.pctNoFondo * 0.5),
   `antes ${antes.pctNoFondo}% -> zoom ${despues.pctNoFondo}% -> tras el boton ${volvio.pctNoFondo}%`);

// Tema DENTRO del visor: el lienzo tiene que repintarse, no solo la UI.
const fondoAntes = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const d = c.getContext("2d").getImageData(2, 2, 1, 1).data;
  return [d[0], d[1], d[2]];
});
await page.evaluate(() => {
  const t = localStorage.getItem("conceptserializer_tema") === "claro" ? "oscuro" : "claro";
  localStorage.setItem("conceptserializer_tema", t);
  document.documentElement.setAttribute("data-theme", t);
  window.dispatchEvent(new CustomEvent("concepts:tema", { detail: t }));
});
await new Promise((r) => setTimeout(r, 1500));
const fondoDespues = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const d = c.getContext("2d").getImageData(2, 2, 1, 1).data;
  return [d[0], d[1], d[2]];
});
await page.screenshot({ path: path.join(OUT, "4-tema-cambiado.png") });
ok("el tema repinta el LIENZO", Math.abs(fondoAntes[0] - fondoDespues[0]) > 60,
   `fondo ${fondoAntes.join(",")} -> ${fondoDespues.join(",")}`);

// ------------------------------------------------------------- recientes
await page.goto(`${BASE}/?tier=baja`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".gallery-page", { timeout: 60000 });
await cerrarPromptNombre(page);
await new Promise((r) => setTimeout(r, 1500));
const rec = await page.evaluate(() => ({
  n: document.querySelectorAll(".gallery-reciente").length,
  primero: document.querySelector(".gallery-reciente-nombre")?.textContent || null,
  ruta: document.querySelector(".gallery-reciente-ruta")?.textContent || null,
}));
ok("lista de ultimos abiertos", rec.n > 0, `${rec.n}: "${rec.primero}" en ${rec.ruta}`);

const pesoRecientes = await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const q = indexedDB.open("concepts-recientes", 1);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(null);
  });
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("recientes", "readonly");
    const req = tx.objectStore("recientes").getAll();
    req.onsuccess = () => res({ filas: req.result.length, bytes: JSON.stringify(req.result).length });
    req.onerror = () => res(null);
  });
});
ok("recientes guardan solo rutas (livianos)", (pesoRecientes?.bytes ?? 99999) < 4000,
   `${pesoRecientes?.filas} filas, ${pesoRecientes?.bytes} bytes`);

// --------------------------------------------------------- cache: 3 max
// Se abren 4 dibujos distintos y se comprueba que solo queden 3 en el cache.
// Se usan archivos MEDIANOS: alcanza para llenar el cache y evita esperar 30 s
// por cada uno de los gigantes. Sin throttling, por lo mismo.
const paraCache = pesados.filter((f) => f.size > 3e6 && f.size < 30e6).slice(0, 4);
console.log(`\nProbando el limite del cache con ${paraCache.length} dibujos medianos...`);
for (const f of paraCache) {
  await page.goto(`${BASE}/?file=${f.id}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 });
  } catch {
    /* alcanza con lo que haya cacheado */
  }
  // Los guardados en IndexedDB son fire-and-forget: hay que darles aire.
  await new Promise((r) => setTimeout(r, 3000));
  const parcial = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const q = indexedDB.open("concepts-raster", 2);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(null);
    });
    if (!db) return null;
    return new Promise((res) => {
      const req = db.transaction("bitmaps", "readonly").objectStore("bitmaps").getAll();
      req.onsuccess = () => res([...new Set(req.result.map((x) => x.fileId))].length);
      req.onerror = () => res(null);
    });
  });
  console.log(`   ${f.name.slice(0, 30)}: archivos en cache = ${parcial}`);
}
const cache = await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const q = indexedDB.open("concepts-raster", 2);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(null);
  });
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("bitmaps", "readonly");
    const req = tx.objectStore("bitmaps").getAll();
    req.onsuccess = () => {
      const filas = req.result;
      res({
        archivos: [...new Set(filas.map((f) => f.fileId))].length,
        entradas: filas.length,
        MB: +(filas.reduce((n, f) => n + (f.bytes || 0), 0) / 1048576).toFixed(2),
      });
    };
    req.onerror = () => res(null);
  });
});
ok("cache limitado a 3 archivos (cola)", (cache?.archivos ?? 99) <= 3,
   `${cache?.archivos} archivos, ${cache?.entradas} entradas, ${cache?.MB} MB`);

console.log(`\nErrores de consola: ${errores.length}`);
[...new Set(errores)].slice(0, 6).forEach((e) => console.log(`  - ${e}`));

const pasan = Object.values(R).filter((r) => r.ok).length;
console.log(`\n=== ${pasan}/${Object.keys(R).length} comprobaciones OK`);
console.log(`Capturas en ${OUT}`);
console.log(`\nURL del dibujo mas pesado: ${BASE}/?file=${masPesado.id}`);
console.log(`Tiempos medidos: lienzo ${tCanvas}ms, completo ${tTodo}ms, ${(bytesRed / 1048576).toFixed(1)} MB`);

await browser.close();
