/**
 * Rasteriza PDFs y fotos FUERA del hilo principal.
 *
 * Es la diferencia entre "el dibujo se congela 24 segundos mientras cargan
 * las fotos" y "podes pan/zoom mientras aparecen". pdf.js hace un trabajo de
 * CPU intenso (~1,5 s por PDF en desktop, ~9 s en un telefono de gama baja),
 * y hacerlo en el hilo principal bloquea el render loop y los gestos.
 *
 * Devuelve ImageBitmap transferibles (coste cero al pasarlos al main thread).
 */

import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// Nota: se probo compartir UN solo `PDFWorker` entre todos los documentos
// para ahorrar los ~300 ms de arranque por PDF. No sirve con esta version de
// pdf.js: la unica forma de liberar el buffer del PDF es `loadingTask
// .destroy()`, y eso termina tambien el worker que se le paso, asi que el
// siguiente documento levanta uno nuevo igual (medido: 22 workers para 10
// PDFs, con y sin worker compartido). Entre "ahorrar el arranque" y "liberar
// la RAM del PDF", en un telefono de 1 GB gana liberar la RAM.

/**
 * Ultimos PDFs abiertos, para no volver a parsearlos en cada refinado.
 *
 * Cada vez que el usuario se acerca, el visor vuelve a rasterizar los planos
 * que se ven para que se lean nitidos. Sin este cache eso significaba abrir y
 * parsear el PDF ENTERO otra vez, que en estos planos (CAD, decenas de miles
 * de vectores) es el 95% del costo: medido sobre el dibujo mas pesado, una
 * tanda de gestos disparaba 42 rasterizaciones y 286 s de trabajo. Reusar la
 * pagina ya parseada deja el refinado en solo el dibujado.
 *
 * El tope es bajo a proposito: un PDF abierto retiene su buffer, y el
 * presupuesto de un telefono de 1 GB no da para tener muchos vivos. Con 2 por
 * worker alcanza, porque el que se refina es justo el que se acaba de usar.
 */
const MAX_PDFS_ABIERTOS = 2;

/**
 * Fabricas que pdf.js necesita para dibujar, en version APTA PARA WORKER.
 *
 * Por defecto pdf.js usa `DOMCanvasFactory` y `DOMFilterFactory`, que hacen
 * `globalThis.document.createElement(...)`. En un worker no hay `document`, y
 * en cuanto un PDF necesitaba un canvas auxiliar —grupos de transparencia,
 * mascaras suaves, patrones: cosas normales en un plano de CAD— el rasterizado
 * tiraba "Cannot read properties of undefined (reading 'createElement')".
 *
 * Ese error estaba siendo atrapado por el llamador, que en silencio rehacia el
 * trabajo en el hilo principal. O sea: el pool de workers se creaba, parecia
 * andar, y NO se usaba nunca. Medido en el dibujo mas pesado: 38 de 38
 * rasterizados terminaban en el hilo principal, 46,8 s de bloqueo con pdf.js
 * ejecutando listas de operadores encima del render loop. Era la causa de los
 * tirones al panear y hacer zoom.
 */
