// Captura el lienzo EN MEDIO de un paneo y de un pinch.
//
// Hace falta porque durante el gesto el visor ya no dibuja: deja los pixeles
// como estan y los mueve con un transform de CSS. Eso es invisible para los
// tests que fijan la vista por codigo (esos limpian el transform), asi que la
// unica forma de comprobar que no se rompio nada es mirar una captura tomada
// con el gesto todavia en curso.
//
//   ORIGEN=http://127.0.0.1:8788 node scripts/cap-gesto.mjs

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/gesto");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.resolve(".cache/concepts/manifest.json"), "utf8"));
const f = manifest.files.filter((x) => x.size).sort((a, b) => b.size - a.size)[0];

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(`${BASE}/?tier=baja&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

await page.screenshot({ path: path.join(OUT, "0-reposo.png") });

/** Arranca un gesto y lo deja a mitad de camino, sin soltar. */
const gestoAMitad = async (tipo) => {
  await page.evaluate(async (tipo) => {
    const el = document.querySelector("canvas").parentElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const toque = (t, puntos) => {
      const touches = puntos.map((p, i) => new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y }));
      el.dispatchEvent(
        new TouchEvent(t, {
          touches: t === "touchend" ? [] : touches,
          targetTouches: t === "touchend" ? [] : touches,
          changedTouches: touches,
          bubbles: true,
          cancelable: true,
        })
      );
    };
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    if (tipo === "pan") {
      toque("touchstart", [{ x: cx, y: cy }]);
      for (let i = 1; i <= 8; i++) {
        toque("touchmove", [{ x: cx - i * 18, y: cy + i * 10 }]);
        await esperar(16);
      }
    } else {
      toque("touchstart", [
        { x: cx - 60, y: cy },
        { x: cx + 60, y: cy },
      ]);
      for (let i = 1; i <= 8; i++) {
        const sep = 60 + i * 16;
        toque("touchmove", [
          { x: cx - sep, y: cy },
          { x: cx + sep, y: cy },
        ]);
        await esperar(16);
      }
    }
    // A proposito NO se manda touchend: queremos la foto con el gesto vivo.
  }, tipo);
  // Menos de los 250 ms que tarda el redibujo nitido.
  await new Promise((r) => setTimeout(r, 90));
  const info = await page.evaluate(() => ({
    transform: document.querySelector("canvas").style.transform,
    vista: window.__viewerVista?.(),
  }));
  await page.screenshot({ path: path.join(OUT, `1-${tipo}-en-curso.png`) });
  return info;
};

const pan = await gestoAMitad("pan");
console.log(`paneo en curso -> transform: "${pan.transform}"`);

// Soltar y dejar que redibuje nitido.
await page.evaluate(() => {
  const el = document.querySelector("canvas").parentElement;
  el.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: [], bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2500));
const trasSoltar = await page.evaluate(() => document.querySelector("canvas").style.transform);
await page.screenshot({ path: path.join(OUT, "2-tras-soltar.png") });
console.log(`tras soltar -> transform: "${trasSoltar}" ${trasSoltar === "" ? "(limpio, OK)" : "(QUEDO PEGADO)"}`);

const zoom = await gestoAMitad("pinch");
console.log(`pinch en curso -> transform: "${zoom.transform}"`);
await page.evaluate(() => {
  const el = document.querySelector("canvas").parentElement;
  el.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: [], bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: path.join(OUT, "3-tras-pinch.png") });

// Y el boton de "ver todo" tiene que limpiar el transform tambien.
await page.evaluate(() => document.querySelector('[aria-label="Ver todo el dibujo"]')?.click());
await new Promise((r) => setTimeout(r, 1800));
const trasZoomAll = await page.evaluate(() => document.querySelector("canvas").style.transform);
console.log(`tras "ver todo" -> transform: "${trasZoomAll}" ${trasZoomAll === "" ? "(limpio, OK)" : "(QUEDO PEGADO)"}`);
await page.screenshot({ path: path.join(OUT, "4-zoom-all.png") });

console.log(`capturas en .cache/gesto/`);
await browser.close();
