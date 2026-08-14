// Banco de pruebas del PEOR CASO: el dibujo mas pesado, en un telefono de
// gama baja, con la CPU frenada y la red lenta.
//
// Es el script que se vuelve a correr en cada iteracion de optimizacion, asi
// que mide siempre lo mismo y en el mismo orden:
//
//   1. HITOS      cuanto tarda en verse algo, en verse los trazos, en estar todo
//   2. RED        cuantos MB se bajan de verdad
//   3. IMAGENES   cuantas de las colocadas estan realmente dibujadas
//   4. ZOOM ALL   si el boton reencuadra todo el dibujo
//   5. GESTOS     FPS con pan/zoom brutales y, sobre todo, SI SE PIERDEN
//                 IMAGENES: se cuenta cuantas hay dibujadas antes, durante y
//                 despues, y se vuelve al encuadre inicial para comparar el
//                 lienzo contra si mismo.
//   6. RAM        heap tras abrir, tras gestos y 15 s despues
//
//   node scripts/bench-pesado.mjs
//   TOP=3 THROTTLE=6 RED=1 node scripts/bench-pesado.mjs
//   ETIQUETA=iter3 node scripts/bench-pesado.mjs      (guarda con ese nombre)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/bench");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const THROTTLE = Number(process.env.THROTTLE || 6);
const TOP = Number(process.env.TOP || 1);
const TIER = process.env.TIER || "baja";
const RED_LENTA = process.env.RED === "1";
const ETIQUETA = process.env.ETIQUETA || "base";
const TIMEOUT_TODO = Number(process.env.TIMEOUT_TODO || 180000);
// Servidor local del corpus. Sin esto la varianza de Drive (0,3 a 3 s por
// rango) tapa cualquier mejora que se quiera medir.
const ORIGEN = process.env.ORIGEN || "";

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = process.argv[2]
  ? [manifest.files.find((f) => f.id === process.argv[2])].filter(Boolean)
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, TOP);

const mb = (b) => +(b / 1048576).toFixed(1);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info", "--js-flags=--expose-gc"],
  protocolTimeout: 900000,
});

const salida = [];

