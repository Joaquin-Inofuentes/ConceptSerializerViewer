// Captura un trace de Chrome DevTools durante apertura + zoom y reporta los
// bloqueos LARGOS del hilo principal por nombre de funcion/evento, para
// saber DONDE se va el tiempo cuando `bench-frame-times.mjs` encuentra un
// hueco de rAF de cientos de ms que el propio Viewer no explica (dibujado
// ~0ms). Sin esto, un hueco grande es solo un numero: con el trace se sabe
// si es GC, decode de imagen, msgpack, JSZip, o React.
//
//   node scripts/bench-trace-largos.mjs [driveFileId] [--umbral 15]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/trace");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");

const args = process.argv.slice(2);
const umbralIdx = args.indexOf("--umbral");
const UMBRAL_MS = umbralIdx >= 0 ? Number(args[umbralIdx + 1]) : 15;
const FILE_ID = args.find((a) => !a.startsWith("--") && a !== String(UMBRAL_MS));

await mkdir(OUT, { recursive: true });
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

const traceFile = path.join(OUT, `trace-${target.id.slice(0, 8)}.json`);
await page.tracing.start({
  path: traceFile,
  categories: [
    "devtools.timeline",
    "v8",
    "disabled-by-default-v8.compile",
    "blink.user_timing",
    "disabled-by-default-devtools.timeline",
  ],
});

await page.goto(`${BASE}/?tier=alta&file=${target.id}&origen=${encodeURIComponent(ORIGEN)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// Un zoom fuerte al plano mas grande, para capturar el camino de "afinando"
// tambien (no solo la apertura).
await page.evaluate(() => {
  const cajas = window.__viewerCajas();
  const grande = [...cajas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  const c = document.querySelector("canvas");
  const w = grande.x1 - grande.x0, h = grande.y1 - grande.y0;
  const zoom = Math.min(c.clientWidth, c.clientHeight) / (Math.max(w, h) / 8);
  const cx = grande.x0 + w * 0.88, cy = grande.y0 + h * 0.12;
  window.__viewerFijarVista({ zoom, panX: c.clientWidth / 2 - cx * zoom, panY: c.clientHeight / 2 - cy * zoom });
});
await new Promise((r) => setTimeout(r, 3000));

await page.tracing.stop();
await browser.close();

// --- Parseo del trace ---------------------------------------------------
const raw = JSON.parse(await readFile(traceFile, "utf8"));
const eventos = raw.traceEvents ?? raw;

// El hilo principal del renderer: se identifica por el metadato thread_name.
const hilosPrincipales = new Set();
for (const e of eventos) {
  if (e.name === "thread_name" && e.args?.name === "CrRendererMain") hilosPrincipales.add(e.tid);
}

// Eventos completos ('X') con duracion, del hilo principal, mayores al
// umbral. Se agrupan por nombre para ver que TIPO de trabajo domina.
const largos = eventos.filter(
  (e) => e.ph === "X" && hilosPrincipales.has(e.tid) && (e.dur ?? 0) / 1000 >= UMBRAL_MS
);

const porNombre = new Map();
for (const e of largos) {
  const ms = e.dur / 1000;
  const clave = e.name;
  const acc = porNombre.get(clave) ?? { n: 0, sumaMs: 0, maxMs: 0 };
  acc.n++;
  acc.sumaMs += ms;
  acc.maxMs = Math.max(acc.maxMs, ms);
  porNombre.set(clave, acc);
}

const filas = [...porNombre.entries()].sort((a, b) => b[1].sumaMs - a[1].sumaMs);
console.log(`\nEventos del hilo principal >= ${UMBRAL_MS}ms, agrupados por nombre:\n`);
console.log("nombre".padEnd(32), "n".padStart(4), "suma(ms)".padStart(10), "max(ms)".padStart(10));
for (const [nombre, s] of filas.slice(0, 20)) {
  console.log(nombre.padEnd(32), String(s.n).padStart(4), s.sumaMs.toFixed(1).padStart(10), s.maxMs.toFixed(1).padStart(10));
}

// Los 8 eventos individuales mas largos, con su stack de nombres padre (si
// el trace lo trae) para ubicar el llamador real, no solo la primitiva.
const top = [...largos].sort((a, b) => b.dur - a.dur).slice(0, 8);
console.log("\nLos eventos individuales mas largos:");
for (const e of top) {
  const args = e.args?.data ? JSON.stringify(e.args.data).slice(0, 160) : "";
  console.log(`  ${(e.dur / 1000).toFixed(1)}ms  ${e.name}  ${args}`);
}

console.log(`\nTrace completo (abrir en chrome://tracing o DevTools Performance): ${traceFile}`);
