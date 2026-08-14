import type { Document } from "../VisorConcept/parser";
import { getBudgets, soportaOffscreen } from "../device";
import { leerRaster, guardarRaster } from "./rasterCache";

// Las coordenadas del documento se asumen en px CSS (96 DPI, el estandar
// web). Para que los PDF/JPG exportados salgan nitidos, todo export
// renderiza el canvas a esta escala (mas pixeles reales) mientras el
// tamaño logico de pagina/imagen queda igual. 150 DPI no alcanzaba para
// leer texto fino (ej. un ticket fotografiado como fondo) porque las
// imagenes se dibujan chicas dentro de un documento con un bbox tambien
// chico — 600 DPI (el estandar para escaneos legibles/OCR) da suficiente
// densidad de pixeles para que ese texto se pueda leer.
export const EXPORT_DPI = 600;
const BASE_DPI = 96;
export const EXPORT_SCALE = EXPORT_DPI / BASE_DPI;

// Los canvas del navegador tienen limites duros (Chrome: 65535 px por lado y
// ~268 Mpx de area; Safari/iOS bastante menos). Pasarse no tira error: el
// canvas queda en blanco. Un dibujo grande a 600 DPI se pasa facil, asi que
// el export baja la escala lo necesario en vez de exportar una hoja vacia.
const MAX_CANVAS_SIDE = 16384;

/** Escala de export efectiva para un tamaño logico dado: EXPORT_SCALE salvo
 * que el canvas resultante no entre, en cuyo caso se reduce lo justo.
 *
 * El techo de area sale del presupuesto del dispositivo: en un telefono de
 * 1 GB un canvas de 120 Mpx son 480 MB y Android mata la pestaña antes de
 * terminar el export, asi que ahi el tope baja a 24 Mpx (96 MB). */
export function safeExportScale(logicalWidth: number, logicalHeight: number): number {
  const maxPixels = getBudgets().maxExportPixels;
  let scale = EXPORT_SCALE;
  const w = logicalWidth * scale;
  const h = logicalHeight * scale;
  const porLado = Math.min(MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, 1);
  scale *= porLado;
  const area = logicalWidth * scale * logicalHeight * scale;
  if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
  return Math.max(scale, 1);
}

/** true si el export tuvo que bajar la calidad por el limite del dispositivo
 * (sirve para avisarle al usuario en vez de dar una imagen peor en silencio). */
