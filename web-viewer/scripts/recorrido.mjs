// RECORRIDO COMPLETO: es el instrumento con el que se compara una iteracion
// de optimizacion contra la anterior. Mide siempre lo mismo, en el mismo
// orden, sobre los N dibujos mas pesados.
//
// Contesta, con numeros, las preguntas que importan:
//
//   1. APERTURA   cuanto tarda cada hito y DONDE se va el tiempo
//   2. MAPA       recorriendo TODO el dibujo en grilla: ¿siempre se ve lo que
//                 tiene que verse? (esta es la prueba de "no se pierden
//                 imagenes al panear")
//   3. LEJOS/CERCA  ciclos de alejarse y acercarse: ¿se ven las imagenes en
//                 los dos extremos?
//   4. ZOOM ALL   ¿vuelve al mismo encuadre?
//   5. FPS        con paneo y zoom brutales
//   6. RAM        pico, deriva a los 15 s, y —lo importante— cuanto queda
//                 despues de CERRAR el dibujo
//
//   node scripts/recorrido.mjs
//   ORIGEN=http://127.0.0.1:8788 TOP=3 ETIQUETA=iter1 node scripts/recorrido.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import puppeteer from "puppeteer";

/** Corre un comando de PowerShell y devuelve su salida. Se usa solo para
 * preguntarle al SO cuanta memoria ocupan los procesos de Chrome. */
function ejecutar(comando) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", comando],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? "" : stdout)
    );
  });
}

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/recorrido");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";
const THROTTLE = Number(process.env.THROTTLE || 6);
const TIER = process.env.TIER || "baja";
const TOP = Number(process.env.TOP || 3);
const ETIQUETA = process.env.ETIQUETA || "base";
const RED_LENTA = process.env.RED === "1";
/** Cuantas paradas por lado en el recorrido en grilla del dibujo. */
const GRILLA = Number(process.env.GRILLA || 4);
/** Cuanto se espera en cada parada a que se asiente la carga. Es un parametro
 * porque bajo carga de maquina el rasterizado tarda mas, y un valor corto hace
 * que el test reporte "huecos" que en realidad son "todavia no llego". */
const ESPERA = Number(process.env.ESPERA || 1800);

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = manifest.files
  .filter((f) => f.size && f.localPath)
  .sort((a, b) => b.size - a.size)
  .slice(0, TOP);

const mb = (b) => +(b / 1048576).toFixed(1);
const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
  protocolTimeout: 900000,
});

const salida = [];

