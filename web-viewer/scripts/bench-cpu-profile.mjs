// Perfil de CPU (CDP Profiler) durante apertura + zoom, para saber exactamente
// que FUNCION consume el hilo principal cuando `bench-trace-largos.mjs`
// encuentra un "HandlePostMessage"/RunTask larguisimo que el propio dibujado
// de Viewer.tsx no explica. El trace de eventos solo dice "algo tardo 195ms
// adentro de un postMessage"; el CPU profile dice EN QUE FUNCION, por self
// time, sin adivinar.
//
//   node scripts/bench-cpu-profile.mjs [driveFileId]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/trace");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");
const FILE_ID = process.argv[2];

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

const cdp = await page.createCDPSession();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); // 0.1ms
await cdp.send("Profiler.start");

await page.goto(`${BASE}/?tier=alta&file=${target.id}&origen=${encodeURIComponent(ORIGEN)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

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

const { profile } = await cdp.send("Profiler.stop");
await browser.close();

await writeFile(path.join(OUT, `cpuprofile-${target.id.slice(0, 8)}.cpuprofile`), JSON.stringify(profile));

// --- Self-time por nodo (funcion + archivo:linea) -----------------------
const porId = new Map(profile.nodes.map((n) => [n.id, n]));
const idxNodo = new Map(profile.nodes.map((n, i) => [n.id, i]));
const muestras = profile.samples;
const deltas = profile.timeDeltas;

// timeDeltas[i] es el tiempo ENTRE la muestra i y la i+1; se le imputa a la
// muestra i (el nodo activo durante ese hueco).
const selfUs = new Map();
for (let i = 0; i < muestras.length; i++) {
  const dt = deltas[i] ?? 0;
  const id = muestras[i];
  selfUs.set(id, (selfUs.get(id) ?? 0) + dt);
}

const filas = [...selfUs.entries()]
  .map(([id, us]) => {
    const n = porId.get(id);
    const cf = n?.callFrame ?? {};
    const nombre = cf.functionName || "(anonima)";
    const archivo = (cf.url || "").split("/").slice(-2).join("/");
    return { nombre, archivo, linea: cf.lineNumber, ms: us / 1000 };
  })
  .sort((a, b) => b.ms - a.ms);

// Agrupado por funcion+archivo (self time sumado entre distintas call-sites
// del mismo codigo, por ejemplo un helper llamado desde varios lugares).
const agrupado = new Map();
for (const f of filas) {
  const clave = `${f.nombre} @ ${f.archivo}:${f.linea}`;
  agrupado.set(clave, (agrupado.get(clave) ?? 0) + f.ms);
}
const top = [...agrupado.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

console.log("\nSelf-time (hilo principal, agrupado por funcion) durante apertura+zoom:\n");
console.log("ms".padStart(9), " funcion");
for (const [clave, ms] of top) {
  console.log(ms.toFixed(1).padStart(9), " " + clave);
}

const totalMs = [...selfUs.values()].reduce((a, b) => a + b, 0) / 1000;
console.log(`\nTotal muestreado en el hilo principal: ${totalMs.toFixed(0)}ms`);
console.log(`.cpuprofile guardado (cargable en DevTools > Performance > Load profile): ${path.join(OUT, `cpuprofile-${target.id.slice(0, 8)}.cpuprofile`)}`);