export function exportFueRecortado(logicalWidth: number, logicalHeight: number): boolean {
  return safeExportScale(logicalWidth, logicalHeight) < EXPORT_SCALE - 0.001;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/** pdf.js se carga una sola vez por sesion (es pesado) y con el worker local:
 * los navegadores bloquean crear un Worker desde otro origen (ej. un CDN)
 * aunque el CORS este bien, es una restriccion de seguridad aparte. */
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Porcion de un recurso, en fracciones 0..1 de su propio ancho/alto. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResourceTarget {
  /** Ancho en PIXELES REALES que va a ocupar el recurso en el canvas destino. */
  width: number;
  /** Alto en PIXELES REALES que va a ocupar el recurso en el canvas destino. */
  height: number;
  /**
   * Si viene, se rasteriza SOLO ese pedazo del recurso (y `width`/`height`
   * son los pixeles de ESE pedazo). Es lo que permite ver nitido un plano
   * enorme al acercarse: en vez de repartir el techo de pixeles por toda la
   * pagina, se gasta entero en lo que entra en pantalla.
   */
  region?: Region;
}

/** Un recurso ya rasterizado, junto con que pedazo del original representa. */
export interface RecursoRasterizado {
  img: CanvasImageSource;
  /** null = la imagen cubre el recurso completo. */
  region: Region | null;
}

export interface LoadResourcesOptions {
  /** Tamaño de destino por recurso, en px reales del canvas final. */
  targets?: Record<string, ResourceTarget>;
  /** Multiplicador sobre el target (headroom para hacer zoom sin ver borroso). */
  quality?: number;
  /** Techo de pixeles por recurso. Evita rasterizar un PDF a 77 Mpx. */
  maxPixels?: number;
  /** Techo de pixeles SUMANDO todos los recursos. Es el que evita que un
   * dibujo con 19 planos se coma 300 MB en un telefono de 1 GB. */
  maxTotalPixels?: number;
  /** Piso de lado mayor, para que un recurso sin target no quede ilegible. */
  minSide?: number;
  timeoutMs?: number;
  /** Cuantos recursos se rasterizan a la vez. Rasterizar un PDF usa el mismo
   * worker de pdf.js y el mismo hilo de canvas, asi que lanzar 20 juntos no
   * los hace mas rapidos: los hace competir y tardar todos. */
  concurrency?: number;
  /** Se llama apenas UN recurso esta listo, sin esperar al resto. Permite que
   * las fotos vayan apareciendo en el lienzo de a una en vez de que no se vea
   * ninguna hasta que termine la ultima. */
  onEach?: (resourceId: string, recurso: RecursoRasterizado) => void;
  /** Corta el trabajo pendiente (ej. el usuario cerro el dibujo). */
  signal?: AbortSignal;
  /** Solo estos recursos (y en este orden). Se usa para cargar primero lo
   * que se ve en pantalla. */
  only?: string[];
  /** Identidad del archivo, para el cache persistente de rasterizados. */
  fileId?: string;
  /** Desactiva el cache persistente (ej. export, que pide otra resolucion). */
  sinCache?: boolean;
  /** Fuerza rasterizar en el hilo principal (para tests/fallback). */
  sinWorker?: boolean;
  /** Pixeles ya gastados por una llamada anterior sobre el MISMO documento.
   * El visor carga en dos tandas (primero lo visible, despues el resto), y
   * sin esto la segunda tanda arrancaria con el presupuesto entero de nuevo:
   * el techo de RAM valdria el doble de lo previsto. */
  pixelesYaUsados?: number;
}

/** Contadores del cache persistente, para poder medir si de verdad sirve en
 * vez de suponerlo (el cache ya fallo silenciosamente una vez: guardaba el
 * tamaño recortado y lo comparaba contra el pedido, asi que nunca acertaba). */
export const statsCache = { aciertos: 0, fallos: 0 };

/** Corre `worker` sobre `items` con un maximo de `limit` en vuelo. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let idx = 0;
  const next = async (): Promise<void> => {
    const current = idx++;
    if (current >= items.length) return;
    await worker(items[current]);
    return next();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

// --- Pool de workers de rasterizado --------------------------------------
// Un worker por slot de concurrencia, creados perezosamente y reutilizados
// toda la sesion: instanciar un worker con pdf.js adentro cuesta ~300 ms.

interface SlotWorker {
  worker: Worker;
  ocupado: boolean;
  pendientes: Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>;
}

let pool: SlotWorker[] = [];
let siguienteId = 1;
let workersRotos = false;

function crearSlot(): SlotWorker | null {
  try {
    const worker = new Worker(new URL("./raster.worker.ts", import.meta.url), { type: "module" });
    const slot: SlotWorker = { worker, ocupado: false, pendientes: new Map() };
    worker.onmessage = (e: MessageEvent) => {
      const { id, bitmap, error } = e.data || {};
      const p = slot.pendientes.get(id);
      if (!p) return;
      slot.pendientes.delete(id);
      slot.ocupado = false;
      if (error) p.reject(new Error(error));
      else p.resolve(bitmap as ImageBitmap);
    };
    worker.onerror = () => {
      // Si el worker se cae (ej. OOM), se marca el pool como roto y todo lo
      // que sigue se rasteriza en el hilo principal.
      workersRotos = true;
      slot.pendientes.forEach((p) => p.reject(new Error("worker de rasterizado caido")));
      slot.pendientes.clear();
      slot.ocupado = false;
    };
    return slot;
  } catch {
    workersRotos = true;
    return null;
  }
}

function tomarSlot(): SlotWorker | null {
  if (workersRotos || !soportaOffscreen()) return null;
  const libre = pool.find((s) => !s.ocupado);
  if (libre) {
    libre.ocupado = true;
    return libre;
  }
  if (pool.length >= getBudgets().concurrency) return null;
  const nuevo = crearSlot();
  if (!nuevo) return null;
  nuevo.ocupado = true;
  pool.push(nuevo);
  return nuevo;
}

function rasterizarEnWorker(
  slot: SlotWorker,
  resourceId: string,
  blob: Blob,
  width: number,
  height: number,
  region?: Region
): Promise<ImageBitmap> {
  const id = siguienteId++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    slot.pendientes.set(id, { resolve, reject });
    slot.worker.postMessage({
      id,
      resourceId,
      blob,
      width,
      height,
      region,
      smoothing: getBudgets().smoothing,
    });
  });
}

/** Cierra los workers (al cerrar un dibujo no hace falta, se reutilizan; esto
 * es para tests y para liberar en memoria muy justa). */
export function cerrarWorkersRaster() {
  pool.forEach((s) => s.worker.terminate());
  pool = [];
}

/**
 * Calcula, por recurso, el tamaño en UNIDADES DEL DOCUMENTO al que
 * efectivamente se dibuja. Ojo: `img.width/height` es el tamaño NATIVO del
 * recurso, no el dibujado — la matriz de transform (que suele achicar
 * bastante, ej. una foto encogida a un rincon del dibujo) es la que manda.
 * Si el mismo recurso aparece varias veces, gana la aparicion mas grande.
 */
export function drawnSizes(doc: Document): Record<string, { width: number; height: number }> {
  const out: Record<string, { width: number; height: number }> = {};
  doc.layers.forEach((layer) => {
    layer.images.forEach((img) => {
      if (!img.resourceId) return;
      const m = img.transform;
      const sx = m && m.length === 16 ? Math.hypot(m[0], m[1]) : 1;
      const sy = m && m.length === 16 ? Math.hypot(m[4], m[5]) : 1;
      const w = Math.abs((img.width || 0) * sx);
      const h = Math.abs((img.height || 0) * sy);
      const prev = out[img.resourceId];
      if (!prev || w * h > prev.width * prev.height) out[img.resourceId] = { width: w, height: h };
    });
  });
  return out;
}

/**
 * Ajusta el tamaño pedido a los limites.
 *
 * `vectorial` distingue dos casos que NO se pueden tratar igual:
 *
 *  - Un PDF no tiene "resolucion nativa": pdf.js lo rasteriza a lo que se le
 *    pida y mas pixeles es literalmente mas nitidez. Se respeta el pedido.
 *  - Un bitmap si tiene pixeles reales; pedir mas que eso no agrega detalle.
 *    El tope se aplica EJE POR EJE, no con un factor unico: el documento
 *    suele estirar los recursos de forma no uniforme (un plano de 2551x842
 *    dibujado en una caja de 266x807), y bajar los dos ejes por el factor
 *    del eje mas estirado tiraba a la basura la resolucion del otro — que
 *    es justo donde esta el texto que hay que poder leer.
 */
function clampTarget(
  width: number,
  height: number,
  nativeW: number,
  nativeH: number,
  vectorial: boolean,
  opts: Required<Pick<LoadResourcesOptions, "maxPixels" | "minSide">>
): { width: number; height: number } {
  let w = width;
  let h = height;
  if (!(w > 0) || !(h > 0)) {
    // Sin target util: se usa el nativo como referencia.
    w = nativeW;
    h = nativeH;
  }
  if (!vectorial) {
    w = Math.min(w, nativeW);
    h = Math.min(h, nativeH);
  }
  // Piso: que el lado mayor tenga al menos minSide px, para que un recurso
  // dibujado muy chico igual se vea decente al hacer zoom.
  const mayor = Math.max(w, h);
  if (mayor < opts.minSide) {
    let k = opts.minSide / mayor;
    if (!vectorial) k = Math.min(k, Math.max(1, Math.min(nativeW / w, nativeH / h)));
    w *= k;
    h *= k;
  }
  // Techo por area.
  const px = w * h;
  if (px > opts.maxPixels) {
    const k = Math.sqrt(opts.maxPixels / px);
    w *= k;
    h *= k;
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/** Rasteriza en el hilo principal. Fallback cuando no hay OffscreenCanvas
 * (Safari viejo) o el worker se cayo. */
async function rasterizarEnMain(
  blob: Blob,
  width: number,
  height: number,
  vectorial: boolean,
  region?: Region
): Promise<CanvasImageSource> {
  if (vectorial) {
    const pdfjsLib = await getPdfjs();
    const url = URL.createObjectURL(blob);
    // destroy() esta en el loading task, no en el documento; sin llamarlo el
    // worker de pdf.js y el buffer del PDF quedan vivos.
    const tarea = pdfjsLib.getDocument({ url });
    try {
      const pdf = await tarea.promise;
      const page = await pdf.getPage(1);
      const nativo = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("sin contexto 2d");
      // Misma matematica que en el worker: con region se escala sobre el
      // pedazo pedido y se traslada para dejarlo en 0,0.
      const rx = (region?.x ?? 0) * nativo.width;
      const ry = (region?.y ?? 0) * nativo.height;
      const rw = (region?.w ?? 1) * nativo.width;
      const rh = (region?.h ?? 1) * nativo.height;
      const sx = width / rw;
      const sy = height / rh;
      await (page as any).render({
        canvasContext: ctx,
        viewport: nativo,
        transform: [sx, 0, 0, sy, -rx * sx, -ry * sy],
      }).promise;
      page.cleanup();
      return canvas;
    } finally {
      void tarea.destroy();
      URL.revokeObjectURL(url);
    }
  }

  const base = await createImageBitmap(blob);
  if (region) {
    const cx = Math.max(0, Math.round(region.x * base.width));
    const cy = Math.max(0, Math.round(region.y * base.height));
    const cw = Math.max(1, Math.min(base.width - cx, Math.round(region.w * base.width)));
    const ch = Math.max(1, Math.min(base.height - cy, Math.round(region.h * base.height)));
    const recorte = await createImageBitmap(base, cx, cy, cw, ch, {
      resizeWidth: Math.min(width, cw),
      resizeHeight: Math.min(height, ch),
      resizeQuality: getBudgets().smoothing === "high" ? "high" : "medium",
    });
    base.close();
    return recorte;
  }
  if (width >= base.width && height >= base.height) return base;
  const chico = await createImageBitmap(base, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: getBudgets().smoothing === "high" ? "high" : "medium",
  });
  base.close();
  return chico;
}

/** Tamaño nativo de un recurso, sin rasterizarlo (para poder clampear bien
 * antes de gastar el trabajo pesado). */
async function tamañoNativo(blob: Blob, vectorial: boolean): Promise<{ w: number; h: number }> {
  if (vectorial) {
    const pdfjsLib = await getPdfjs();
    const url = URL.createObjectURL(blob);
    const tarea = pdfjsLib.getDocument({ url });
    try {
      const pdf = await tarea.promise;
      const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
      return { w: vp.width, h: vp.height };
    } finally {
      void tarea.destroy();
      URL.revokeObjectURL(url);
    }
  }
  // Para bitmaps alcanza con decodificar la cabecera; createImageBitmap ya
  // decodifica todo, asi que se aprovecha el resultado en el llamador.
  const bm = await createImageBitmap(blob);
  const r = { w: bm.width, h: bm.height };
  bm.close();
  return r;
}

/**
 * Carga las imagenes/PDFs embebidos del documento, rasterizando cada uno al
 * tamaño que REALMENTE va a ocupar en el canvas destino (ver `targets`) en
 * vez de a una escala fija. Un recurso lento o roto no traba el resto: se
 * omite tras el timeout y sigue.
 *
 * Tres cosas lo hacen apto para gama baja:
 *  - Los bytes de cada recurso se piden A DEMANDA (rango HTTP), no estan
 *    todos en memoria de entrada.
 *  - Hay un presupuesto GLOBAL de pixeles: pasado ese punto, los recursos
 *    restantes se rasterizan cada vez mas chicos en vez de reventar la RAM.
 *  - El trabajo pesado (pdf.js) va a un worker, asi el hilo principal sigue
 *    respondiendo a los gestos mientras cargan las fotos.
 */
export async function loadResourceImages(
  doc: Document,
  options: LoadResourcesOptions = {}
): Promise<Record<string, RecursoRasterizado>> {
  const budgets = getBudgets();
  const opts = {
    quality: options.quality ?? 1,
    maxPixels: options.maxPixels ?? budgets.maxPixelsPerResource,
    minSide: options.minSide ?? 64,
  };
  const maxTotal = options.maxTotalPixels ?? budgets.maxImagePixels;
  const timeoutMs = options.timeoutMs ?? 30000;
  const concurrency = options.concurrency ?? budgets.concurrency;
  const loaded: Record<string, RecursoRasterizado> = {};

  // Orden: lo pedido explicitamente (lo visible) primero; si no, del recurso
  // mas chico al mas grande, que es el que aparece antes en pantalla.
  const pendientes = options.only ?? doc.resourceIds;

  // Presupuesto global. Se reparte por orden de llegada: lo que se ve primero
  // se lleva la resolucion buena, y si al final no queda, los ultimos se
  // rasterizan mas chicos (visibles pero menos nitidos) en vez de no cargar.
  let pixelesUsados = options.pixelesYaUsados ?? 0;

  // --- Paso 1: resolver el cache persistente ANTES de tocar la red --------
  // Lo que ya se rasterizo en una sesion anterior no hay que volver a bajarlo
  // NI volver a rasterizarlo. Hacer esto antes del prefetch es lo que hace
  // que reabrir un dibujo no cueste red: si se adelantan los bytes primero,
  // se bajan 12 MB para despues descubrir que estaban todos cacheados.
  const faltantes: string[] = [];
  if (options.fileId && !options.sinCache) {
    await runPool(pendientes, 4, async (resourceId) => {
      if (options.signal?.aborted) return;
      const target = options.targets?.[resourceId];
      // Si se pidio un RECORTE no se consulta el cache: ahi solo hay
      // rasterizados de la pagina COMPLETA, y devolver uno haciendolo pasar
      // por el recorte dibujaria la pagina entera dentro del sub-rectangulo
      // (el plano aparecia encogido en una esquina). Ademas el recorte existe
      // justamente porque hace falta MAS resolucion de la que hay guardada.
      if (target?.region) {
        statsCache.fallos++;
        faltantes.push(resourceId);
        return;
      }
      const cacheado = await leerRaster(
        options.fileId!,
        resourceId,
        (target?.width ?? 0) * opts.quality,
        (target?.height ?? 0) * opts.quality
      );
      if (cacheado) {
        statsCache.aciertos++;
        // Lo guardado es SIEMPRE la pagina completa (los recortes no se
        // cachean), asi que la region es null por construccion.
        const entrada: RecursoRasterizado = { img: cacheado as CanvasImageSource, region: null };
        loaded[resourceId] = entrada;
        pixelesUsados += cacheado.width * cacheado.height;
        if (!options.signal?.aborted) options.onEach?.(resourceId, entrada);
      } else {
        statsCache.fallos++;
        faltantes.push(resourceId);
      }
    });
  } else {
    faltantes.push(...pendientes);
  }
  if (faltantes.length === 0 || options.signal?.aborted) return loaded;

  // --- Paso 2: adelantar los bytes de lo que SI falta ---------------------
  // Los recursos estan contiguos en el .concepts, asi que pedirlos de a uno
  // gastaba una ida y vuelta HTTP por recurso. No se espera a que termine del
  // todo antes de empezar a rasterizar: el pool arranca en paralelo y los
  // primeros recursos ya salen del bloque que llego.
  const adelanto = doc.prefetchResources(faltantes).catch(() => {});

  await runPool(faltantes, concurrency, async (resourceId) => {
    if (options.signal?.aborted) return;
    try {
      await withTimeout(
        (async () => {
          const target = options.targets?.[resourceId];
          const pedidoW = (target?.width ?? 0) * opts.quality;
          const pedidoH = (target?.height ?? 0) * opts.quality;

          // Cuanto presupuesto queda. Si ya se gasto casi todo, se rasteriza
          // al minimo legible en vez de saltear el recurso.
          const restante = Math.max(maxTotal - pixelesUsados, 500_000);
          const techoRecurso = Math.min(opts.maxPixels, restante);

          const cachear = !!options.fileId && !options.sinCache;

          // Bajar los bytes (rango HTTP en un archivo remoto). El cache ya se
          // consulto arriba: aca solo llegan los que hay que rasterizar.
          const blob = await doc.loadResource(resourceId);
          if (!blob || options.signal?.aborted) return;

          const header = await blob.slice(0, 5).text();
          const vectorial = header === "%PDF-";
          const nativo = await tamañoNativo(blob, vectorial);
          const region = target?.region;
          // Con region, el "nativo" relevante es el del pedazo, no el de la
          // pagina entera: si no, el clamp de un bitmap creeria que se le
          // pide mas resolucion de la que tiene y lo achicaria de mas.
          const natW = region ? nativo.w * region.w : nativo.w;
          const natH = region ? nativo.h * region.h : nativo.h;
          const { width, height } = clampTarget(pedidoW, pedidoH, natW, natH, vectorial, {
            maxPixels: techoRecurso,
            minSide: opts.minSide,
          });
          if (options.signal?.aborted) return;

          // Rasterizar, preferentemente fuera del hilo principal.
          let img: CanvasImageSource | null = null;
          const slot = options.sinWorker ? null : tomarSlot();
          if (slot) {
            try {
              img = await rasterizarEnWorker(slot, resourceId, blob, width, height, region);
            } catch {
              slot.ocupado = false;
              img = await rasterizarEnMain(blob, width, height, vectorial, region);
            }
          } else {
            img = await rasterizarEnMain(blob, width, height, vectorial, region);
          }
          if (!img || options.signal?.aborted) {
            if (img && img instanceof ImageBitmap) img.close();
            return;
          }

          const entrada: RecursoRasterizado = { img, region: region ?? null };
          loaded[resourceId] = entrada;
          pixelesUsados += width * height;
          options.onEach?.(resourceId, entrada);

          // Guardar para la proxima apertura (no bloquea). Los recortes NO se
          // cachean: son especificos del encuadre que tenias en ese momento y
          // ensuciarian el cache con entradas que no sirven para reabrir.
          if (cachear && !region) void guardarRaster(options.fileId!, resourceId, pedidoW, pedidoH, img);
        })(),
        timeoutMs
      );
    } catch (e) {
      console.error("Recurso omitido por timeout/error", resourceId, e);
    }
  });
  await adelanto;
  return loaded;
}

/** Libera los bitmaps de un set de recursos. Los canvas se liberan poniendo
 * su tamaño en 0: en iOS/Android el buffer no vuelve solo hasta el GC, y con
 * canvases de decenas de MB eso es memoria retenida de mas. */
export function releaseResourceImages(images: Record<string, RecursoRasterizado>) {
  Object.values(images).forEach((r) => liberarImagen(r.img));
}

/**
 * Dibuja un recurso en el espacio YA transformado del elemento (0,0 hasta
 * ancho x alto en unidades del documento).
 *
 * Si el bitmap es un RECORTE (se rasterizo solo la parte visible para poder
 * verla nitida al hacer zoom), se lo coloca en el sub-rectangulo que le
 * corresponde en vez de estirarlo sobre el recurso entero — que es lo que
 * pasaria, y se veria todo corrido, si se ignorara la region.
 */
export function dibujarRecurso(
  ctx: CanvasRenderingContext2D,
  recurso: RecursoRasterizado,
  ancho: number,
  alto: number
) {
  const { img, region } = recurso;
  if (region && ancho && alto) {
    ctx.drawImage(img, region.x * ancho, region.y * alto, region.w * ancho, region.h * alto);
  } else if (ancho && alto) {
    ctx.drawImage(img, 0, 0, ancho, alto);
  } else {
    ctx.drawImage(img, 0, 0);
  }
}

/** Libera una fuente suelta. Los canvas se sueltan poniendolos en 0x0: en
 * iOS/Android el buffer no vuelve solo hasta el GC. */
export function liberarImagen(img: CanvasImageSource) {
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
  else if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) {
    img.width = 0;
    img.height = 0;
  }
}

export type RenderItem =
  | { type: "stroke"; path: Path2D; color: string; alpha: number; width: number; layerIndex: number }
  | {
      type: "image";
      resourceId: string;
      transform: number[];
      width: number;
      height: number;
      layerIndex: number;
    };

export interface RenderPlan {
  items: RenderItem[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasContent: boolean;
}

/**
 * Junta los trazos e imagenes del documento en items dibujables, y calcula
 * el encuadre ("zoom all"). Dos pasadas separadas y no una por capa: primero
 * TODOS los trazos de TODAS las capas para saber si el documento tiene
 * trazos, y recien despues las imagenes. Si se mezclan en una pasada por
 * capa, una capa de solo-imagenes que aparece antes de una capa con trazos
 * alcanza a expandir el encuadre con la imagen antes de saber que hay
 * trazos, dando un encuadre mal ajustado.
 */
export function buildRenderPlan(doc: Document): RenderPlan {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasStrokes = false;
  const items: RenderItem[] = [];

  doc.layers.forEach((layer) => {
    layer.strokes.forEach((stroke) => {
      if (stroke.points.length === 0) return;
      hasStrokes = true;
      if (stroke.bbox.minX < minX) minX = stroke.bbox.minX;
      if (stroke.bbox.minY < minY) minY = stroke.bbox.minY;
      if (stroke.bbox.maxX > maxX) maxX = stroke.bbox.maxX;
      if (stroke.bbox.maxY > maxY) maxY = stroke.bbox.maxY;
      const path = new Path2D();
      path.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        path.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      items.push({
        type: "stroke",
        path,
        color: stroke.color.hex.slice(0, 7),
        alpha: stroke.color.a,
        width: stroke.width || 1.5,
        layerIndex: layer.index,
      });
    });
  });

  doc.layers.forEach((layer) => {
    layer.images.forEach((img) => {
      const tx = img.transform[12];
      const ty = img.transform[13];
      const w = img.width || 500;
      const h = img.height || 500;
      items.push({
        type: "image",
        resourceId: img.resourceId,
        transform: img.transform,
        width: img.width,
        height: img.height,
        layerIndex: layer.index,
      });
      if (!hasStrokes) {
        if (tx < minX) minX = tx;
        if (ty < minY) minY = ty;
        if (tx + w > maxX) maxX = tx + w;
        if (ty + h > maxY) maxY = ty + h;
      }
    });
  });

  // Ordenar aca (una vez) y no en cada dibujado: drawItems se llama por frame
  // en el visor y re-ordenar decenas de miles de items 60 veces por segundo
  // era puro trabajo tirado.
  items.sort((a, b) => a.layerIndex - b.layerIndex);

  return { items, minX, minY, maxX, maxY, hasContent: minX !== Infinity };
}

/** Dibuja los items (ya ordenados por capa) sobre un contexto ya
 * trasladado/escalado por el que llama. */
export function drawItems(
  ctx: CanvasRenderingContext2D,
  items: RenderItem[],
  images: Record<string, RecursoRasterizado>
) {
  for (const item of items) {
    if (item.type === "image") {
      const recurso = images[item.resourceId];
      // Un recurso ya liberado (canvas en 0x0, que es como se suelta memoria
      // en iOS/Android) hace que drawImage lance y aborte TODO el dibujado.
      // Saltearlo deja el resto de la pagina intacto.
      const w = (recurso?.img as any)?.width;
      if (!recurso || (typeof w === "number" && (w <= 0 || (recurso.img as any).height <= 0))) continue;
      ctx.save();
      const m = item.transform;
      if (m && m.length === 16) ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
      dibujarRecurso(ctx, recurso, item.width, item.height);
      ctx.restore();
    } else {
      ctx.strokeStyle = item.color;
      ctx.globalAlpha = item.alpha;
      ctx.lineWidth = item.width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke(item.path);
    }
  }
}