for (const f of objetivos) {
  console.log(`\n${"=".repeat(76)}\n${f.name} — ${mb(f.size)} MB\n${"=".repeat(76)}`);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const errores = [];
  page.on("pageerror", (e) => errores.push(`pageerror: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 140)}`);
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
  const heap = () => page.evaluate(() => performance.memory.usedJSHeapSize).then(mb);

  // --- Memoria REAL del navegador ---------------------------------------
  // `usedJSHeapSize` no cuenta ImageBitmaps, el backing store de los canvas,
  // el blob storage ni el heap de los workers — o sea, justo donde vive la
  // memoria de este visor. Un heap de 44 MB puede convivir con un proceso de
  // varios cientos, que es lo que decide si Android mata la pestaña.
  // `SystemInfo.getProcessInfo` da el tamaño real de todos los procesos de
  // Chrome, que es lo unico comparable con lo que ve el telefono.
  // `SystemInfo.getProcessInfo` da los PID de todos los procesos de Chrome
  // (navegador, renderers, GPU) pero en esta version no trae el tamaño, asi
  // que la memoria se la pedimos al sistema operativo. Es el unico numero
  // comparable con lo que mide Android para decidir a quien matar.
  const sesionNavegador = await browser.target().createCDPSession();
  const memoriaProceso = async () => {
    try {
      const { processInfo } = await sesionNavegador.send("SystemInfo.getProcessInfo");
      const pids = processInfo.map((p) => p.id).filter(Boolean);
      if (pids.length === 0) return null;
      const salida = await ejecutar(
        `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`
      );
      const bytes = Number(String(salida).trim());
      return Number.isFinite(bytes) && bytes > 0 ? +(bytes / 1048576).toFixed(1) : null;
    } catch {
      return null;
    }
  };
  // Los bitmaps se muestrean seguido (es una lectura barata dentro de la
  // pagina) porque los picos duran poco. La memoria del SO NO se muestrea en
  // bucle: lanzar un proceso de PowerShell por segundo le roba CPU al test y
  // contamina justo lo que se esta midiendo — se comprobo, empeoraba todos
  // los tiempos. Se toma en los tres momentos que importan y nada mas.
  let picoProceso = 0;
  let picoBitmaps = 0;
  const anotarProceso = async () => {
    const m = await memoriaProceso();
    if (m && m > picoProceso) picoProceso = m;
    return m;
  };
  const muestreo = setInterval(async () => {
    try {
      const b = await page.evaluate(() => window.__viewerStats?.()?.ramImagenesMB ?? 0);
      if (b > picoBitmaps) picoBitmaps = b;
    } catch {
      /* la pagina puede estar navegando */
    }
  }, 250);
  const gc = () =>
    page.evaluate(async () => {
      if (window.gc) window.gc();
      await new Promise((r) => setTimeout(r, 300));
    });

  /** Estado del lienzo: cuanto se ve y cuantas imagenes tienen bitmap. */
  const estado = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let contenido = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        const rr = d[i], gg = d[i + 1], bb = d[i + 2];
        n++;
        const claro = rr > 244 && gg > 244 && bb > 244;
        const oscuro = rr < 30 && gg < 32 && bb < 38;
        if (!claro && !oscuro) contenido++;
      }
      const st = window.__viewerStats?.() ?? {};
      return {
        pct: +((contenido / n) * 100).toFixed(2),
        ram: st.ramImagenesMB ?? 0,
        recursos: st.recursosEnMemoria ?? 0,
        recortados: st.recortados ?? 0,
        ...(window.__viewerCobertura?.() ?? {}),
      };
    });

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

    // ------------------------------------------------------- 1. APERTURA
    await page.waitForSelector(".viewer-placeholder-img", { timeout: 90000 }).catch(() => {});
    r.msPlaceholder = Date.now() - t0;
    await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
    r.msTrazos = Date.now() - t0;
    await page
      .waitForFunction(() => (window.__viewerStats?.()?.recursosEnMemoria ?? 0) > 0, { timeout: 240000 })
      .catch(() => {});
    r.msPrimeraImagen = Date.now() - t0;
    await page
      .waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 })
      .catch(() => r.errores.push("no termino de cargar en 240 s"));
    r.msTodo = Date.now() - t0;
    r.requests = requests;
    r.MBbajados = mb(bytesRed);
    r.heapAbrir = await heap();
    await anotarProceso();
    r.tiempos = await page.evaluate(() => window.__viewerStats?.()?.tiempos ?? null);
    const alAbrir = await estado();
    r.alAbrir = alAbrir;

    console.log(
      `  apertura: previa ${r.msPlaceholder} | trazos ${r.msTrazos} | 1a img ${r.msPrimeraImagen} | todo ${r.msTodo} ms`
    );
    console.log(`  red: ${r.requests} req, ${r.MBbajados} MB | heap ${r.heapAbrir} MB | bitmaps ${alAbrir.ram} MB`);
    if (r.tiempos) {
      const t = r.tiempos;
      console.log(
        `  consumo: cache ${(t.cacheMs / 1000).toFixed(1)}s | bytes ${(t.bytesMs / 1000).toFixed(1)}s | rasterizar ${(t.rasterMs / 1000).toFixed(1)}s | hilo principal ${(t.enMainMs / 1000).toFixed(1)}s`
      );
    }

    // ------------------------------------- 2. RECORRIDO DE TODO EL MAPA
    // Se recorre el dibujo entero en grilla, a un zoom de trabajo (como
    // alguien leyendo el plano), y en cada parada se comprueba que lo que
    // deberia verse tenga bitmap. Es la prueba de "panear no pierde imagenes".
    const vistaInicial = await page.evaluate(() => window.__viewerVista?.());
    const limites = await page.evaluate(() => {
      const cajas = window.__viewerCajas?.() ?? [];
      if (!cajas.length) return null;
      return {
        x0: Math.min(...cajas.map((c) => c.x0)),
        y0: Math.min(...cajas.map((c) => c.y0)),
        x1: Math.max(...cajas.map((c) => c.x1)),
        y1: Math.max(...cajas.map((c) => c.y1)),
      };
    });

    const paradas = [];
    if (limites) {
      const zoomTrabajo = vistaInicial.zoom * 3;
      for (let iy = 0; iy < GRILLA; iy++) {
        for (let ix = 0; ix < GRILLA; ix++) {
          paradas.push({
            x: limites.x0 + ((ix + 0.5) / GRILLA) * (limites.x1 - limites.x0),
            y: limites.y0 + ((iy + 0.5) / GRILLA) * (limites.y1 - limites.y0),
            zoom: zoomTrabajo,
          });
        }
      }
    }

    let huecos = 0;
    let peorPct = 100;
    let ramPico = alAbrir.ram;
    const tRecorrido = Date.now();
    for (const p of paradas) {
      await page.evaluate((p) => {
        const c = document.querySelector("canvas");
        window.__viewerFijarVista({
          zoom: p.zoom,
          panX: c.clientWidth / 2 - p.x * p.zoom,
          panY: c.clientHeight / 2 - p.y * p.zoom,
        });
      }, p);
      await new Promise((res) => setTimeout(res, ESPERA));
      const e = await estado();
      if (e.visibles > 0 && e.visiblesConBitmap < e.visibles) huecos++;
      if (e.pct < peorPct) peorPct = e.pct;
      if (e.ram > ramPico) ramPico = e.ram;
    }
    r.recorrido = {
      paradas: paradas.length,
      conHuecos: huecos,
      peorPct,
      ramPicoMB: ramPico,
      segundos: +((Date.now() - tRecorrido) / 1000).toFixed(1),
    };
    r.heapRecorrido = await heap();
    await anotarProceso();
    console.log(
      `  mapa: ${paradas.length} paradas | con huecos ${huecos} | ram bitmaps pico ${ramPico} MB | heap ${r.heapRecorrido} MB`
    );

    // -------------------------------------------------- 3. LEJOS / CERCA
    // Alejarse del todo y acercarse a fondo, varias veces. Comprueba que las
    // imagenes se ven en los dos extremos y que alejarse LIBERA resolucion.
    const ciclos = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate((v) => window.__viewerFijarVista(v), vistaInicial);
      await new Promise((res) => setTimeout(res, 2200));
      const lejos = await estado();
      await page.evaluate(
        (p) => {
          const c = document.querySelector("canvas");
          const z = p.zoom;
          window.__viewerFijarVista({
            zoom: z,
            panX: c.clientWidth / 2 - p.x * z,
            panY: c.clientHeight / 2 - p.y * z,
          });
        },
        { x: paradas[0]?.x ?? 0, y: paradas[0]?.y ?? 0, zoom: vistaInicial.zoom * 12 }
      );
      await new Promise((res) => setTimeout(res, 3500));
      const cerca = await estado();
      ciclos.push({ lejos, cerca });
    }
    r.lejosCerca = ciclos.map((c) => ({
      lejosOk: c.lejos.visibles === 0 || c.lejos.visiblesConBitmap === c.lejos.visibles,
      cercaOk: c.cerca.visibles === 0 || c.cerca.visiblesConBitmap === c.cerca.visibles,
      ramLejos: c.lejos.ram,
      ramCerca: c.cerca.ram,
      recortadosCerca: c.cerca.recortados,
    }));
    const fallosLC = r.lejosCerca.filter((c) => !c.lejosOk || !c.cercaOk).length;
    console.log(
      `  lejos/cerca: ${3 - fallosLC}/3 ciclos ok | ram lejos ${r.lejosCerca.map((c) => c.ramLejos).join("/")} MB | cerca ${r.lejosCerca.map((c) => c.ramCerca).join("/")} MB`
    );

    // ------------------------------------------------------ 4. ZOOM ALL
    await page.evaluate(() => document.querySelector('[aria-label="Ver todo el dibujo"]')?.click());
    await new Promise((res) => setTimeout(res, 1500));
    const vuelta = await page.evaluate(() => window.__viewerVista?.());
    r.zoomAllOk =
      !!vuelta &&
      Math.abs(vuelta.zoom - vistaInicial.zoom) / vistaInicial.zoom < 0.02 &&
      Math.abs(vuelta.panX - vistaInicial.panX) < 4 &&
      Math.abs(vuelta.panY - vistaInicial.panY) < 4;
    console.log(`  zoom all: ${r.zoomAllOk ? "OK" : "FALLA"}`);

    // ----------------------------------------------------------- 5. FPS
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
      await esperar(400);
      corriendo = false;
      const d = frames.slice(3).filter((x) => x > 0 && x < 3000).sort((a, b) => a - b);
      const p = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
      const media = d.reduce((a, b) => a + b, 0) / d.length;
      const st = window.__viewerStats?.() ?? {};
      return {
        fps: +(1000 / media).toFixed(1),
        p50: +p(0.5).toFixed(1),
        p95: +p(0.95).toFixed(1),
        peor: +d[d.length - 1].toFixed(1),
        tirones: d.filter((x) => x > 50).length,
        // La cadencia que mide el propio visor (mediana del hueco entre
        // frames presentados) y sus frames largos.
        fpsVisor: st.fps ?? 0,
        p95Visor: st.p95FrameMs ?? 0,
        framesLargos: st.framesLargos ?? 0,
      };
    });
    console.log(
      `  fps ${r.fps.fps} (visor ${r.fps.fpsVisor}) | p95 ${r.fps.p95} ms (visor ${r.fps.p95Visor}) | peor ${r.fps.peor} ms | tirones>50ms ${r.fps.tirones} | frames largos ${r.fps.framesLargos}`
    );

    // ----------------------------------------------------------- 6. RAM
    r.heapGestos = await heap();
    await new Promise((res) => setTimeout(res, 15000));
    await gc();
    r.heapReposo = await heap();
    r.derivaMB = +(r.heapReposo - r.heapGestos).toFixed(1);

    // Y lo que mas importa: ¿se limpia al CERRAR el dibujo?
    await page.evaluate(() => document.querySelector(".btn-close-viewer")?.click());
    await new Promise((res) => setTimeout(res, 2500));
    await gc();
    await new Promise((res) => setTimeout(res, 1500));
    await gc();
    r.heapTrasCerrar = await heap();
    r.hooksLimpios = await page.evaluate(() => !window.__viewerStats && !window.__viewerCobertura);
    r.liberadoAlCerrar = +(r.heapReposo - r.heapTrasCerrar).toFixed(1);
    clearInterval(muestreo);
    r.picoProcesoMB = picoProceso;
    r.picoBitmapsMB = picoBitmaps;
    r.procesoTrasCerrar = await memoriaProceso();
    console.log(
      `  heap js: abrir ${r.heapAbrir} -> recorrido ${r.heapRecorrido} -> gestos ${r.heapGestos} -> reposo ${r.heapReposo} MB (deriva ${r.derivaMB})`
    );
    console.log(
      `  PROCESO (lo que ve Android): pico ${r.picoProcesoMB} MB | tras cerrar ${r.procesoTrasCerrar} MB | bitmaps pico ${r.picoBitmapsMB} MB`
    );
    console.log(
      `  al cerrar: heap ${r.heapTrasCerrar} MB (libero ${r.liberadoAlCerrar}) | hooks del visor limpios: ${r.hooksLimpios ? "si" : "NO"}`
    );

    r.errores.push(...new Set(errores));
    if (r.errores.length) console.log(`  ERRORES: ${r.errores.slice(0, 3).join(" | ")}`);
  } catch (e) {
    clearInterval(muestreo);
    r.fatal = String(e).slice(0, 240);
    r.errores.push(...new Set(errores));
    console.log(`  FATAL: ${r.fatal}`);
  }

  salida.push(r);
  await page.close();
}

await writeFile(path.join(OUT, `${ETIQUETA}.json`), JSON.stringify(salida, null, 2));

// ---------------------------------------------------------- resumen final
console.log(`\n${"=".repeat(76)}\nRESUMEN ${ETIQUETA}\n${"=".repeat(76)}`);
console.log(
  ["archivo", "todo", "1aImg", "MB", "fps", "tiron", "huecos", "ramBmp", "heap", "cierre"].join("\t")
);
for (const r of salida) {
  console.log(
    [
      (r.archivo || "").slice(0, 14),
      r.msTodo ?? "-",
      r.msPrimeraImagen ?? "-",
      r.MBbajados ?? "-",
      r.fps?.fps ?? "-",
      r.fps?.p95 ?? "-",
      r.fps?.framesLargos ?? "-",
      r.recorrido?.conHuecos ?? "-",
      r.picoProcesoMB ?? "-",
      r.procesoTrasCerrar ?? "-",
    ].join("\t")
  );
}
console.log(`\nGuardado en .cache/recorrido/${ETIQUETA}.json`);
await browser.close();