class FabricaCanvasWorker {
  private hwa: boolean;
  constructor({ enableHWA = false }: { enableHWA?: boolean } = {}) {
    this.hwa = enableHWA;
  }
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: !this.hwa }) };
  }
  reset({ canvas }: { canvas: OffscreenCanvas }, width: number, height: number) {
    if (!canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    canvas.width = width;
    canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    cc.canvas.width = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

/** Los filtros de pdf.js se implementan con SVG en el DOM. Sin DOM se
 * devuelve "none", que es exactamente lo que hace la version de Node. */
class FabricaFiltrosWorker {
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addKnockoutFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  addSelectionHCMFilter() { return "none"; }
  addSelectionFilter() { return "none"; }
  createSelectionStyle() { return null; }
  destroy() {}
}

interface PdfAbierto {
  tarea: { destroy(): Promise<void> };
  page: any;
  nativo: { width: number; height: number };
  usadoEn: number;
}

const abiertos = new Map<string, PdfAbierto>();
let reloj = 0;

async function cerrarPdf(resourceId: string) {
  const a = abiertos.get(resourceId);
  if (!a) return;
  abiertos.delete(resourceId);
  try {
    a.page.cleanup();
  } catch {
    /* ya limpio */
  }
  try {
    await a.tarea.destroy();
  } catch {
    /* ya destruido */
  }
}

async function abrirPdf(resourceId: string, blob: Blob): Promise<PdfAbierto> {
  const cacheado = abiertos.get(resourceId);
  if (cacheado) {
    cacheado.usadoEn = ++reloj;
    return cacheado;
  }

  const data = new Uint8Array(await blob.arrayBuffer());
  // `destroy()` vive en el loading task, no en el documento: hay que
  // guardarse la referencia para poder liberar el worker de pdf.js y el
  // buffer del PDF, que con 19 planos de varios MB es RAM que no vuelve sola.
  //
  // `disableFontFace` no es un ajuste de calidad: es lo que hace que esto
  // FUNCIONE aca adentro. Por defecto pdf.js registra las fuentes con
  // `FontFace` y `document.createElement`, y en un worker no hay `document`:
  // cada plano con texto tiraba "Cannot read properties of undefined (reading
  // 'createElement')", el llamador lo atrapaba en silencio y lo rasterizaba en
  // el hilo principal. O sea que el pool de workers existia pero no se usaba
  // nunca, y los 19 planos se dibujaban encima del render loop — 40,9 s de
  // hilo principal bloqueado al abrir el dibujo mas pesado. Con las fuentes
  // dibujadas como trazos el texto se ve igual y el trabajo queda donde tiene
  // que estar.
  const tarea = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    isOffscreenCanvasSupported: true,
    useSystemFonts: false,
    CanvasFactory: FabricaCanvasWorker,
    FilterFactory: FabricaFiltrosWorker,
  } as Parameters<typeof pdfjsLib.getDocument>[0]);
  const pdf = await tarea.promise;
  // El id puede venir como `uuid#2`: ese numero es la pagina del PDF que esta
  // colocada. pdf.js numera desde 1. Antes esto era `getPage(1)` fijo, asi que
  // un PDF colocado como varias paginas dibujaba la primera en todas.
  const nPagina = Number(resourceId.split("#")[1] ?? 0) + 1;
  const page = await pdf.getPage(Math.min(Math.max(1, nPagina), pdf.numPages));
  // rotation: 0 a proposito. Muchos de estos PDFs traen /Rotate=90, y por
  // defecto pdf.js YA aplica esa rotacion al viewport (una pagina de 842x3118
  // se reporta como 3118x842). Pero Concepts guarda la geometria del recurso
  // en el espacio SIN rotar, asi que usar el viewport rotado rasterizaba una
  // pagina apaisada dentro de una caja vertical y el plano salia aplastado.
  const nativo = page.getViewport({ scale: 1, rotation: 0 });

  const entrada: PdfAbierto = { tarea, page, nativo, usadoEn: ++reloj };
  abiertos.set(resourceId, entrada);

  while (abiertos.size > MAX_PDFS_ABIERTOS) {
    let masViejo: string | null = null;
    let peor = Infinity;
    for (const [id, a] of abiertos) {
      if (id !== resourceId && a.usadoEn < peor) {
        peor = a.usadoEn;
        masViejo = id;
      }
    }
    if (!masViejo) break;
    await cerrarPdf(masViejo);
  }
  return entrada;
}

interface PedidoRaster {
  id: number;
  resourceId: string;
  blob: Blob;
  /** Tamaño destino en px reales, ya clampeado por el que llama. */
  width: number;
  height: number;
  smoothing: ImageSmoothingQuality;
  /** Cierra todos los PDFs abiertos (al cerrar el dibujo). */
  limpiar?: boolean;
  /**
   * Porcion del recurso a rasterizar, en fracciones de 0 a 1 sobre su propio
   * ancho/alto. Sirve para que al hacer mucho zoom se gaste el presupuesto de
   * pixeles en lo que se ve, en vez de repartirlo por toda la pagina: un
   * plano de 1544x5717 mirado de cerca necesitaria 40 Mpx para verse nitido
   * entero, pero solo ~2 Mpx para el pedazo que entra en pantalla.
   */
  region?: { x: number; y: number; w: number; h: number };
  /**
   * Si viene, el worker ADEMAS produce un JPEG del resultado para el cache
   * persistente (ver `rasterCache.ts`), y lo devuelve junto al bitmap.
   *
   * Antes ese JPEG lo fabricaba el HILO PRINCIPAL (`guardarRaster` en
   * `rasterCache.ts`): tomaba el bitmap ya listo, lo volvia a dibujar en un
   * OffscreenCanvas NUEVO y recien ahi lo codificaba. Ese redibujado es
   * trabajo de compositing real —no gratis para un plano grande— y pasaba
   * SIEMPRE en el hilo principal aunque el rasterizado en si hubiera
   * corrido entero en el worker, justo mientras el usuario esta interactuando.
   * Medido con CPU profiling (`bench-cpu-profile.mjs`) sobre el dibujo mas
   * pesado del corpus: 2,8 s de self-time en esa funcion durante apertura +
   * zoom, el offender individual mas grande despues de idle/GC interno de V8.
   *
   * Aca no hace falta redibujar nada: el PDF ya esta pintado en `canvas`
   * (se codifica ANTES de `transferToImageBitmap`, que lo vacia) y la foto ya
   * esta decodificada en `bitmap` (un solo drawImage mas, pero en este hilo,
   * no en el principal). El costo de CODIFICAR el JPEG no se elimina —sigue
   * siendo el mismo trabajo de compresion— pero deja de competir con los
   * gestos del usuario por el hilo que los atiende.
   */
  cachear?: boolean;
}

