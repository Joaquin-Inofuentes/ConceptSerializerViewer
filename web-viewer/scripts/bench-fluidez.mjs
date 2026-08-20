// Mide fluidez con GESTOS REALES (wheel + drag de mouse, no teleports de
// __viewerFijarVista) bajo CPU frenada, en los archivos MAS PESADOS del
// corpus. Es el escenario que le importa al usuario: panear/zoomear en el
// dibujo mas pesado, en el peor hardware, sin que trabe.
//
// Separa dos fases porque tienen presupuestos MUY distintos:
//   - GESTO ACTIVO: mientras se arrastra/rueda, Viewer.tsx mueve el canvas
//     entero con un transform CSS (ver aplicarTransformGesto) — el
//     compositor de la GPU hace el trabajo, cero redibujado. Deberia costar
//     ~0 en el hilo principal pase lo que pase con el dibujo.
//   - ASENTADO: 250ms despues del ultimo movimiento, se redibuja UNA vez a
//     resolucion real y se pide el refinado (rasterizar mas nitido lo que
//     quedo en pantalla). Ahi SI hay trabajo real, y es lo que puede trabar.
//
//   node scripts/bench-fluidez.mjs [--throttle 4] [--json salida.json]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = (process.env.ORIGEN || "http://127.0.0.1:8788").replace(/\/+$/, "");

const args = process.argv.slice(2);
const throttleIdx = args.indexOf("--throttle");
const THROTTLE = throttleIdx >= 0 ? Number(args[throttleIdx + 1]) : 4;
const RED_LENTA = args.includes("--red-lenta");
const jsonIdx = args.indexOf("--json");
const JSON_OUT = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const soloIds = args.filter((a) => !a.startsWith("--") && a !== String(THROTTLE) && a !== JSON_OUT);

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = soloIds.length
  ? soloIds.map((id) => manifest.files.find((f) => f.id === id)).filter(Boolean)
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, 3);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  protocolTimeout: 300000,
});

const INYECTAR_SAMPLER = () => {
  window.__bench = { muestras: [] };
  let anterior = performance.now();
  const loop = () => {
    const ahora = performance.now();
    const s = window.__viewerStats?.();
    window.__bench.muestras.push({
      t: ahora,
      hueco: ahora - anterior,
      total: s ? s.ultimoFrameMs : 0,
      refinando: !!window.__viewerRefinando,
    });
    anterior = ahora;
    window.__bench.raf = requestAnimationFrame(loop);
  };
  window.__bench.raf = requestAnimationFrame(loop);
};

const resultados = [];

