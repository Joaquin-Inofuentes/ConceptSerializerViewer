// Test end-to-end del visor REAL (la app, no el pipeline suelto) emulando un
// telefono de gama baja: CPU throttling, viewport 360x700, DPR 2.
//
// Responde, con numeros, las preguntas que importan:
//   - ¿Se ven las imagenes al abrir los mas pesados?
//   - ¿Arranca rapido? ¿cuanto tarda cada etapa?
//   - ¿Anda fluido? ¿se traba? (FPS con pan/zoom bruscos y repetidos)
//   - ¿Hay fugas de RAM a los 20 s? ¿y al cambiar de dibujo?
//   - ¿Donde revienta?
//
//   node scripts/e2e-gama-baja.mjs [--top N] [--throttle 6]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const BASE = process.env.BASE_URL || "http://localhost:5173";
const THROTTLE = Number(process.env.THROTTLE || 6);
const TOP = Number(process.env.TOP || 3);

const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const pesados = manifest.files.filter((f) => f.size && f.localPath).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
});

const salida = [];

function mb(bytes) {
  return +(bytes / 1048576).toFixed(1);
}

for (const f of pesados) {
  console.log(`\n${"=".repeat(70)}\n${f.name} — ${mb(f.size)} MB\n${"=".repeat(70)}`);
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const errores = [];
  page.on("pageerror", (e) => errores.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 200)}`);
  });

  // Contabilidad de red REAL: cuantos bytes se bajan de verdad para abrir.
  let bytesRed = 0;
  let requestsRango = 0;
  page.on("response", async (res) => {
    if (!res.url().includes("concepts-drive")) return;
    requestsRango++;
    const len = Number(res.headers()["content-length"] || 0);
    bytesRed += len;
  });

  const r = { archivo: f.name, MB: mb(f.size), errores: [] };

  try {
    await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
    await page.emulateCPUThrottling(THROTTLE);
    const t0 = Date.now();

    // --- Hito 1: vista previa (el usuario ve SU dibujo) ---
    try {
      await page.waitForSelector(".viewer-placeholder-img", { timeout: 60000 });
      r.msPlaceholder = Date.now() - t0;
    } catch {
      r.msPlaceholder = null;
    }

    // --- Hito 2: canvas con trazos ---
    await page.waitForFunction(
      () => {
        const c = document.querySelector("canvas");
        return c && c.width > 1;
      },
      { timeout: 180000 }
    );
    r.msTrazos = Date.now() - t0;

    // --- Hito 3: todas las imagenes cargadas (se va el badge) ---
    try {
      await page.waitForFunction(() => !document.querySelector(".viewer-carga"), {
        timeout: 240000,
      });
      r.msTodo = Date.now() - t0;
    } catch {
      r.msTodo = null;
      r.errores.push("las imagenes no terminaron de cargar en 240 s");
    }

    r.requestsRango = requestsRango;
    r.MBbajados = mb(bytesRed);
    r.porcentajeBajado = +((bytesRed / f.size) * 100).toFixed(1);

    // --- ¿SE VEN LAS IMAGENES? ---
    // Se comprueba de verdad, mirando pixeles: un lienzo con planos tiene
    // muchisimos colores distintos; uno con solo trazos negros sobre blanco,
    // muy pocos. Ademas se compara el canvas contra si mismo antes/despues.
    r.imagenes = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return { error: "sin canvas" };
      const ctx = c.getContext("2d");
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const colores = new Set();
      let noBlanco = 0;
      let grises = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        const rr = d[i], gg = d[i + 1], bb = d[i + 2];
        if (rr < 245 || gg < 245 || bb < 245) noBlanco++;
        // Un pixel "de imagen" suele tener componentes distintos entre si o
        // ser un gris intermedio; el trazo puro es negro o casi.
        if (Math.abs(rr - gg) > 6 || Math.abs(gg - bb) > 6) grises++;
        colores.add((rr >> 3) << 10 | (gg >> 3) << 5 | (bb >> 3));
      }
      const muestreados = Math.floor(d.length / (4 * 37));
      return {
        coloresDistintos: colores.size,
        pctNoBlanco: +((noBlanco / muestreados) * 100).toFixed(1),
        pctCromatico: +((grises / muestreados) * 100).toFixed(1),
        canvas: `${c.width}x${c.height}`,
      };
    });

    // Cuantos recursos rasterizo el visor de verdad.
    r.recursos = await page.evaluate(() => {
      const w = window;
      return w.__viewerStats ? w.__viewerStats() : null;
    });

    // --- RAM tras abrir ---
    const heapTrasAbrir = await page.evaluate(() => performance.memory.usedJSHeapSize);
    r.heapTrasAbrirMB = mb(heapTrasAbrir);

    // --- PAN/ZOOM BRUSCOS Y REPETIDOS: medir FPS real ---
    // Se disparan gestos tactiles reales sobre el canvas (no se llama a la
    // API interna), y se cuentan los frames que efectivamente pinta el rAF.
    r.fps = await page.evaluate(async () => {
      const el = document.querySelector("canvas").parentElement;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const frames = [];
      let ultimo = performance.now();
      let corriendo = true;
      const contar = () => {
        const ahora = performance.now();
        frames.push(ahora - ultimo);
        ultimo = ahora;
        if (corriendo) requestAnimationFrame(contar);
      };
      requestAnimationFrame(contar);

      const toque = (tipo, puntos) => {
        const touches = puntos.map((p, i) =>
          new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y })
        );
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

      // 1) PANEOS BRUSCOS Y RAPIDOS (8 barridos completos)
      for (let s = 0; s < 8; s++) {
        toque("touchstart", [{ x: cx, y: cy }]);
        for (let i = 0; i < 12; i++) {
          const dx = Math.sin((s + i / 12) * 2.4) * 160;
          const dy = Math.cos((s + i / 12) * 3.1) * 160;
          toque("touchmove", [{ x: cx + dx, y: cy + dy }]);
          await esperar(16);
        }
        toque("touchend", [{ x: cx, y: cy }]);
        await esperar(30);
      }

      // 2) ZOOMS BRUSCOS REPETIDOS (pinch adentro/afuera, 6 ciclos)
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

      // 3) MEZCLA CAOTICA: pan y zoom alternados sin pausa
      for (let k = 0; k < 5; k++) {
        toque("touchstart", [{ x: cx, y: cy }]);
        for (let i = 0; i < 8; i++) {
          toque("touchmove", [{ x: cx + (i % 2 ? 200 : -200), y: cy + (i % 3 ? 150 : -150) }]);
          await esperar(16);
        }
        toque("touchend", [{ x: cx, y: cy }]);
        toque("touchstart", [
          { x: cx - 50, y: cy },
          { x: cx + 50, y: cy },
        ]);
        for (let i = 1; i <= 8; i++) {
          toque("touchmove", [
            { x: cx - 50 - i * 20, y: cy },
            { x: cx + 50 + i * 20, y: cy },
          ]);
          await esperar(16);
        }
        toque("touchend", [{ x: cx, y: cy }]);
      }

      await esperar(400);
      corriendo = false;

      const deltas = frames.slice(3).filter((d) => d > 0 && d < 2000);
      deltas.sort((a, b) => a - b);
      const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))];
      const media = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      return {
        frames: deltas.length,
        fpsMedio: +(1000 / media).toFixed(1),
        msP50: +p(0.5).toFixed(1),
        msP95: +p(0.95).toFixed(1),
        msPeor: +deltas[deltas.length - 1].toFixed(1),
        // Un frame de mas de 50 ms se percibe como tiron.
        tironesMas50ms: deltas.filter((d) => d > 50).length,
        tironesMas100ms: deltas.filter((d) => d > 100).length,
      };
    });

    r.heapTrasGestosMB = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));

    // --- ¿FUGA DE RAM A LOS 20 S? ---
    await new Promise((r) => setTimeout(r, 20000));
    await page.evaluate(async () => {
      if (window.gc) window.gc();
      await new Promise((r) => setTimeout(r, 500));
    });
    r.heap20sMB = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));
    r.derivaRamMB = +(r.heap20sMB - r.heapTrasGestosMB).toFixed(1);

    r.errores.push(...errores);
    console.log(
      `  placeholder ${r.msPlaceholder ?? "-"}ms | trazos ${r.msTrazos}ms | completo ${r.msTodo ?? ">240s"}ms`
    );
    console.log(`  red: ${r.requestsRango} requests, ${r.MBbajados} MB (${r.porcentajeBajado}% del archivo)`);
    console.log(
      `  imagenes: ${r.imagenes.coloresDistintos} colores, ${r.imagenes.pctNoBlanco}% no-blanco, ${r.imagenes.pctCromatico}% cromatico`
    );
    console.log(
      `  FPS ${r.fps.fpsMedio} | p50 ${r.fps.msP50}ms | p95 ${r.fps.msP95}ms | peor ${r.fps.msPeor}ms | tirones>50ms: ${r.fps.tironesMas50ms}`
    );
    console.log(
      `  heap: abrir ${r.heapTrasAbrirMB} -> gestos ${r.heapTrasGestosMB} -> +20s ${r.heap20sMB} MB (deriva ${r.derivaRamMB})`
    );
    if (r.errores.length) console.log(`  ERRORES: ${r.errores.slice(0, 3).join(" | ")}`);
  } catch (e) {
    r.fatal = String(e).slice(0, 300);
    r.errores.push(...errores);
    console.log(`  FATAL: ${r.fatal}`);
  }

  salida.push(r);
  await page.close();
}

// --- Prueba de limpieza al CAMBIAR de dibujo (la fuga clasica) ---
console.log(`\n${"=".repeat(70)}\nCAMBIO DE DIBUJO: ¿se limpia la RAM?\n${"=".repeat(70)}`);
{
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ciclos = [];
  try {
    await page.goto(`${BASE}/?tier=baja`, { waitUntil: "domcontentloaded" });
    await page.emulateCPUThrottling(THROTTLE);

    for (let i = 0; i < 4; i++) {
      const f = pesados[i % pesados.length];
      await page.evaluate((id) => {
        history.pushState({}, "", `/?tier=baja&file=${id}`);
      }, f.id);
      await page.goto(`${BASE}/?tier=baja&file=${f.id}`, { waitUntil: "domcontentloaded" });
      await page.emulateCPUThrottling(THROTTLE);
      await page.waitForFunction(
        () => {
          const c = document.querySelector("canvas");
          return c && c.width > 1;
        },
        { timeout: 180000 }
      );
      await new Promise((r) => setTimeout(r, 4000));
      const heap = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));
      ciclos.push({ i, archivo: f.name.slice(0, 24), heapMB: heap });
      console.log(`  ciclo ${i} (${f.name.slice(0, 30)}): heap ${heap} MB`);
    }
  } catch (e) {
    console.log(`  FATAL: ${String(e).slice(0, 200)}`);
  }
  const crecimiento = ciclos.length > 1 ? +(ciclos[ciclos.length - 1].heapMB - ciclos[0].heapMB).toFixed(1) : null;
  console.log(`  crecimiento tras ${ciclos.length} aperturas: ${crecimiento} MB`);
  salida.push({ prueba: "cambio-de-dibujo", ciclos, crecimientoMB: crecimiento });
  await page.close();
}

await writeFile(path.join(CACHE_DIR, "e2e-gama-baja.json"), JSON.stringify(salida, null, 2));
await browser.close();
console.log("\nGuardado en .cache/concepts/e2e-gama-baja.json");
