// CPU profile durante la MISMA secuencia de gestos reales que
// bench-fluidez.mjs (wheel + drag + wheel), bajo CPU frenada, para atribuir
// por funcion los picos que aparecen en la fase de asentado/refinado.
//
//   node scripts/bench-cpu-gesto-real.mjs <driveFileId> [--throttle 4]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/trace");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");
const args = process.argv.slice(2);
const throttleIdx = args.indexOf("--throttle");
const THROTTLE = throttleIdx >= 0 ? Number(args[throttleIdx + 1]) : 4;
const FILE_ID = args.find((a) => !a.startsWith("--") && a !== String(THROTTLE));

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const target = manifest.files.find((f) => f.id === FILE_ID);
if (!target) throw new Error("archivo no encontrado en el corpus local");

console.log(`Archivo: ${target.name} (${(target.size / 1048576).toFixed(1)} MB), throttle x${THROTTLE}`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);

const cdp = await page.createCDPSession();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

await page.goto(`${BASE}/?tier=alta&file=${target.id}&origen=${encodeURIComponent(ORIGEN)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

const canvasBox = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");

// Misma secuencia que bench-fluidez.mjs.
await page.mouse.move(canvasBox.x, canvasBox.y);
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel({ deltaY: -120 });
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.move(canvasBox.x, canvasBox.y);
await page.mouse.down();
for (let i = 0; i < 20; i++) {
  await page.mouse.move(canvasBox.x - i * 12, canvasBox.y - i * 6, { steps: 3 });
  await new Promise((r) => setTimeout(r, 16));
}
await page.mouse.up();
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel({ deltaY: 120 });
  await new Promise((r) => setTimeout(r, 30));
}
await new Promise((r) => setTimeout(r, 3000));

const { profile } = await cdp.send("Profiler.stop");
await browser.close();

await writeFile(path.join(OUT, `cpuprofile-gesto-${target.id.slice(0, 8)}.cpuprofile`), JSON.stringify(profile));

const porId = new Map(profile.nodes.map((n) => [n.id, n]));
const selfUs = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] ?? 0;
  const id = profile.samples[i];
  selfUs.set(id, (selfUs.get(id) ?? 0) + dt);
}
const filas = [...selfUs.entries()].map(([id, us]) => {
  const cf = porId.get(id)?.callFrame ?? {};
  return { nombre: cf.functionName || "(anonima)", archivo: (cf.url || "").split("/").slice(-2).join("/"), linea: cf.lineNumber, ms: us / 1000 };
});
const agrupado = new Map();
for (const f of filas) {
  const clave = `${f.nombre} @ ${f.archivo}:${f.linea}`;
  agrupado.set(clave, (agrupado.get(clave) ?? 0) + f.ms);
}
const top = [...agrupado.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log("\nSelf-time (hilo principal) durante la secuencia de gestos reales:\n");
for (const [clave, ms] of top) console.log(ms.toFixed(1).padStart(9), " " + clave);
console.log(`\ncpuprofile: ${path.join(OUT, `cpuprofile-gesto-${target.id.slice(0, 8)}.cpuprofile`)}`);
