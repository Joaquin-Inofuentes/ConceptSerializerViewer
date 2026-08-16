// Captura una ruta del visor y la deja al lado del thumb.jpg que trae el
// propio archivo (el render oficial de Concepts), para comparar a ojo.
//
// La ruta se pasa por argumento, NO por variable de entorno: en Git Bash sobre
// Windows, MSYS convierte cualquier valor que empiece con "/" en una ruta de
// Windows ("C:/Program Files/..."), y el script terminaba navegando a una URL
// invalida.
//
//   node scripts/cap-comparar.mjs /fede-y-franco/concepts/ho/drawing [etiqueta]
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import puppeteer from "puppeteer";

const RUTA = process.argv[2] || "/fede-y-franco/concepts/ho/drawing";
const ETIQ = process.argv[3] || "actual";
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const OUT = path.resolve(".cache/comparar");
await mkdir(OUT, { recursive: true });

// --- thumb.jpg oficial del archivo correspondiente, si esta en el corpus ---
function slug(n) {
  return (n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.concepts$/i, "").trim()
    .replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase()) || "sin-nombre";
}
try {
  const man = JSON.parse(readFileSync(".cache/concepts/manifest.json", "utf8"));
  const hit = man.files.find((f) => {
    const partes = (f.folderPath || "").split("/").filter((p) => p && p.toLowerCase() !== "inicio");
    return "/" + [...partes.map(slug), slug(f.name)].join("/") === RUTA;
  });
  if (hit && existsSync(hit.localPath)) {
    const buf = readFileSync(hit.localPath);
    let eo = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
    const n = buf.readUInt16LE(eo + 10); let off = buf.readUInt32LE(eo + 16);
    for (let k = 0; k < n; k++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
      const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
      const lho = buf.readUInt32LE(off + 42);
      const nombre = buf.toString("utf8", off + 46, off + 46 + nl);
      if (/thumb\.jpe?g$/i.test(nombre)) {
        const nl2 = buf.readUInt16LE(lho + 26), el2 = buf.readUInt16LE(lho + 28), s = lho + 30 + nl2 + el2;
        const raw = buf.subarray(s, s + csize);
        await writeFile(path.join(OUT, "0-thumb-oficial.jpg"), method === 0 ? raw : inflateRawSync(raw));
        console.log("thumb oficial ->", path.join(OUT, "0-thumb-oficial.jpg"), `(${hit.name})`);
        break;
      }
      off += 46 + nl + el + cl;
    }
  }
} catch (e) { console.log("(sin thumb oficial:", e.message.slice(0, 60) + ")"); }

// --- captura del visor ---
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const p = await b.newPage();
p.setDefaultTimeout(300000);
await p.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });

const t0 = Date.now();
await p.goto(BASE + RUTA, { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => { const c = document.querySelector("canvas"); return c && c.width > 1; }, { timeout: 300000 });
await p.screenshot({ path: path.join(OUT, `1-${ETIQ}-trazos.png`) });
try { await p.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 }); } catch {}
await new Promise((r) => setTimeout(r, 2500));
await p.screenshot({ path: path.join(OUT, `2-${ETIQ}-completo.png`) });

const px = await p.evaluate(() => {
  const c = document.querySelector("canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let nf = 0; const col = new Set();
  for (let i = 0; i < d.length; i += 4 * 53) {
    const r = d[i], g = d[i + 1], bb = d[i + 2];
    col.add((r >> 4) << 8 | (g >> 4) << 4 | (bb >> 4));
    if (!(r > 245 && g > 245 && bb > 245) && !(r < 32 && g < 34 && bb < 40)) nf++;
  }
  return { pct: +((nf / Math.floor(d.length / (4 * 53))) * 100).toFixed(1), colores: col.size };
});
const st = await p.evaluate(() => (window.__viewerStats ? window.__viewerStats() : null));
console.log(`\nURL: ${BASE}${RUTA}   (${Date.now() - t0} ms)`);
console.log(`canvas: ${px.pct}% con contenido, ${px.colores} colores`);
if (st) console.log(`stats: ${JSON.stringify(st)}`);
console.log(errs.length ? `errores: ${[...new Set(errs)].slice(0, 4).join(" | ")}` : "sin errores");
console.log(`capturas -> ${OUT}`);
await b.close();
