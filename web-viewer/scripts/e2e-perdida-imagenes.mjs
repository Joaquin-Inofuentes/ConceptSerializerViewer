// ¿Se pierden imagenes al hacer zoom o al panear?
//
// Es el bug que reporto el usuario y el que mas cuesta ver con metricas
// promedio, porque una imagen que falta es un rectangulo vacio en medio de un
// lienzo que por lo demas se ve bien.
//
// Se prueba de forma dirigida, no con gestos al azar:
//
//   1. Se recorre CADA plano del dibujo, uno por uno, encuadrandolo entero.
//   2. En cada uno se hacen 4 paradas mas: las cuatro esquinas del plano con
//      zoom fuerte. Ahi es donde fallaba el descarte por frustum, porque la
//      caja de la imagen se calculaba sin aplicar su matriz.
//   3. En cada parada se comprueba DOS cosas:
//        - que las imagenes que caen en pantalla tengan bitmap
//        - que el lienzo TENGA CONTENIDO de verdad (un bitmap cargado pero
//          descartado por culling da 100% de cobertura y pantalla vacia)
//   4. Al final se vuelve al encuadre inicial y se compara contra la foto del
//      principio.
//
//   ORIGEN=http://127.0.0.1:8788 node scripts/e2e-perdida-imagenes.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const CACHE_DIR = path.resolve(".cache/concepts");
const OUT = path.resolve(".cache/perdida");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const ORIGEN = process.env.ORIGEN || "";
const THROTTLE = Number(process.env.THROTTLE || 4);
const TIER = process.env.TIER || "baja";
const TOP = Number(process.env.TOP || 1);
const MAX_PLANOS = Number(process.env.MAX_PLANOS || 6);

await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const objetivos = process.argv[2]
  ? [manifest.files.find((f) => f.id === process.argv[2])].filter(Boolean)
  : manifest.files.filter((f) => f.size).sort((a, b) => b.size - a.size).slice(0, TOP);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 900000,
});

let fallosTotales = 0;
const informe = [];

