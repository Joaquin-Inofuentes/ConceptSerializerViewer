// Captura UN recurso concreto encuadrado en pantalla, para comparar como se
// dibuja antes y despues de un cambio.
//   node scripts/cap-recurso.mjs <fileId> <prefijoResourceId> <etiqueta>
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const OUT = path.resolve(".cache/fotos");
const [ID, PREF, LABEL] = process.argv.slice(2);
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", e => console.error("[err]", e.message.slice(0,160)));
await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
await page.goto(`http://localhost:5173/?tier=alta&file=${ID}&origen=${encodeURIComponent("http://127.0.0.1:8788")}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 }).catch(()=>{});
await new Promise(r => setTimeout(r, 9000));
const info = await page.evaluate((pref) => {
  const cajas = window.__viewerCajas();
  const c = cajas.find(x => x.resourceId.startsWith(pref));
  if (!c) return { error: "no encontre el recurso", ids: cajas.map(x=>x.resourceId.slice(0,8)) };
  const canvas = document.querySelector("canvas");
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  const zoom = Math.min(canvas.clientWidth / (w*1.25), canvas.clientHeight / (h*1.25));
  window.__viewerFijarVista({ zoom,
    panX: canvas.clientWidth/2 - ((c.x0+c.x1)/2)*zoom,
    panY: canvas.clientHeight/2 - ((c.y0+c.y1)/2)*zoom });
  return { caja: c, w: +w.toFixed(0), h: +h.toFixed(0), aspectoCaja: +(w/h).toFixed(3) };
}, PREF);
if (info.error) { console.error(info.error, info.ids); await browser.close(); process.exit(1); }
await new Promise(r => setTimeout(r, 9000));
const f = path.join(OUT, `${LABEL}.png`);
await page.screenshot({ path: f });
console.log(`${LABEL}: caja ${info.w}x${info.h} aspecto ${info.aspectoCaja} -> ${f}`);
await browser.close();
