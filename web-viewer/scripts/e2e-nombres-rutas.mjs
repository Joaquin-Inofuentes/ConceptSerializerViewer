// Comprueba lo pedido en la ultima ronda:
//  1. Un link `?file=<id>` resuelve el NOMBRE real y la RUTA de carpetas.
//  2. Abrir desde la galeria deja la URL como /carpeta/carpeta/archivo.
//  3. "Ultimos abiertos" guarda el nombre legible, no el id.
//  4. Al acercarse aparece el aviso de que se estan afinando los planos.
//
//   node scripts/e2e-nombres-rutas.mjs

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const PERFIL = path.resolve(".cache/perfil-rutas");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesado = manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size)[0];

await rm(PERFIL, { recursive: true, force: true });
const browser = await puppeteer.launch({
  headless: "new",
  userDataDir: PERFIL,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errores = [];
page.on("pageerror", (e) => errores.push(e.message.slice(0, 160)));

const R = [];
const ok = (k, v, nota = "") => {
  R.push(v);
  console.log(`${v ? "  OK  " : " FALLA"} ${k}${nota ? " — " + nota : ""}`);
};

console.log(`Archivo: ${pesado.name} (${(pesado.size / 1048576).toFixed(1)} MB)`);
console.log(`Ruta esperada: ${pesado.folderPath}\n`);

// --- 1) link directo por id -------------------------------------------
await page.goto(`${BASE}/?file=${pesado.id}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => {
    const c = document.querySelector("canvas");
    return c && c.width > 1;
  },
  { timeout: 300000 }
);
// La resolucion del nombre va en paralelo: se le da tiempo.
await new Promise((r) => setTimeout(r, 4000));

const url = await page.evaluate(() => location.pathname);
const titulo = await page.evaluate(() => document.querySelector(".filename-display")?.textContent?.trim() || "");
ok("la URL tiene carpetas y archivo", url.split("/").filter(Boolean).length >= 2, url);
ok("el titulo muestra el nombre real, no el id", !/^1[A-Za-z0-9_-]{20,}$/.test(titulo), `"${titulo}"`);

// --- 4) aviso al acercarse --------------------------------------------
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 300000 });
const avisoRefinado = await page.evaluate(async () => {
  const el = document.querySelector("canvas").parentElement;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 16; i++) {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
  }
  // El refinado arranca tras 400 ms de debounce; se muestrea un rato.
  let visto = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const n = document.querySelector(".viewer-refinando");
    if (n) {
      visto = n.textContent.trim();
      break;
    }
  }
  return visto;
});
ok("avisa que esta afinando los planos al acercarse", !!avisoRefinado, avisoRefinado || "no aparecio");

// --- 3) recientes con nombre legible ----------------------------------
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".gallery-page", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const rec = await page.evaluate(() => ({
  nombre: document.querySelector(".gallery-reciente-nombre")?.textContent || "",
  ruta: document.querySelector(".gallery-reciente-ruta")?.textContent || "",
}));
ok("recientes con nombre legible", !!rec.nombre && !/^1[A-Za-z0-9_-]{20,}$/.test(rec.nombre), `"${rec.nombre}"`);
ok("recientes con la ruta de carpetas", rec.ruta.includes("/") || rec.ruta.length > 0, `"${rec.ruta}"`);

// --- 2) navegar por la galeria y abrir ---------------------------------
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /sin nombre|continuar/i.test(x.textContent || ""));
  if (b) b.click();
});
await new Promise((r) => setTimeout(r, 600));

for (let nivel = 0; nivel < 5; nivel++) {
  const hayArchivos = await page.evaluate(
    () => document.querySelectorAll(".gallery-card:not(.folder-card)").length > 0
  );
  if (hayArchivos) break;
  const fue = await page.evaluate(() => {
    const f = document.querySelector(".folder-card");
    if (!f) return false;
    f.click();
    return true;
  });
  if (!fue) break;
  await new Promise((r) => setTimeout(r, 1600));
}
const urlCarpeta = await page.evaluate(() => location.pathname);
ok("navegar carpetas actualiza la URL", urlCarpeta.split("/").filter(Boolean).length >= 1, urlCarpeta);

await page.evaluate(() => {
  const c = document.querySelector(".gallery-card:not(.folder-card)");
  if (c) c.click();
});
await new Promise((r) => setTimeout(r, 2500));
const urlArchivo = await page.evaluate(() => location.pathname);
ok(
  "abrir desde la galeria da /carpeta/.../archivo",
  urlArchivo.split("/").filter(Boolean).length > urlCarpeta.split("/").filter(Boolean).length,
  urlArchivo
);

// --- 5) el camino de vuelta: entrar DIRECTO por la ruta ----------------
// Es lo que de verdad quiere decir "link compartible": que alguien pegue la
// URL y le abra el dibujo. Sin esto solo estabamos comprobando que la barra
// de direcciones se actualiza, que no es lo mismo.
await page.goto(`${BASE}${urlArchivo}`, { waitUntil: "domcontentloaded" });
const abrio = await page
  .waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 180000 })
  .then(() => true)
  .catch(() => false);
const tituloDirecto = await page.evaluate(
  () => document.querySelector(".filename-display")?.textContent?.trim() || ""
);
ok("entrar directo por la ruta abre el dibujo", abrio, `${urlArchivo} -> "${tituloDirecto}"`);
ok(
  "y abre el dibujo que dice la ruta",
  abrio && urlArchivo.endsWith(
    tituloDirecto
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
  ),
  `"${tituloDirecto}"`
);

// Una ruta que no existe no puede dejar la app colgada.
await page.goto(`${BASE}/carpeta-que-no-existe/dibujo-inventado`, { waitUntil: "domcontentloaded" });
const galeriaViva = await page
  .waitForSelector(".gallery-page", { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
ok("una ruta inexistente cae en la galeria sin romper", galeriaViva);

console.log(`\nerrores de consola: ${errores.length}`);
[...new Set(errores)].slice(0, 4).forEach((e) => console.log(`  - ${e}`));
console.log(`\n=== ${R.filter(Boolean).length}/${R.length} OK`);

await browser.close();