for (const f of objetivos) {
  console.log(`\n${"=".repeat(74)}\n${f.name} — ${(f.size / 1048576).toFixed(1)} MB\n${"=".repeat(74)}`);
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  await page.setViewport({ width: 360, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message.slice(0, 160)));

  const url = `${BASE}/?tier=${TIER}&file=${f.id}${ORIGEN ? `&origen=${encodeURIComponent(ORIGEN)}` : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.emulateCPUThrottling(THROTTLE);
  await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
  await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));

  // Cajas de cada imagen COLOCADA, en coordenadas del documento.
  const cajas = await page.evaluate(() => window.__viewerCajas?.() ?? []);
  const vistaInicial = await page.evaluate(() => window.__viewerVista?.());

  /**
   * Estado del lienzo tras esperar a que se asiente el refinado.
   *
   * `pctPapel` es la medida que de verdad detecta una imagen perdida: mira
   * SOLO los pixeles que caen donde va el plano y cuenta cuantos son papel
   * (claros) en vez del fondo del lienzo. Contar "pixeles distintos del fondo"
   * en TODA la pantalla no sirve aca, porque un plano arquitectonico es casi
   * todo blanco y mirado de cerca casi no tiene tinta: daba 3% y parecia un
   * fallo cuando estaba perfecto.
   *
   * Se muestrea dentro del CUADRILATERO real del plano intersecado con la
   * pantalla, no dentro de su caja contenedora. Con la caja, en las paradas de
   * esquina se terminaba midiendo una franja de 13 px —el 0,8% de la pantalla,
   * contra el 55% en la parada del centro— y ese numero es ruido: daba 0% o
   * 100% segun un par de pixeles, asi que la mitad de las esquinas "fallaba"
   * en cualquier version del visor, incluidas las que dibujan el plano nitido
   * y legible. Ademas casi todos los planos entran rotados, asi que la caja
   * contiene bastante aire que no es parte del plano.
   */
  const medir = async (esperaMs, caja) => {
    await new Promise((r) => setTimeout(r, esperaMs));
    return page.evaluate((caja) => {
      const c = document.querySelector("canvas");
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const esFondo = (r, g, b) => (r > 244 && g > 244 && b > 244) || (r < 30 && g < 32 && b < 38);
      let contenido = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 29) {
        n++;
        if (!esFondo(d[i], d[i + 1], d[i + 2])) contenido++;
      }

      let pctPapel = null;
      let pctPantallaMedida = null;
      if (caja && caja.quad) {
        const v = window.__viewerVista();
        const dpr = c.width / c.clientWidth;
        const aPantalla = ([x, y]) => [(x * v.zoom + v.panX) * dpr, (y * v.zoom + v.panY) * dpr];
        const poly = caja.quad.map(aPantalla);
        // Se encoge el cuadrilatero hacia su centro para no muestrear el borde
        // mismo, donde el antialias mezcla papel y fondo.
        const cxp = poly.reduce((a, p) => a + p[0], 0) / 4;
        const cyp = poly.reduce((a, p) => a + p[1], 0) / 4;
        const dentroPoly = poly.map(([x, y]) => [cxp + (x - cxp) * 0.96, cyp + (y - cyp) * 0.96]);
        const enPoly = (px, py) => {
          let s = 0;
          for (let i = 0; i < 4; i++) {
            const [ax, ay] = dentroPoly[i];
            const [bx, by] = dentroPoly[(i + 1) % 4];
            const cr = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
            if (cr > 0) s++;
            else if (cr < 0) s--;
          }
          return Math.abs(s) === 4;
        };
        const x0 = Math.max(0, Math.floor(Math.min(...dentroPoly.map((p) => p[0]))));
        const x1 = Math.min(c.width - 1, Math.ceil(Math.max(...dentroPoly.map((p) => p[0]))));
        const y0 = Math.max(0, Math.floor(Math.min(...dentroPoly.map((p) => p[1]))));
        const y1 = Math.min(c.height - 1, Math.ceil(Math.max(...dentroPoly.map((p) => p[1]))));
        if (x1 > x0 && y1 > y0) {
          let papel = 0;
          let m = 0;
          const pasoX = Math.max(1, Math.floor((x1 - x0) / 120));
          const pasoY = Math.max(1, Math.floor((y1 - y0) / 120));
          for (let y = y0; y <= y1; y += pasoY) {
            for (let x = x0; x <= x1; x += pasoX) {
              if (!enPoly(x, y)) continue;
              const i = (y * c.width + x) * 4;
              m++;
              // Papel = claro. El fondo del lienzo es oscuro (tema oscuro) o
              // gris de la grilla; el hueco de una imagen sin cargar tambien.
              if (d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150) papel++;
            }
          }
          // Cuantos pixeles REALES de pantalla se miraron. Si es una miseria,
          // el porcentaje no dice nada y no hay que tratarlo como veredicto.
          pctPantallaMedida = +(((x1 - x0) * (y1 - y0) * 100) / (c.width * c.height)).toFixed(2);
          pctPapel = m >= 40 ? +((papel / m) * 100).toFixed(1) : null;
        }
      }

      return {
        pctContenido: +((contenido / n) * 100).toFixed(2),
        pctPapel,
        pctPantallaMedida,
        ...(window.__viewerCobertura?.() ?? {}),
      };
    }, caja || null);
  };

  const inicial = await medir(300, null);
  await page.screenshot({ path: path.join(OUT, `${f.id}-0-inicial.png`) });

  // Los planos grandes primero: son los que el usuario mira.
  const planos = [...cajas]
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
    .slice(0, MAX_PLANOS);

  const paradas = [];
  for (const caja of planos) {
    const w = caja.x1 - caja.x0;
    const h = caja.y1 - caja.y0;
    // El plano entero, y despues sus cuatro esquinas con zoom fuerte: ahi es
    // donde la caja mal calculada hacia desaparecer la imagen.
    paradas.push({ tipo: "entero", id: caja.resourceId, caja, cx: caja.x0 + w / 2, cy: caja.y0 + h / 2, cubrir: Math.max(w, h) * 1.1 });
    for (const [fx, fy] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
      paradas.push({
        tipo: `esquina ${fx < 0.5 ? "izq" : "der"}-${fy < 0.5 ? "arr" : "aba"}`,
        id: caja.resourceId,
        caja,
        cx: caja.x0 + w * fx,
        cy: caja.y0 + h * fy,
        cubrir: Math.max(w, h) / 6,
      });
    }
  }

  console.log(`  ${cajas.length} imagenes colocadas | ${planos.length} planos recorridos | ${paradas.length} paradas`);
  let fallos = 0;
  let peorContenido = 100;

  for (const [i, p] of paradas.entries()) {
    await page.evaluate((p) => {
      const c = document.querySelector("canvas");
      const anchoCss = c.clientWidth;
      const altoCss = c.clientHeight;
      const zoom = Math.min(anchoCss, altoCss) / p.cubrir;
      window.__viewerFijarVista({
        zoom,
        panX: anchoCss / 2 - p.cx * zoom,
        panY: altoCss / 2 - p.cy * zoom,
      });
    }, p);

    // Primero al instante (lo que ve el usuario apenas suelta) y despues
    // asentado (tras el refinado). Las dos importan: si al instante queda en
    // blanco, el usuario ve que "se perdio" aunque despues vuelva.
    const alInstante = await medir(250, p.caja);
    const asentado = await medir(3500, p.caja);

    const falta = asentado.visiblesConBitmap < asentado.visibles;
    // El plano tiene que estar PINTADO donde va. Si la cobertura dice que
    // estan todos los bitmaps y aun asi el rectangulo del plano esta al color
    // del fondo, se perdio al dibujar (descarte por frustum) y no al cargar.
    const sinPapel = asentado.pctPapel !== null && asentado.pctPapel < 60;
    if (asentado.pctPapel !== null && asentado.pctPapel < peorContenido) peorContenido = asentado.pctPapel;

    if (falta || sinPapel) {
      fallos++;
      fallosTotales++;
      console.log(
        `  FALLA parada ${i} (${p.tipo} de ${p.id.slice(0, 8)}): bitmap ${asentado.visiblesConBitmap}/${asentado.visibles}, papel ${asentado.pctPapel}% (al instante ${alInstante.pctPapel}%, se midio el ${asentado.pctPantallaMedida}% de la pantalla) faltan=${(asentado.faltantes || []).join(",")}`
      );
      if (fallos <= 4) await page.screenshot({ path: path.join(OUT, `${f.id}-falla-${i}.png`) });
    }
    informe.push({
      archivo: f.name,
      parada: i,
      tipo: p.tipo,
      recurso: p.id.slice(0, 8),
      visibles: asentado.visibles,
      conBitmap: asentado.visiblesConBitmap,
      pctPapelInstante: alInstante.pctPapel,
      pctPapelAsentado: asentado.pctPapel,
      ok: !falta && !sinPapel,
    });
  }

  // Volver al encuadre inicial y comparar con el estado de partida.
  await page.evaluate((v) => window.__viewerFijarVista(v), vistaInicial);
  const vuelta = await medir(4000, null);
  await page.screenshot({ path: path.join(OUT, `${f.id}-9-vuelta.png`) });

  const perdioAlVolver = vuelta.pctContenido < inicial.pctContenido * 0.9;
  if (perdioAlVolver) fallosTotales++;

  console.log(`  peor cobertura de PAPEL dentro del plano: ${peorContenido}%  (100% = el plano se ve entero)`);
  console.log(
    `  al volver al encuadre inicial: ${inicial.pctContenido}% -> ${vuelta.pctContenido}% de contenido, bitmaps ${inicial.visiblesConBitmap}/${inicial.visibles} -> ${vuelta.visiblesConBitmap}/${vuelta.visibles}  ${perdioAlVolver ? "FALLA" : "OK"}`
  );
  console.log(`  ${fallos === 0 ? "OK   ninguna parada perdio imagenes" : `FALLAN ${fallos} de ${paradas.length} paradas`}`);
  if (errores.length) console.log(`  errores: ${[...new Set(errores)].slice(0, 3).join(" | ")}`);
  await page.close();
}

await writeFile(path.join(OUT, "informe.json"), JSON.stringify(informe, null, 2));
console.log(`\n${fallosTotales === 0 ? "TODO OK: no se pierde ninguna imagen" : `${fallosTotales} FALLAS`}`);
console.log(`capturas en .cache/perdida/`);
await browser.close();
process.exit(fallosTotales === 0 ? 0 : 1);