for (const f of objetivos) {
  console.log(`\n${"=".repeat(70)}\n${f.name} (${(f.size / 1048576).toFixed(1)} MB)\n${"=".repeat(70)}`);
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message.slice(0, 200)));

  // CPU frenada: "las peores condiciones" que pidio el usuario. 4x es un
  // telefono de gama media-baja tipico; el corpus real se abre en tablets
  // de obra, no en desktops.
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  // Red tambien frenada, no solo CPU: una tablet de obra rara vez tiene wifi
  // buena. Sin esto, el servidor local de corpus (disco, sin latencia real)
  // no reproduce el escenario que de verdad importa: bytes que tardan en
  // llegar MIENTRAS la CPU esta ademas ocupada rasterizando.
  if (RED_LENTA) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: (1.5 * 1024 * 1024) / 8, // ~1.5 Mbps, "Slow 4G"
      uploadThroughput: (750 * 1024) / 8,
      latency: 80,
    });
  }

  await page.goto(`${BASE}/?tier=alta&file=${f.id}&origen=${encodeURIComponent(ORIGEN)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
  await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  await page.evaluate(INYECTAR_SAMPLER);

  const canvasBox = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });

  // --- Secuencia de gestos reales -----------------------------------------
  // 1) Zoom con rueda del mouse: 10 pasos, hacia el mismo punto (como
  //    alguien acercandose con el trackpad/mouse a un detalle).
  await page.mouse.move(canvasBox.x, canvasBox.y);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel({ deltaY: -120 });
    await new Promise((r) => setTimeout(r, 30));
  }
  // 2) Arrastre continuo: 20 pasos, simulando un pan largo con el mouse
  //    apretado (lo que el usuario hace para recorrer un plano).
  await page.mouse.move(canvasBox.x, canvasBox.y);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(canvasBox.x - i * 12, canvasBox.y - i * 6, { steps: 3 });
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up();
  // 3) Zoom de nuevo, alejandose (rueda al reves) mientras el refinado
  //    anterior puede seguir en curso: el peor caso de solapamiento.
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise((r) => setTimeout(r, 30));
  }
  // Se espera a que asiente del todo (redibujado + refinado final).
  await new Promise((r) => setTimeout(r, 3000));

  const { muestras, tiempos, viewerStats } = await page.evaluate(() => {
    cancelAnimationFrame(window.__bench.raf);
    return {
      muestras: window.__bench.muestras.slice(1),
      tiempos: window.__viewerStats?.().tiempos,
      viewerStats: window.__viewerStats?.(),
    };
  });
  console.log(
    `  atribucion (Gallery/renderCore.ts tiempos, acumulado TODA la sesion): ` +
      `cache=${tiempos?.cacheMs?.toFixed(0)}ms bytes=${tiempos?.bytesMs?.toFixed(0)}ms ` +
      `raster=${tiempos?.rasterMs?.toFixed(0)}ms enMain=${tiempos?.enMain ?? 0}(${tiempos?.enMainMs?.toFixed(0)}ms) n=${tiempos?.n ?? 0}`
  );
  console.log(
    `  cache persistente: aciertos=${viewerStats?.cache?.aciertos ?? 0} fallos=${viewerStats?.cache?.fallos ?? 0} adelantos=${viewerStats?.cache?.adelantos ?? 0}`
  );
  await page.close();

  // --- Separar gesto activo (deberia ser gratis) de asentado --------------
  // Se aproxima con `refinando`: durante un gesto activo Viewer.tsx no
  // dispara refinado, asi que `refinando=false` cubre tanto "en medio del
  // gesto" como "recien asentado, sincronizando" — para distinguir mejor se
  // usa ademas un margen de 300ms alrededor de cada muestra con
  // `refinando=true` (el refinado avisa DESPUES de arrancar, asi que el
  // primer frame pesado de la rasterizacion cae justo antes del aviso).
  const tRefinando = new Set();
  muestras.forEach((m, i) => {
    if (m.refinando) {
      for (let j = Math.max(0, i - 20); j <= Math.min(muestras.length - 1, i + 5); j++) tRefinando.add(j);
    }
  });
  const activo = muestras.filter((_, i) => !tRefinando.has(i));
  const asentado = muestras.filter((_, i) => tRefinando.has(i));

  const stats = (arr) => {
    if (!arr.length) return { n: 0, media: 0, p95: 0, max: 0 };
    const s = [...arr].sort((a, b) => a - b);
    return {
      n: s.length,
      media: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
      p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
      max: +s[s.length - 1].toFixed(2),
    };
  };

  const huecoActivo = stats(activo.map((m) => m.hueco));
  const huecoAsentado = stats(asentado.map((m) => m.hueco));
  const sobre50Activo = activo.filter((m) => m.hueco > 50).length;
  const sobre100Asentado = asentado.filter((m) => m.hueco > 100).length;

  console.log(`  frames durante GESTO ACTIVO (deberia ser ~vsync, sin trabajo): ${huecoActivo.n}`);
  console.log(`    media ${huecoActivo.media}ms  p95 ${huecoActivo.p95}ms  max ${huecoActivo.max}ms  | >50ms: ${sobre50Activo}`);
  console.log(`  frames durante ASENTADO/REFINADO (aca vive el trabajo real): ${huecoAsentado.n}`);
  console.log(`    media ${huecoAsentado.media}ms  p95 ${huecoAsentado.p95}ms  max ${huecoAsentado.max}ms  | >100ms: ${sobre100Asentado}`);
  if (errores.length) console.log("  errores de pagina:", errores);

  resultados.push({
    archivo: f.name,
    id: f.id,
    throttle: THROTTLE,
    huecoActivo,
    huecoAsentado,
    sobre50Activo,
    sobre100Asentado,
    errores,
  });
}

await browser.close();

console.log(`\n${"=".repeat(70)}\nRESUMEN\n${"=".repeat(70)}`);
let hayProblema = false;
for (const r of resultados) {
  const okActivo = r.sobre50Activo === 0;
  const okAsentado = r.huecoAsentado.max < 500; // referencia laxa, se afina con las iteraciones
  console.log(
    `${okActivo && okAsentado ? "OK  " : "OJO "} ${r.archivo}: ` +
      `gesto activo max=${r.huecoActivo.max}ms (${r.sobre50Activo} > 50ms) | asentado max=${r.huecoAsentado.max}ms`
  );
  if (!okActivo || !okAsentado) hayProblema = true;
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify(resultados, null, 1));
  console.log(`\nJSON guardado en ${JSON_OUT}`);
}

process.exit(hayProblema ? 1 : 0);