/** Lo que devuelve `rasterizar`: el bitmap para mostrar, y si se pidio,
 * el JPEG ya codificado para el cache persistente. */
interface ResultadoRaster {
  bitmap: ImageBitmap;
  cacheBlob?: Blob;
}

/** JPEG 0.88, el mismo factor que usaba `guardarRaster` en el hilo
 * principal: un plano rasterizado pesa ~150 KB contra ~5 MB en PNG, sin
 * diferencia visible a esta escala. */
async function codificarCache(fuente: CanvasImageSource, w: number, h: number): Promise<Blob | undefined> {
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(fuente, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  } catch {
    // El cache es un lujo: si la codificacion falla (memoria, formato), el
    // bitmap para mostrar ya esta listo y se entrega igual.
    return undefined;
  }
}

async function rasterizar(p: PedidoRaster): Promise<ResultadoRaster> {
  const header = await p.blob.slice(0, 5).text();
  const reg = p.region;

  if (header === "%PDF-") {
    const { page, nativo } = await abrirPdf(p.resourceId, p.blob);
    const canvas = new OffscreenCanvas(p.width, p.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("sin contexto 2d en el worker");
    // Escala NO uniforme via el `transform` de pdf.js: el recurso se dibuja
    // despues estirado a un ancho/alto arbitrario, asi que rasterizarlo con
    // una escala unica (forzosamente la mayor) generaba canvases absurdos
    // (15278x5042 = 77 Mpx para algo que se muestra a 266x807).
    //
    // Con `region` ademas se recorta: la escala se calcula sobre el pedazo
    // pedido y se traslada para que ese pedazo caiga en 0,0 del canvas.
    const rx = (reg?.x ?? 0) * nativo.width;
    const ry = (reg?.y ?? 0) * nativo.height;
    const rw = (reg?.w ?? 1) * nativo.width;
    const rh = (reg?.h ?? 1) * nativo.height;
    const sx = p.width / rw;
    const sy = p.height / rh;
    try {
      await (page as any).render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: nativo,
        transform: [sx, 0, 0, sy, -rx * sx, -ry * sy],
      }).promise;
    } catch (err) {
      // Un render fallido puede dejar la pagina cacheada en un estado
      // invalido (canvas a medio pintar, operador no soportado). Sin esto el
      // proximo pedido del mismo recurso reusa la MISMA pagina rota via el
      // cache de abrirPdf y el error se vuelve permanente para ese recurso
      // hasta que lo desaloje el LRU; se descarta para forzar un reparseo
      // limpio en el proximo intento.
      await cerrarPdf(p.resourceId);
      throw err;
    }
    // El JPEG del cache se codifica ANTES de transferir: `convertToBlob` toma
    // una instantanea sin vaciar el canvas, pero `transferToImageBitmap` si
    // lo hace (deja el canvas en 0x0), asi que el orden importa.
    const cacheBlob = p.cachear ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 }) : undefined;
    // Sin page.cleanup(): tira justo lo que hace valiosa a la pagina cacheada
    // (las fuentes y los operadores ya decodificados). Se limpia al desalojarla.
    return { bitmap: canvas.transferToImageBitmap(), cacheBlob };
  }

  // --- Imagen raster ------------------------------------------------------
  //
  // Se decodifica DIRECTO al tamaño final, en una sola llamada. Antes se hacia
  // en dos pasos: `createImageBitmap(blob)` completo y despues otro para
  // achicar. Con las fotos de estos dibujos (3264x2448) el primer paso
  // materializa 32 MB de RGBA para terminar mostrando 300x225 px — y con dos
  // workers en paralelo son ~64 MB de pico transitorio sobre un presupuesto
  // total de 48 MB. Ese es el tipo de pico que mata la pestaña en un telefono
  // de 1 GB aunque el promedio se vea bien.
  //
  // Pasandole el tamaño a `createImageBitmap`, Chrome usa el decodificador
  // escalado de JPEG y nunca llega a materializar los 8 Mpx.
  const calidad = p.smoothing === "high" ? "high" : "medium";
  const nativo = await medirImagen(p.blob);

  // Un recorte (`reg`) es siempre transitorio (el zoom del momento) y nunca
  // se cachea (ver la condicion `cachear && !region` del lado principal), asi
  // que aca no hace falta mirar `p.cachear` en ninguna de las dos ramas de
  // abajo.
  if (reg) {
    if (!nativo) {
      // Sin poder leer el encabezado no se puede recortar en coordenadas de
      // origen; se cae al camino de dos pasos, que es correcto aunque caro.
      const base = await createImageBitmap(p.blob);
      const cx = Math.max(0, Math.round(reg.x * base.width));
      const cy = Math.max(0, Math.round(reg.y * base.height));
      const cw = Math.max(1, Math.min(base.width - cx, Math.round(reg.w * base.width)));
      const ch = Math.max(1, Math.min(base.height - cy, Math.round(reg.h * base.height)));
      const recorte = await createImageBitmap(base, cx, cy, cw, ch, {
        resizeWidth: Math.min(p.width, cw),
        resizeHeight: Math.min(p.height, ch),
        resizeQuality: calidad,
      });
      base.close();
      return { bitmap: recorte };
    }
    const cx = Math.max(0, Math.round(reg.x * nativo.w));
    const cy = Math.max(0, Math.round(reg.y * nativo.h));
    const cw = Math.max(1, Math.min(nativo.w - cx, Math.round(reg.w * nativo.w)));
    const ch = Math.max(1, Math.min(nativo.h - cy, Math.round(reg.h * nativo.h)));
    // El recorte se hace SOBRE EL BLOB: no se decodifica la foto entera.
    const bitmap = await createImageBitmap(p.blob, cx, cy, cw, ch, {
      resizeWidth: Math.min(p.width, cw),
      resizeHeight: Math.min(p.height, ch),
      resizeQuality: calidad,
    });
    return { bitmap };
  }

  let bitmap: ImageBitmap;
  if (!nativo) {
    bitmap = await createImageBitmap(p.blob);
  } else {
    // Nunca agrandar: pedir mas pixeles que los que tiene la foto no agrega
    // detalle y si gasta memoria.
    const w = Math.min(p.width, nativo.w);
    const h = Math.min(p.height, nativo.h);
    bitmap =
      w >= nativo.w && h >= nativo.h
        ? await createImageBitmap(p.blob)
        : await createImageBitmap(p.blob, { resizeWidth: w, resizeHeight: h, resizeQuality: calidad });
  }
  // A diferencia del PDF (que ya tenia un canvas pintado, listo para
  // codificar sin redibujar), una foto sale de `createImageBitmap` sin
  // canvas de por medio: codificar su cache SI implica un drawImage extra
  // aca. Sigue valiendo la pena moverlo: el bitmap resultante ya esta
  // ACHICADO al tamaño de pantalla (ver comentario mas arriba sobre decodificar
  // directo al tamaño final), asi que este drawImage es sobre una imagen
  // chica, no sobre los 8 Mpx originales — y de cualquier forma pasa en este
  // hilo, no en el que atiende los gestos del usuario.
  const cacheBlob = p.cachear ? await codificarCache(bitmap, bitmap.width, bitmap.height) : undefined;
  return { bitmap, cacheBlob };
}

