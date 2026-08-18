// Confirma que navegar carpetas en la galeria actualiza la URL (rutas.ts /
// App.tsx `alCambiarRutaCarpeta`) y que esa URL, visitada directo (sin pasar
// por la galeria), reconstruye la misma carpeta — o sea que se puede
// COMPARTIR el link de una carpeta, no solo el de un dibujo.
//
//   node scripts/bench-carpeta-url.mjs

import puppeteer from "puppeteer";

const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1200));

const botones = await page.$$("button");
for (const b of botones) {
  const txt = await page.evaluate((el) => el.textContent, b);
  if (txt && txt.includes("sin nombre")) { await b.click(); break; }
}
await new Promise((r) => setTimeout(r, 400));

async function clickFolder(name) {
  const el = await page.evaluateHandle(
    (n) => [...document.querySelectorAll(".folder-card")].find((c) => c.getAttribute("title") === n) || null,
    name
  );
  const esNulo = await page.evaluate((e) => e === null, el);
  if (esNulo) return false;
  await el.asElement().click();
  return true;
}

console.log("home:", page.url());
const c1 = await clickFolder("Guada y Flor Re");
await new Promise((r) => setTimeout(r, 1200));
const url1 = page.url();
console.log(`click carpeta 1: ${c1}  ->  ${url1}`);

const c2 = await clickFolder("Concepts");
await new Promise((r) => setTimeout(r, 1200));
const url2 = page.url();
console.log(`click carpeta 2: ${c2}  ->  ${url2}`);

console.log("\nvisitando la URL de la subcarpeta DIRECTO, como si fuera un link compartido...");
await page.goto(url2, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
const urlTrasRecargar = page.url();
const texto = await page.evaluate(() => document.body.innerText);
const migasOk = /Concepts/.test(texto) && /Guada y Flor Re/.test(texto);

console.log(`url tras recargar: ${urlTrasRecargar}`);
console.log(migasOk ? "  OK  la carpeta se reconstruyo desde la URL (breadcrumb correcto)" : "  FALLA no se reconstruyo la carpeta");

const urlOk = c1 && c2 && url1 !== "http://localhost:5173/" && url1.includes("guada-y-flor-re") && url2.includes("concepts") && urlTrasRecargar === url2;
console.log(urlOk && migasOk ? "\nRESULTADO: OK" : "\nRESULTADO: FALLA");

await browser.close();
process.exit(urlOk && migasOk ? 0 : 1);