for (const f of objetivos) {
  console.log(`\n${"=".repeat(74)}\n${f.name} — ${mb(f.size)} MB — tier=${TIER} cpu=${THROTTLE}x red=${RED_LENTA ? "4G lenta" : "sin frenar"}\n${"=".repeat(74)}`);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const errores = [];
  page.on("pageerror", (e) => errores.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 160)}`);
  });

  let bytesRed = 0;
  let requests = 0;
  page.on("response", (res) => {
    const u = res.url();
    if (!u.includes("concepts-drive") && !(ORIGEN && u.startsWith(ORIGEN))) return;
    requests++;
    bytesRed += Number(res.headers()["content-length"] || 0);
  });

  const r = { archivo: f.name, id: f.id, MB: mb(f.size), etiqueta: ETIQUETA, errores: [] };

  try {
    const url = `${BASE}/?tier=${TIER}&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (RED_LENTA) {
      const cli = await page.createCDPSession();
      await cli.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (4 * 1024 * 1024) / 8,
        uploadThroughput: (1 * 1024 * 1024) / 8,
      });
    }
    await page.emulateCPUThrottling(THROTTLE);
    const t0 = Date.now();

    // ---------------------------------------------------------- 1. HITOS
    try {
      await page.waitForSelector(".viewer-placeholder-img", { timeout: 90000 });
      r.msPlaceholder = Date.now() - t0;
    } catch {
      r.msPlaceholder = null;
    }
    await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
    r.msTrazos = Date.now() - t0;

    // Primera imagen dibujada (el hito que de verdad se percibe).
    try {
      await page.waitForFunction(() => (window.__viewerStats?.()?.recursosEnMemoria ?? 0) > 0, {
        timeout: 240000,
      });
      r.msPrimeraImagen = Date.now() - t0;
    } catch {
      r.msPrimeraImagen = null;
    }

    try {
      await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: TIMEOUT_TODO });
      r.msTodo = Date.now() - t0;
    } catch {
      r.msTodo = null;
      r.errores.push(`no termino de cargar en ${TIMEOUT_TODO / 1000}s`);
    }

    r.requests = requests;
    r.MBbajados = mb(bytesRed);
    r.pctArchivo = +((bytesRed / f.size) * 100).toFixed(1);
    r.heapAbrirMB = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));

    // ------------------------------------------------- 2/3. QUE SE VE
    // `cobertura` = que fraccion del lienzo tiene contenido, y cuantos de los
    // recursos colocados tienen bitmap. La segunda es la que detecta que "se
    // pierden imagenes": si baja despues de un gesto, se perdieron.
    const medir = () =>
      page.evaluate(() => {
        const c = document.querySelector("canvas");
        if (!c) return null;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let contenido = 0;
        let cromatico = 0;
        const colores = new Set();
        const paso = 4 * 31;
        let n = 0;
        for (let i = 0; i < d.length; i += paso) {
          const rr = d[i], gg = d[i + 1], bb = d[i + 2];
          n++;
          const esFondoClaro = rr > 244 && gg > 244 && bb > 244;
          const esFondoOscuro = rr < 30 && gg < 32 && bb < 38;
          if (!esFondoClaro && !esFondoOscuro) contenido++;
          if (Math.abs(rr - gg) > 6 || Math.abs(gg - bb) > 6) cromatico++;
          colores.add(((rr >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3));
        }
        const st = window.__viewerStats?.() ?? {};
        return {
          pctContenido: +((contenido / n) * 100).toFixed(2),
          pctCromatico: +((cromatico / n) * 100).toFixed(2),
          colores: colores.size,
          recursosEnMemoria: st.recursosEnMemoria ?? 0,
          recortados: st.recortados ?? 0,
          ramImagenesMB: st.ramImagenesMB ?? 0,
          // Cuantas colocaciones estan a la vista y cuantas de esas tienen
          // bitmap: es la medida directa de "se ven todas las que se tienen
          // que ver".
          ...(window.__viewerCobertura?.() ?? {}),
        };
      });

    r.alAbrir = await medir();

    // ------------------------------------------------------- 4. ZOOM ALL
    // Se ensucia la vista a proposito (zoom fuerte y desplazamiento) y despues
    // se pide "ver todo": tiene que volver a un encuadre equivalente al inicial.
    const vistaInicial = await page.evaluate(() => window.__viewerVista?.());
    await page.evaluate(async () => {
      const el = document.querySelector("canvas").parentElement;
      const b = el.getBoundingClientRect();
      for (let i = 0; i < 14; i++) {
        el.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            clientX: b.left + b.width * 0.3,
            clientY: b.top + b.height * 0.3,
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    await new Promise((res) => setTimeout(res, 900));
    const vistaZoom = await page.evaluate(() => window.__viewerVista?.());
    await page.evaluate(() => document.querySelector('[aria-label="Ver todo el dibujo"]')?.click());
    await new Promise((res) => setTimeout(res, 1200));
    const vistaVuelta = await page.evaluate(() => window.__viewerVista?.());
    r.zoomAll = {
      inicial: vistaInicial,
      traszoom: vistaZoom,
      vuelta: vistaVuelta,
      ok:
        !!vistaInicial &&
        !!vistaVuelta &&
        Math.abs(vistaVuelta.zoom - vistaInicial.zoom) / vistaInicial.zoom < 0.02 &&
        Math.abs(vistaVuelta.panX - vistaInicial.panX) < 4 &&
        Math.abs(vistaVuelta.panY - vistaInicial.panY) < 4,
    };
    console.log(
      `  zoom all: inicial z=${vistaInicial?.zoom?.toFixed(4)} -> tras zoom z=${vistaZoom?.zoom?.toFixed(4)} -> vuelta z=${vistaVuelta?.zoom?.toFixed(4)}  ${r.zoomAll.ok ? "OK" : "FALLA"}`
    );

    // -------------------------------------------- 5. GESTOS + PERDIDA
    // Se guarda el estado del lienzo en el encuadre inicial, se hace un
    // vendaval de gestos, se vuelve al MISMO encuadre y se compara. Si el
    // lienzo quedo con menos contenido, se perdieron imagenes.
    const antesGestos = await medir();

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

      // Paneos largos y bruscos.
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
      // Pinch adentro/afuera.
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
      // Caos: pan y zoom sin pausa.
      for (let k = 0; k < 5; k++) {
        toque("touchstart", [{ x: cx, y: cy }]);
        for (let i = 0; i < 8; i++) {
          toque("touchmove", [{ x: cx + (i % 2 ? 210 : -210), y: cy + (i % 3 ? 160 : -160) }]);
          await esperar(16);
        }
        toque("touchend", [{ x: cx, y: cy }]);
        toque("touchstart", [
          { x: cx - 50, y: cy },
          { x: cx + 50, y: cy },
        ]);
        for (let i = 1; i <= 8; i++) {
          toque("touchmove", [
            { x: cx - 50 - i * 22, y: cy },
            { x: cx + 50 + i * 22, y: cy },
          ]);
          await esperar(16);
        }
        toque("touchend", [{ x: cx, y: cy }]);
      }
      await esperar(400);
      corriendo = false;
      const d = frames.slice(3).filter((x) => x > 0 && x < 3000).sort((a, b) => a - b);
      const p = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
      const media = d.reduce((a, b) => a + b, 0) / d.length;
      return {
        frames: d.length,
        fpsMedio: +(1000 / media).toFixed(1),
        msP50: +p(0.5).toFixed(1),
        msP95: +p(0.95).toFixed(1),
        msPeor: +d[d.length - 1].toFixed(1),
        tirones50: d.filter((x) => x > 50).length,
        tirones100: d.filter((x) => x > 100).length,
      };
    });

    r.heapGestosMB = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));
    r.duranteGestos = await medir();

    // Volver EXACTAMENTE al encuadre inicial y comparar.
    await page.evaluate((v) => window.__viewerFijarVista?.(v), vistaInicial);
    await new Promise((res) => setTimeout(res, 1500));
    r.trasVolverRapido = await medir();
    // Y con tiempo para que el refinado termine.
    await new Promise((res) => setTimeout(res, 8000));
    r.trasVolver = await medir();

    r.perdida = {
      contenidoAntes: antesGestos?.pctContenido,
      contenidoDespuesRapido: r.trasVolverRapido?.pctContenido,
      contenidoDespues: r.trasVolver?.pctContenido,
      visiblesConBitmapAntes: antesGestos?.visiblesConBitmap,
      visiblesConBitmapDespues: r.trasVolver?.visiblesConBitmap,
      visiblesAntes: antesGestos?.visibles,
      visiblesDespues: r.trasVolver?.visibles,
    };

    // ------------------------------------------------------------ 6. RAM
    await new Promise((res) => setTimeout(res, 15000));
    await page.evaluate(async () => {
      if (window.gc) window.gc();
      await new Promise((r) => setTimeout(r, 400));
    });
    r.heap15sMB = mb(await page.evaluate(() => performance.memory.usedJSHeapSize));
    r.derivaMB = +(r.heap15sMB - r.heapGestosMB).toFixed(1);

    await page.screenshot({ path: path.join(OUT, `${ETIQUETA}-${f.id}.png`) });
    r.errores.push(...new Set(errores));

    console.log(
      `  hitos: placeholder ${r.msPlaceholder ?? "-"} | trazos ${r.msTrazos} | 1a img ${r.msPrimeraImagen ?? "-"} | completo ${r.msTodo ?? ">" + TIMEOUT_TODO / 1000 + "s"} (ms)`
    );
    console.log(`  red: ${r.requests} requests, ${r.MBbajados} MB (${r.pctArchivo}% del archivo)`);
    console.log(
      `  al abrir: ${r.alAbrir.pctContenido}% contenido | ${r.alAbrir.colores} colores | ${r.alAbrir.recursosEnMemoria} recursos (${r.alAbrir.ramImagenesMB} MB) | visibles con bitmap ${r.alAbrir.visiblesConBitmap ?? "?"}/${r.alAbrir.visibles ?? "?"} | chinches ${r.alAbrir.chinches ?? "?"}`
    );
    r.tiempos = await page.evaluate(() => window.__viewerStats?.()?.tiempos ?? null);
    if (r.tiempos) {
      const t = r.tiempos;
      console.log(
        `  donde se va el tiempo (${t.n} recursos): cache ${(t.cacheMs / 1000).toFixed(1)}s | bytes ${(t.bytesMs / 1000).toFixed(1)}s | rasterizar ${(t.rasterMs / 1000).toFixed(1)}s`
      );
    }
    console.log(
      `  FPS ${r.fps.fpsMedio} | p50 ${r.fps.msP50}ms | p95 ${r.fps.msP95}ms | peor ${r.fps.msPeor}ms | tirones>50ms ${r.fps.tirones50}`
    );
    console.log(
      `  PERDIDA: contenido ${r.perdida.contenidoAntes}% -> ${r.perdida.contenidoDespuesRapido}% (al instante) -> ${r.perdida.contenidoDespues}% (asentado)`
    );
    console.log(
      `           imagenes a la vista con bitmap: ${r.perdida.visiblesConBitmapAntes}/${r.perdida.visiblesAntes} -> ${r.perdida.visiblesConBitmapDespues}/${r.perdida.visiblesDespues}`
    );
    console.log(`  heap: abrir ${r.heapAbrirMB} -> gestos ${r.heapGestosMB} -> +15s ${r.heap15sMB} MB (deriva ${r.derivaMB})`);
    if (r.errores.length) console.log(`  ERRORES: ${r.errores.slice(0, 4).join(" | ")}`);
  } catch (e) {
    r.fatal = String(e).slice(0, 300);
    r.errores.push(...new Set(errores));
    console.log(`  FATAL: ${r.fatal}`);
  }

  salida.push(r);
  await page.close();
}

await writeFile(path.join(OUT, `${ETIQUETA}.json`), JSON.stringify(salida, null, 2));
console.log(`\nGuardado en .cache/bench/${ETIQUETA}.json`);
await browser.close();