/**
 * Ancho y alto de una imagen leyendo SOLO el encabezado, sin decodificarla.
 *
 * Decodificar una foto de 8 Mpx para averiguar cuanto mide cuesta 32 MB de
 * RAM; el encabezado esta en los primeros cientos de bytes. Devuelve null si
 * el formato no se reconoce, y ahi el llamador se las arregla.
 */
async function medirImagen(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const buf = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // PNG: el IHDR va siempre en el mismo lugar.
    if (buf.length > 24 && v.getUint32(0) === 0x89504e47) {
      return { w: v.getUint32(16), h: v.getUint32(20) };
    }

    // JPEG: se recorren los marcadores hasta un SOF (que trae las medidas).
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marcador = buf[i + 1];
        // SOF0..SOF15, salteando los que no describen una trama.
        if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
          return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
        }
        if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
          i += 2;
          continue;
        }
        i += 2 + v.getUint16(i + 2);
      }
    }
    return null;
  } catch {
    return null;
  }
}

self.onmessage = async (e: MessageEvent<PedidoRaster>) => {
  const p = e.data;
  if (p.limpiar) {
    // En paralelo: son PDFs independientes (a lo sumo MAX_PDFS_ABIERTOS = 2),
    // esperarlos uno por uno solo suma la latencia de destroy() de cada uno.
    await Promise.all([...abiertos.keys()].map((id) => cerrarPdf(id)));
    (self as unknown as Worker).postMessage({ id: p.id, limpio: true });
    return;
  }
  try {
    const { bitmap, cacheBlob } = await rasterizar(p);
    // Solo el bitmap se transfiere (coste cero): el Blob del cache viaja por
    // structured clone, que para un Blob no copia los bytes, solo el handle.
    (self as unknown as Worker).postMessage(
      { id: p.id, resourceId: p.resourceId, bitmap, cacheBlob, width: bitmap.width, height: bitmap.height },
      [bitmap as unknown as Transferable]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: p.id,
      resourceId: p.resourceId,
      error: String(err).slice(0, 300),
    });
  }
};
