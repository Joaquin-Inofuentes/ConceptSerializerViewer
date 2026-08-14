// ¿QUE bloquea el hilo principal mientras se panea y se hace zoom?
//
// Toma un perfil de CPU real durante la tanda de gestos y lo resume por
// funcion (tiempo propio, sin contar lo que llaman). Es la unica forma de
// dejar de suponer: los tirones se sienten en el render loop, pero la causa
// casi siempre esta en otro lado (codificar JPEG, IndexedDB, React).
//
//   ORIGEN=http://127.0.0.1:8788 node scripts/perfil-gestos.mjs

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/perfil-gestos");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";
const THROTTLE = Number(process.env.THROTTLE || 6);
const TIER = process.env.TIER || "baja";
/** "carga" perfila la apertura; "gestos" perfila el pan/zoom. */
const FASE = process.env.FASE || "gestos";

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const f = process.argv[2]
  ? manifest.files.find((x) => x.id === process.argv[2])
  : manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[0];

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const cli = await page.createCDPSession();
await cli.send("Profiler.enable");
await cli.send("Profiler.setSamplingInterval", { interval: 200 });

const url = `${BASE}/?tier=${TIER}&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`;
console.log(`${f.name} — ${(f.size / 1048576).toFixed(1)} MB — perfilando fase "${FASE}"`);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.emulateCPUThrottling(THROTTLE);

if (FASE === "carga") {
  await cli.send("Profiler.start");
  await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 });
} else {
  await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
  await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await cli.send("Profiler.start");
  await page.evaluate(async () => {
    const el = document.querySelector("canvas").parentElement;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const toque = (tipo, puntos) => {
      const touches = puntos.map((p, i) => new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y }));
      el.dispatchEvent(
        new TouchEvent(tipo, {
          touches: tipo === "touchend" ? [] : touches,
          targetTouches: tipo === "touchend" ? [] : touches,
          changedTouches: touches,
          bubbles: true,
          cancelable: true,
        })
      );
    };
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let s = 0; s < 8; s++) {
      toque("touchstart", [{ x: cx, y: cy }]);
      for (let i = 0; i < 12; i++) {
        toque("touchmove", [
          { x: cx + Math.sin((s + i / 12) * 2.4) * 170, y: cy + Math.cos((s + i / 12) * 3.1) * 170 },
        ]);
        await esperar(16);
      }
      toque("touchend", [{ x: cx, y: cy }]);
      await esperar(30);
    }
    for (let z = 0; z < 6; z++) {
      toque("touchstart", [
        { x: cx - 60, y: cy },
        { x: cx + 60, y: cy },
      ]);
      for (let i = 1; i <= 12; i++) {
        const sep = z % 2 === 0 ? 60 + i * 18 : Math.max(12, 240 - i * 18);
        toque("touchmove", [
          { x: cx - sep, y: cy },
          { x: cx + sep, y: cy },
        ]);
        await esperar(16);
      }
      toque("touchend", [{ x: cx, y: cy }]);
      await esperar(40);
    }
    await esperar(2000);
  });
}

const { profile } = await cli.send("Profiler.stop");

// --- Resumen por funcion: tiempo PROPIO -----------------------------------
const porNodo = new Map(profile.nodes.map((n) => [n.id, n]));
const propio = new Map();
const total = profile.timeDeltas.reduce((a, b) => a + Math.max(0, b), 0);
for (let i = 0; i < profile.samples.length; i++) {
  const dt = Math.max(0, profile.timeDeltas[i] || 0);
  const n = porNodo.get(profile.samples[i]);
  if (!n) continue;
  const cf = n.callFrame;
  const archivo = (cf.url || "").split("/").slice(-1)[0].split("?")[0];
  const clave = `${cf.functionName || "(anonima)"}  ${archivo}:${cf.lineNumber + 1}`;
  propio.set(clave, (propio.get(clave) || 0) + dt);
}

const filas = [...propio.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
console.log(`\nperfil de ${(total / 1000).toFixed(1)} s de hilo principal\n`);
console.log("   ms     %   funcion");
for (const [clave, us] of filas) {
  const ms = us / 1000;
  if (ms < 1) continue;
  console.log(`${ms.toFixed(0).padStart(6)}  ${((us / total) * 100).toFixed(1).padStart(5)}  ${clave}`);
}

// Agrupado por archivo, que suele decir mas que la funcion suelta.
const porArchivo = new Map();
for (const [clave, us] of propio) {
  const arch = clave.split("  ").pop().split(":")[0] || "(sin archivo)";
  porArchivo.set(arch, (porArchivo.get(arch) || 0) + us);
}
console.log(`\npor archivo:`);
[...porArchivo.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([a, us]) => console.log(`${(us / 1000).toFixed(0).padStart(6)}  ${((us / total) * 100).toFixed(1).padStart(5)}  ${a}`));

await writeFile(path.join(OUT, `${FASE}.cpuprofile`), JSON.stringify(profile));
console.log(`\nperfil crudo en .cache/perfil-gestos/${FASE}.cpuprofile`);
await browser.close();
