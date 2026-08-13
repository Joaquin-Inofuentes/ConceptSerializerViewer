// Mide el ARRANQUE del build de produccion (dist/) como en un telefono de
// gama baja: CPU throttling + red movil emulada + viewport de telefono.
// Reporta FCP, DOMContentLoaded, JS transferido/ejecutado y cuanto tarda en
// verse la galeria (skeleton = React ya monto).
//
//   node scripts/bench-arranque.mjs            (6x CPU, Fast 3G)
//   THROTTLE=8 NET=3g node scripts/bench-arranque.mjs

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import path from "node:path";
import puppeteer from "puppeteer";

const DIST = path.resolve("dist");
const PORT = 8793;
const THROTTLE = Number(process.env.THROTTLE || 6);
// Fast 3G de DevTools: 1.6 Mbps down, 750 kbps up, 150 ms RTT.
const NETS = {
  "3g": { downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (750e3 / 8) * 0.9, latency: 150 },
  "4g": { downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9, latency: 60 },
};
const NET = NETS[process.env.NET || "3g"];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Gzip como haria Vercel/cualquier CDN: medir la red con JS sin comprimir
// triplicaria el tiempo de descarga respecto de produccion real.
const gzCache = new Map();
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const enviar = (data, type) => {
    const comprimible = /text|javascript|css|svg|html/.test(type);
    if (comprimible && (req.headers["accept-encoding"] || "").includes("gzip")) {
      let gz = gzCache.get(p);
      if (!gz) {
        gz = gzipSync(data);
        gzCache.set(p, gz);
      }
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", "Content-Length": gz.length });
      return res.end(gz);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  };
  try {
    const data = await readFile(path.join(DIST, p));
    enviar(data, MIME[path.extname(p)] || "application/octet-stream");
  } catch {
    // SPA fallback
    try {
      const data = await readFile(path.join(DIST, "index.html"));
      enviar(data, "text/html");
    } catch {
      res.writeHead(404);
      res.end();
    }
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NET });
await page.emulateCPUThrottling(THROTTLE);

let jsBytes = 0;
let totalBytes = 0;
const porRecurso = [];
cdp.on("Network.loadingFinished", () => {});
cdp.on("Network.responseReceived", (e) => {
  porRecurso.push({ url: e.response.url, type: e.type });
});
page.on("response", async (res) => {
  try {
    const buf = await res.buffer();
    totalBytes += buf.length;
    if (res.url().endsWith(".js") || res.url().endsWith(".mjs")) jsBytes += buf.length;
  } catch {
    /* respuestas opacas */
  }
});

console.log(`Arranque produccion — CPU ${THROTTLE}x, red ${process.env.NET || "3g"} (Fast 3G por defecto), 360x700`);
const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
const dcl = Date.now() - t0;

// La galeria "existe" cuando aparece la grilla (aunque sea el skeleton):
// React ya parseo, ejecuto y monto.
await page.waitForSelector(".gallery-page", { timeout: 120000 });
const gallery = Date.now() - t0;

// Miniaturas reales visibles. La raiz de la carpeta de Drive solo tiene
// SUBCARPETAS, asi que hay que entrar a una para que haya tarjetas con
// miniatura; medir en la raiz daba un falso ">60 s".
let thumbs = null;
let navegacion = null;
try {
  await page.waitForFunction(() => document.querySelectorAll(".folder-card").length > 0, {
    timeout: 60000,
  });
  const tNav = Date.now();
  // Baja por el arbol hasta encontrar una carpeta que tenga archivos.
  for (let nivel = 0; nivel < 4; nivel++) {
    const hayArchivos = await page.evaluate(
      () => document.querySelectorAll(".gallery-card:not(.folder-card)").length > 0
    );
    if (hayArchivos) break;
    const clicked = await page.evaluate(() => {
      const f = document.querySelector(".folder-card");
      if (!f) return false;
      f.click();
      return true;
    });
    if (!clicked) break;
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".gallery-card:not(.folder-card)").length > 0 ||
        document.querySelectorAll(".folder-card").length > 0,
      { timeout: 60000 }
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  navegacion = Date.now() - tNav;
  await page.waitForFunction(
    () => {
      const im = document.querySelector(".gallery-thumb img");
      return im && im.complete && im.naturalWidth > 0;
    },
    { timeout: 60000 }
  );
  thumbs = Date.now() - tNav;
} catch {
  /* sin thumbs en 60s */
}

const perf = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const recursos = performance.getEntriesByType("resource").map((r) => ({
    name: r.name.split("/").pop().split("?")[0],
    ms: Math.round(r.duration),
    kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024),
  }));
  const longtasks = [];
  return {
    fcp: fcp ? Math.round(fcp.startTime) : null,
    domInteractive: nav ? Math.round(nav.domInteractive) : null,
    recursos: recursos.sort((a, b) => b.ms - a.ms).slice(0, 8),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
});

console.log(`  FCP ${perf.fcp}ms | domInteractive ${perf.domInteractive}ms | DCL ${dcl}ms`);
console.log(
  `  Galeria montada (skeleton): ${gallery}ms | navegar a carpeta con archivos: ${navegacion ?? "-"}ms | primeras miniaturas: ${thumbs ?? ">60000"}ms`
);
console.log(`  JS transferido: ${(jsBytes / 1024).toFixed(0)}KB | total: ${(totalBytes / 1024).toFixed(0)}KB | heap tras cargar: ${perf.heapMB}MB`);
console.log("  Recursos mas lentos:");
perf.recursos.forEach((r) => console.log(`    ${r.ms}ms  ${r.kb}KB  ${r.name}`));

await browser.close();
server.close();
