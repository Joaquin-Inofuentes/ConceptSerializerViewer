import type { Document } from "../VisorConcept/parser";
import { getBudgets, soportaOffscreen, maxCanvasSide } from "../device";
import { leerRasterVarios, guardarRaster, guardarRasterBlob } from "./rasterCache";

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

// Los canvas del navegador tienen limites duros (Chrome de escritorio:
// 65535 px por lado y ~268 Mpx de area; Safari/iOS y GPUs Android bastante
// menos, a menudo 4096 u 8192). Pasarse no tira error: el canvas queda en
// blanco. Un dibujo grande a 600 DPI se pasa facil, asi que el export baja
// la escala lo necesario en vez de exportar una hoja vacia. El limite real
// se resuelve en runtime por dispositivo (ver `maxCanvasSide` en device.ts),
// no con un numero fijo: 16384 esta bien en desktop pero produce bitmaps
// vacios en buena parte del parque de gama media/baja.

/** Escala de export efectiva para un tamaño logico dado: EXPORT_SCALE salvo
 * que el canvas resultante no entre, en cuyo caso se reduce lo justo.
 *
 * El techo de area sale del presupuesto del dispositivo: en un telefono de
 * 1 GB un canvas de 120 Mpx son 480 MB y Android mata la pestaña antes de
 * terminar el export, asi que ahi el tope baja a 24 Mpx (96 MB). */
export function safeExportScale(logicalWidth: number, logicalHeight: number): number {
  const maxPixels = getBudgets().maxExportPixels;
  const ladoMax = maxCanvasSide();
  let scale = EXPORT_SCALE;
  const w = logicalWidth * scale;
  const h = logicalHeight * scale;
  const porLado = Math.min(ladoMax / w, ladoMax / h, 1);
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
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
  });
  // Sin el `finally`, el timer de rechazo queda vivo aunque `promise` gane
  // la carrera: con N recursos x M sincronizaciones (tipico durante un pan
  // largo) se acumulan timers de hasta 60 s reteniendo closures que ya no
  // sirven para nada.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  /**
   * Orientacion EXIF del recurso (1..8), o 0/undefined si no tiene. El
   * navegador ya la aplico al decodificar y `dibujarRecurso` la deshace, porque
   * la caja donde el documento coloca la imagen esta en su tamaño CRUDO.
   *
   * Es el valor exacto y no un booleano: antes se guardaba "hay que compensar"
   * y se rotaba -90 para todos los casos, lo que dejaba las fotos EXIF 8 al
   * reves y no tocaba las EXIF 3.
   */
  exif?: number;
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
  /** Se llama cuando un recurso no se pudo traer (timeout, red caida, PDF
   * roto). Sin esto el fallo era invisible: el llamador lo volvia a pedir en
   * cada gesto, para siempre. */
  onFallo?: (resourceId: string, error: unknown) => void;
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
export const statsCache = {
  aciertos: 0,
  fallos: 0,
  /** Veces que lo guardado no servia como resultado final pero se mostro
   * igual mientras se rasterizaba el bueno. */
  adelantos: 0,
};

/**
 * Cuanto cuesta cada etapa de traer un recurso, acumulado en ms.
 *
 * Sin esto, "abrir tarda 50 s" no dice si el tiempo se va en la red, en el
 * inflate del zip o en pdf.js, y se termina optimizando a ciegas la parte
 * equivocada.
 */
export const tiempos = {
  cacheMs: 0,
  bytesMs: 0,
  rasterMs: 0,
  guardarMs: 0,
  n: 0,
  /** Rasterizados que terminaron BLOQUEANDO el hilo principal. Deberia ser 0
   * salvo en navegadores sin OffscreenCanvas: cada uno es pdf.js ejecutando la
   * lista de operadores de un plano encima del render loop. */
  enMain: 0,
  enMainMs: 0,
};

export function reiniciarTiempos() {
  tiempos.cacheMs = 0;
  tiempos.bytesMs = 0;
  tiempos.rasterMs = 0;
  tiempos.guardarMs = 0;
  tiempos.n = 0;
  tiempos.enMain = 0;
  tiempos.enMainMs = 0;
}

/** Corre `worker` sobre `items` con un maximo de `limit` en vuelo. */
async function runPool<T>(items: T[], limit: number, worker: (item: T, indice: number) => Promise<void>) {
  let idx = 0;
  const next = async (): Promise<void> => {
    const current = idx++;
    if (current >= items.length) return;
    await worker(items[current], current);
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
  pendientes: Map<number, { resolve: (r: { bitmap: ImageBitmap; cacheBlob?: Blob }) => void; reject: (e: Error) => void }>;
  /** Recursos que este worker tiene parseados (su cache de PDFs abiertos).
   * Sirve para mandarle el refinado de un plano al worker que ya lo tiene, en
   * vez de a uno que tendria que parsearlo de nuevo. */
  recientes: string[];
}

let pool: SlotWorker[] = [];
let siguienteId = 1;

// Antes `workersRotos` era un booleano que, una vez en `true`, quedaba asi
// el resto de la SESION ENTERA. Un worker puede morir por OOM al abrir un
// dibujo pesado -- el caso ESPERADO en gama baja, no una falla rara -- y a
// partir de ahi todo pdf.js pasaba al hilo principal en silencio: los mismos
// segundos de bloqueo que el pool de workers existe para evitar, sin que
// nada lo distinga de "hoy anda lento". Ahora es una ventana: unos pocos
// fallos SEGUIDOS desactivan el pool un rato (probablemente el dispositivo
// no da para workers concurrentes de pdf.js), pero un fallo aislado no dejo
// cicatriz permanente.
const VENTANA_FALLOS_MS = 60_000;
const MAX_FALLOS_EN_VENTANA = 3;
const PAUSA_TRAS_FALLOS_MS = 5 * 60_000;
let fallosRecientes: number[] = [];
let pausaWorkersHasta = 0;

function marcarFalloWorker() {
  const ahora = Date.now();
  fallosRecientes = fallosRecientes.filter((t) => ahora - t < VENTANA_FALLOS_MS);
  fallosRecientes.push(ahora);
  if (fallosRecientes.length >= MAX_FALLOS_EN_VENTANA) {
    pausaWorkersHasta = ahora + PAUSA_TRAS_FALLOS_MS;
    console.warn(
      `[renderCore] ${fallosRecientes.length} workers de rasterizado cayeron en menos de ${VENTANA_FALLOS_MS / 1000}s; ` +
        `se desactiva el pool ${PAUSA_TRAS_FALLOS_MS / 60000} min (todo pasa al hilo principal mientras tanto).`
    );
  }
}

function workersDesactivados(): boolean {
  return Date.now() < pausaWorkersHasta;
}

interface EntradaColaSlot {
  resolve: (s: SlotWorker | null) => void;
  limpiar: () => void;
}

/** Quienes esperan un worker libre. Ver `esperarSlot`. */
let colaSlots: EntradaColaSlot[] = [];

function crearSlot(): SlotWorker | null {
  try {
    const worker = new Worker(new URL("./raster.worker.ts", import.meta.url), { type: "module" });
    const slot: SlotWorker = { worker, ocupado: false, pendientes: new Map(), recientes: [] };
    worker.onmessage = (e: MessageEvent) => {
      const { id, bitmap, cacheBlob, error } = e.data || {};
      const p = slot.pendientes.get(id);
      if (!p) return;
      slot.pendientes.delete(id);
      liberarSlot(slot);
      if (error) p.reject(new Error(error));
      else p.resolve({ bitmap: bitmap as ImageBitmap, cacheBlob: cacheBlob as Blob | undefined });
    };
    worker.onerror = () => {
      // Si el worker se cae (ej. OOM), se registra el fallo (ventana movil,
      // no un latch permanente -- ver `marcarFalloWorker`) y este slot en
      // particular se saca del pool: dejarlo adentro marcado "libre" haria
      // que `tomarSlot` lo siguiera entregando y cada pedido volviera a
      // fallar contra un worker que ya esta muerto.
      marcarFalloWorker();
      slot.pendientes.forEach((p) => p.reject(new Error("worker de rasterizado caido")));
      slot.pendientes.clear();
      pool = pool.filter((s) => s !== slot);
      try {
        slot.worker.terminate();
      } catch {
        /* ya esta caido */
      }
      // Los que estaban esperando un worker no pueden quedarse colgados.
      const esperando = colaSlots;
      colaSlots = [];
      esperando.forEach((e) => e.resolve(null));
    };
    return slot;
  } catch {
    marcarFalloWorker();
    return null;
  }
}

function tomarSlot(resourceId?: string): SlotWorker | null {
  if (workersDesactivados() || !soportaOffscreen()) return null;
  // Primero el que ya tiene este PDF parseado: mandarselo a otro obligaria a
  // parsearlo de nuevo, que es justo el costo que el cache evita.
  const afin = resourceId ? pool.find((s) => !s.ocupado && s.recientes.includes(resourceId)) : undefined;
  const libre = afin ?? pool.find((s) => !s.ocupado);
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

/** Devuelve el slot al pool, o se lo pasa directo al que estaba esperando. */
function liberarSlot(slot: SlotWorker) {
  const siguiente = colaSlots.shift();
  if (siguiente) {
    // Se queda ocupado: cambia de dueño sin pasar por "libre", para que no lo
    // tome otro por el medio. `limpiar()` saca el timeout/listener de abort
    // de esta entrada -- ya no hace falta, gano la carrera por el slot.
    siguiente.limpiar();
    siguiente.resolve(slot);
    return;
  }
  slot.ocupado = false;
}

/**
 * Un worker libre, ESPERANDO si hace falta.
 *
 * Antes, si todos los workers estaban ocupados, `tomarSlot` devolvia null y el
 * que llamaba rasterizaba en el hilo principal. Eso parecia un fallback
 * inofensivo y era la principal causa de tirones: durante el pan/zoom conviven
 * dos generaciones de refinado (la que se acaba de abortar sigue en vuelo y
 * ocupa los dos workers), asi que la nueva caia SIEMPRE en el hilo principal —
 * y ahi pdf.js se pone a ejecutar la lista de operadores del plano, con
 * fillText y todo, bloqueando el render loop cientos de ms. En el perfil eran
 * 1,3 s de pdf.js en el hilo principal durante una tanda de gestos.
 *
 * Esperar es estrictamente mejor: el trabajo tarda lo mismo, pero la pantalla
 * sigue respondiendo mientras tanto.
 *
 * `signal` y `timeoutMs` cierran una fuga real: el llamador ya envuelve todo
 * el trabajo en `withTimeout`, pero esa carrera NO cancela la promesa
 * perdedora -- si `esperarSlot` seguia esperando, su `resolve` quedaba
 * huerfano en `colaSlots` para siempre. Cuando por fin se liberaba un slot,
 * `liberarSlot` se lo entregaba a ese resolver muerto, que nadie iba a
 * volver a soltar: con 2-3 timeouts seguidos en gama baja el pool quedaba
 * con cero slots utilizables y los recursos dejaban de aparecer. Ahora la
 * entrada se saca de la cola sola en cuanto el pedido deja de importar.
 */
function esperarSlot(resourceId?: string, signal?: AbortSignal, timeoutMs?: number): Promise<SlotWorker | null> {
  if (workersDesactivados() || !soportaOffscreen()) return Promise.resolve(null);
  const inmediato = tomarSlot(resourceId);
  if (inmediato) return Promise.resolve(inmediato);
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let entry: EntradaColaSlot;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limpiar = () => {
      colaSlots = colaSlots.filter((e) => e !== entry);
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onAbort = () => {
      limpiar();
      resolve(null);
    };
    entry = { resolve, limpiar };
    signal?.addEventListener("abort", onAbort);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        limpiar();
        resolve(null);
      }, timeoutMs);
    }
    colaSlots.push(entry);
  });
}

/** Le dice a los workers que suelten los PDFs que tienen abiertos. Se llama al
 * cerrar un dibujo: si no, sus paginas parseadas quedan retenidas mientras se
 * abre el siguiente y se suman los dos consumos. */
export function soltarPdfsAbiertos() {
  pool.forEach((s) => {
    s.recientes = [];
    try {
      s.worker.postMessage({ id: -1, limpiar: true });
    } catch {
      /* worker ya terminado */
    }
  });
}

/** Lo que devuelve el worker: el bitmap para mostrar y, si se pidio
 * `cachear`, el JPEG ya codificado para el cache persistente (ver la nota
 * larga en `PedidoRaster.cachear` de raster.worker.ts). */
interface ResultadoWorker {
  bitmap: ImageBitmap;
  cacheBlob?: Blob;
}

function rasterizarEnWorker(
  slot: SlotWorker,
  resourceId: string,
  blob: Blob,
  width: number,
  height: number,
  region?: Region,
  cachear?: boolean
): Promise<ResultadoWorker> {
  const id = siguienteId++;
  // Se anota ANTES de mandar: el worker cachea por resourceId, asi que a
  // partir de aca este slot es el que conviene para los refinados de este
  // recurso. Se conserva la misma cantidad que cachea el worker.
  slot.recientes = [resourceId, ...slot.recientes.filter((r) => r !== resourceId)].slice(0, 2);
  return new Promise<ResultadoWorker>((resolve, reject) => {
    slot.pendientes.set(id, { resolve, reject });
    slot.worker.postMessage({
      id,
      resourceId,
      blob,
      width,
      height,
      region,
      cachear,
      smoothing: getBudgets().smoothing,
    });
  });
}

/** Cierra los workers. */
export function cerrarWorkersRaster() {
  pool.forEach((s) => {
    // `terminate()` no rechaza lo que estaba pendiente: sin esto esas
    // promesas quedaban colgadas hasta que las mataba el `withTimeout` del
    // llamador (30-60 s), reteniendo closures todo ese tiempo.
    s.pendientes.forEach((p) => p.reject(new Error("worker de rasterizado cerrado")));
    s.pendientes.clear();
    s.worker.terminate();
  });
  pool = [];
  colaSlots.forEach((e) => {
    e.limpiar();
    e.resolve(null);
  });
  colaSlots = [];
  // Un cierre explicito es la señal de que el dispositivo SI puede con
  // workers (llegaron a usarse con normalidad); no tiene sentido que un
  // fallo viejo siga contando en la ventana o que una pausa vieja se
  // arrastre a la proxima vez que se abra un dibujo.
  fallosRecientes = [];
  pausaWorkersHasta = 0;
}

let cierreDiferido: number | null = null;

/**
 * Programa el cierre de los workers para dentro de un rato.
 *
 * Cada worker tiene el modulo de pdf.js cargado y hasta 2 paginas parseadas;
 * con el visor cerrado eso son decenas de MB retenidos mientras el usuario
 * navega la galeria — que es justo cuando la galeria esta generando
 * miniaturas y necesita la memoria. Pero cerrarlos al instante haria pagar
 * ~300 ms de arranque a quien vuelve a entrar al mismo dibujo, que es lo mas
 * comun. Con la espera se queda con lo mejor de los dos.
 */
export function programarCierreWorkers(msEspera = 20000) {
  if (cierreDiferido !== null) clearTimeout(cierreDiferido);
  cierreDiferido = setTimeout(() => {
    cierreDiferido = null;
    if (pool.every((s) => !s.ocupado)) {
      cerrarWorkersRaster();
      return;
    }
    // Antes, si algun slot seguia ocupado (tipico: se cerro el visor con un
    // refinado en vuelo, que es el caso normal al cerrar durante un zoom),
    // este `if` simplemente no hacia nada -- y como `cierreDiferido` ya
    // estaba en null, el cierre NO SE REPROGRAMABA NUNCA. Los workers, cada
    // uno con pdf.js y hasta 2 PDFs parseados, quedaban vivos el resto de la
    // sesion mientras el usuario navegaba la galeria, que es justo cuando
    // esta generando miniaturas y necesita esa RAM. Reintentar hasta que se
    // desocupen evita la fuga sin adelantar el cierre.
    programarCierreWorkers(msEspera);
  }, msEspera) as unknown as number;
}

/** Cancela el cierre programado (el usuario volvio a abrir un dibujo). */
export function cancelarCierreWorkers() {
  if (cierreDiferido !== null) {
    clearTimeout(cierreDiferido);
    cierreDiferido = null;
  }
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
  // Techo por LADO. El techo de area no alcanza para un recurso muy alargado:
  // los planos de esta carpeta son tiras de 1:4,7, asi que a presupuestos
  // altos el lado largo se dispara mucho antes que el area. Pasarse del
  // limite del navegador no tira error — el canvas queda en blanco y el plano
  // simplemente no aparece.
  const ladoMayor = Math.max(w, h);
  const ladoMax = maxCanvasSide();
  if (ladoMayor > ladoMax) {
    const k = ladoMax / ladoMayor;
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
  region?: Region,
  /** Id del recurso; puede traer la pagina colgada (`uuid#2`). */
  idRecurso?: string
): Promise<CanvasImageSource> {
  if (vectorial) {
    const pdfjsLib = await getPdfjs();
    const url = URL.createObjectURL(blob);
    // destroy() esta en el loading task, no en el documento; sin llamarlo el
    // worker de pdf.js y el buffer del PDF quedan vivos.
    const tarea = pdfjsLib.getDocument({ url });
    try {
      const pdf = await tarea.promise;
      // Igual que en el worker: el id puede traer la pagina colgada (`uuid#2`).
      const nP = Math.min(Math.max(1, Number(idRecurso?.split("#")[1] ?? 0) + 1), pdf.numPages);
      const page = await pdf.getPage(nP);
      // rotation: 0 — misma razon que en raster.worker.ts.
      const nativo = page.getViewport({ scale: 1, rotation: 0 });
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

/**
 * Orientacion EXIF de un JPEG (1..8), o 0 si no tiene. Solo interesan 5..8,
 * que son las que intercambian ancho y alto.
 *
 * Concepts guarda el tamaño CRUDO del archivo (sin aplicar EXIF) pero el
 * navegador SI lo aplica al decodificar, asi que el bitmap llega girado
 * respecto de la caja donde el documento lo coloca. `imageOrientation: "none"`
 * no ayuda: se probo y devuelve el mismo bitmap girado.
 */
export async function orientacionExifDe(blob: Blob): Promise<number> {
  const b = new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marcador = b[i + 1];
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (marcador === 0xe1) {
      const t = i + 4;
      if (b[t] === 0x45 && b[t + 1] === 0x78 && b[t + 2] === 0x69 && b[t + 3] === 0x66) {
        const tiff = t + 6;
        const le = b[tiff] === 0x49;
        const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o: number) =>
          le
            ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
            : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        const ifd = tiff + u32(tiff + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
      }
      return 0;
    }
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4) return 0;
    i += 2 + largo;
  }
  return 0;
}

/** Tamaño nativo de un recurso, sin rasterizarlo (para poder clampear bien
 * antes de gastar el trabajo pesado). */
async function tamañoNativo(blob: Blob, vectorial: boolean, pagina = 0): Promise<{ w: number; h: number }> {
  if (vectorial) {
    const pdfjsLib = await getPdfjs();
    const url = URL.createObjectURL(blob);
    const tarea = pdfjsLib.getDocument({ url });
    try {
      const pdf = await tarea.promise;
      // Sin rotar, igual que al rasterizar: si aca se devolviera el tamaño
      // rotado, el clamp razonaria sobre una proporcion distinta de la que
      // despues se dibuja.
      // La pagina importa: en un PDF con paginas de distinto tamaño, medir
      // siempre la primera hacia que el clamp razonara con la proporcion
      // equivocada para las demas.
      const nP = Math.min(Math.max(1, pagina + 1), pdf.numPages);
      const vp = (await pdf.getPage(nP)).getViewport({ scale: 1, rotation: 0 });
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
  const tCache = performance.now();
  if (options.fileId && !options.sinCache) {
    // Una sola consulta para TODO el lote, no una por recurso: antes cada uno
    // abria su propia transaccion de IndexedDB via `runPool(pendientes, 4,
    // ...)`, y aunque la lectura en si es trivial, abrir una transaccion no lo
    // es — con CPU profiling bajo 10x throttle eso aparecia como self-time
    // real durante los gestos. `leerRasterVarios` cubre el lote entero con
    // una unica transaccion (ver su comentario).
    const pedidosCache = pendientes.map((resourceId) => {
      const target = options.targets?.[resourceId];
      return {
        resourceId,
        pedidoW: (target?.width ?? 0) * opts.quality,
        pedidoH: (target?.height ?? 0) * opts.quality,
        // Con RECORTE lo guardado no sirve como resultado final —solo hay
        // paginas completas y el recorte existe justamente porque hace falta
        // mas resolucion— pero si sirve como PRIMER NIVEL: se publica la
        // pagina completa cacheada al instante (~30 ms) para que se vea algo
        // ya, y el recurso queda igual en `faltantes` para que el recorte
        // nitido llegue despues. Antes se salteaba el cache por completo en
        // este caso, asi que un plano que entraba en pantalla estando
        // acercado pagaba un parseo entero de pdf.js (~4,7 s con CPU frenada)
        // para mostrar algo que ya estaba en el disco.
        cualquierTamaño: !!target?.region,
      };
    });
    const cacheados = await leerRasterVarios(options.fileId, pedidosCache);
    for (let iCache = 0; iCache < pendientes.length; iCache++) {
      const resourceId = pendientes[iCache];
      if (options.signal?.aborted) {
        // `leerRasterVarios` ya decodifico TODOS los bitmaps del lote antes
        // de que arranque este loop (son promesas resueltas de una, no
        // perezosas). Sin cerrar los que quedan sin procesar, quedan
        // retenidos hasta que el GC los alcance -- con pan/zoom rapido
        // abortando sync tras sync, cada aborto filtraba decenas de MB.
        for (let j = iCache; j < pendientes.length; j++) {
          cacheados.get(pendientes[j])?.close();
        }
        break;
      }
      const soloComoAdelanto = !!options.targets?.[resourceId]?.region;
      const cacheado = cacheados.get(resourceId) ?? null;
      if (cacheado && !soloComoAdelanto) {
        statsCache.aciertos++;
        // Lo guardado es SIEMPRE la pagina completa (los recortes no se
        // cachean), asi que la region es null por construccion.
        const entrada: RecursoRasterizado = { img: cacheado as CanvasImageSource, region: null };
        loaded[resourceId] = entrada;
        pixelesUsados += cacheado.width * cacheado.height;
        options.onEach?.(resourceId, entrada);
        continue;
      }
      statsCache.fallos++;
      faltantes.push(resourceId);
      if (cacheado) {
        // Adelanto: se muestra pero NO se contabiliza en el presupuesto,
        // porque en cuanto llegue el recorte este bitmap se reemplaza y se
        // libera. Sumarlo haria que el recorte —el que de verdad importa—
        // naciera con menos presupuesto del que le corresponde.
        statsCache.adelantos++;
        options.onEach?.(resourceId, { img: cacheado as CanvasImageSource, region: null });
      }
    }
  } else {
    faltantes.push(...pendientes);
  }
  tiempos.cacheMs += performance.now() - tCache;
  if (faltantes.length === 0 || options.signal?.aborted) return loaded;

  // El lookup del cache corre en paralelo, asi que `faltantes` quedo en orden
  // de llegada. Se restaura el orden de PRIORIDAD (lo que ocupa mas pantalla
  // primero), que es el que usan tanto el pool como el adelanto de bytes.
  const orden = new Map(pendientes.map((id, i) => [id, i]));
  faltantes.sort((a, b) => (orden.get(a) ?? 0) - (orden.get(b) ?? 0));

  // --- Paso 2: adelantar los bytes, pero solo un poco por delante ---------
  //
  // Los recursos estan contiguos en el .concepts, asi que pedirlos de a uno
  // gasta una ida y vuelta HTTP por recurso (~1,7 s a traves del proxy de
  // Drive): agruparlos es lo que hace que abrir no cueste 19 viajes.
  //
  // Pero adelantar LA TANDA ENTERA es contraproducente en una conexion lenta:
  // el adelanto se lleva todo el ancho de banda bajando los 11 MB de los 19
  // planos mientras el pool espera los 600 KB del primero. Medido con 4G lenta
  // en el dibujo mas pesado: 43,5 s hasta la primera imagen con adelanto
  // completo contra 27,5 s sin adelanto ninguno.
  //
  // La ventana movil se queda con lo mejor de los dos: se adelanta solo lo que
  // el pool esta por consumir, asi se siguen ahorrando viajes sin tapar lo que
  // el usuario esta esperando.
  const VENTANA_ADELANTO = 4;
  let adelantados = 0;
  let adelanto: Promise<void> = Promise.resolve();
  const asegurarAdelanto = (hasta: number) => {
    const limite = Math.min(hasta, faltantes.length);
    if (limite <= adelantados) return;
    const trozo = faltantes.slice(adelantados, limite);
    adelantados = limite;
    // Encadenado y no en paralelo: dos adelantos a la vez volverian a competir
    // por el ancho de banda, que es justo lo que se quiere evitar.
    adelanto = adelanto.then(() => doc.prefetchResources(trozo)).catch(() => {});
  };
  asegurarAdelanto(concurrency + VENTANA_ADELANTO);

  await runPool(faltantes, concurrency, async (resourceId, indice) => {
    if (options.signal?.aborted) return;
    asegurarAdelanto(indice + concurrency + VENTANA_ADELANTO);
    try {
      await withTimeout(
        (async () => {
          const target = options.targets?.[resourceId];
          let pedidoW = (target?.width ?? 0) * opts.quality;
          let pedidoH = (target?.height ?? 0) * opts.quality;
          // Para la CLAVE de cache (ver mas abajo, guardarRaster/guardarRasterBlob):
          // se guardan SIN el intercambio de ejes de EXIF 5-8 que sufre `pedidoW`/
          // `pedidoH` unas lineas mas abajo. La lectura del cache (mas arriba en
          // esta funcion, antes de bajar el blob) NO PUEDE conocer la orientacion
          // EXIF todavia -- para eso hay que descargar y leer el archivo, que es
          // justo lo que el cache existe para evitar -- asi que consulta con estos
          // valores tal cual (target-space, sin swap). Si se guardara con la
          // version ya intercambiada, la clave nunca coincidiria con lo que pide la
          // lectura: toda foto vertical se re-rasterizaria entera en cada apertura
          // aunque estuviera cacheada.
          const pedidoWCache = pedidoW;
          const pedidoHCache = pedidoH;

          // Cuanto presupuesto queda. Si ya se gasto casi todo, se rasteriza
          // al minimo legible en vez de saltear el recurso.
          const restante = Math.max(maxTotal - pixelesUsados, 500_000);
          const techoRecurso = Math.min(opts.maxPixels, restante);

          const cachear = !!options.fileId && !options.sinCache;

          // Bajar los bytes (rango HTTP en un archivo remoto). El cache ya se
          // consulto arriba: aca solo llegan los que hay que rasterizar.
          const tBytes = performance.now();
          const blob = await doc.loadResource(resourceId);
          tiempos.bytesMs += performance.now() - tBytes;
          if (!blob || options.signal?.aborted) return;

          const header = await blob.slice(0, 5).text();
          const vectorial = header === "%PDF-";
          // La region llega en fracciones de la CAJA del elemento (imagen
          // cruda). El rasterizador recorta el bitmap que decodifica el
          // navegador, que para una foto con EXIF 5-8 tiene los ejes
          // intercambiados: sin convertirla se recortaba la parte equivocada.
          const regionCaja = target?.region;

          // El tamano nativo solo se necesita si NO hay un destino util:
          // con destino, un PDF se rasteriza a lo que se le pida y un bitmap
          // lo capa el propio rasterizador, que ya tiene la imagen
          // decodificada y nunca la agranda.
          //
          // Averiguarlo siempre costaba carisimo: para un PDF significaba
          // abrirlo entero con pdf.js EN EL HILO PRINCIPAL solo para leer el
          // tamano de la pagina, y despues el worker lo volvia a abrir para
          // dibujarlo. O sea el trabajo pesado por duplicado, con la mitad
          // bloqueando los gestos.
          // La orientacion EXIF se consulta TAMBIEN cuando hay recorte por
          // zoom. Antes esto estaba guardado por `!region`, asi que una foto
          // con EXIF 5-8 se veia bien de lejos y girada en cuanto el zoom
          // activaba el camino de recorte.
          let exif = 0;
          if (!vectorial) exif = await orientacionExifDe(blob);
          // Solo 5..8 intercambian ancho y alto: para esas, el bitmap que
          // decodifica el navegador esta "de canto" respecto de la caja y hay
          // que pedirlo con los lados dados vuelta.
          if (exif >= 5 && exif <= 8 && pedidoW > 0 && pedidoH > 0) {
            const t = pedidoW; pedidoW = pedidoH; pedidoH = t;
          }
          const region = regionCaja ? regionEnBitmap(regionCaja, exif) : undefined;

          let natW = Infinity;
          let natH = Infinity;
          if (!(pedidoW > 0) || !(pedidoH > 0)) {
            const nativo = await tamañoNativo(blob, vectorial, Number(resourceId.split("#")[1] ?? 0));
            // Con region, el "nativo" relevante es el del pedazo, no el de la
            // pagina entera: si no, el clamp de un bitmap creeria que se le
            // pide mas resolucion de la que tiene y lo achicaria de mas.
            natW = region ? nativo.w * region.w : nativo.w;
            natH = region ? nativo.h * region.h : nativo.h;
          }
          const { width, height } = clampTarget(pedidoW, pedidoH, natW, natH, vectorial, {
            maxPixels: techoRecurso,
            minSide: opts.minSide,
          });
          if (options.signal?.aborted) return;

          // Rasterizar, preferentemente fuera del hilo principal.
          let img: CanvasImageSource | null = null;
          // Si el worker rasteriza, tambien le pedimos el JPEG del cache YA
          // codificado (ver la nota larga en raster.worker.ts): asi el hilo
          // principal solo escribe bytes a IndexedDB, sin volver a dibujar
          // nada. Solo tiene sentido cuando de verdad se va a cachear.
          let cacheBlobDelWorker: Blob | undefined;
          const tRaster = performance.now();
          const slot = options.sinWorker ? null : await esperarSlot(resourceId, options.signal, timeoutMs);
          if (options.signal?.aborted) {
            if (slot) liberarSlot(slot);
            return;
          }
          const enMain = async () => {
            const t = performance.now();
            const r = await rasterizarEnMain(blob, width, height, vectorial, region, resourceId);
            tiempos.enMain++;
            tiempos.enMainMs += performance.now() - t;
            return r;
          };
          if (slot) {
            try {
              const resultado = await rasterizarEnWorker(
                slot, resourceId, blob, width, height, region, cachear && !region
              );
              img = resultado.bitmap;
              cacheBlobDelWorker = resultado.cacheBlob;
            } catch (e) {
              liberarSlot(slot);
              // Sin este chequeo, cerrar el visor mientras un rasterizado
              // sigue en vuelo (soltarPdfsAbiertos() mata las tareas de
              // pdf.js dentro del worker, esos renders rechazan y caen ACA)
              // hacia que se rasterizara EN EL HILO PRINCIPAL un dibujo que
              // el usuario ya cerro: cientos de ms a segundos de bloqueo
              // gratuito, justo despues de cerrar. El unico chequeo de abort
              // que existia era ANTES de pedir el slot, no despues de que el
              // worker fallara.
              if (options.signal?.aborted) return;
              // No se silencia: caer al hilo principal cuesta cientos de ms de
              // bloqueo por recurso, asi que si esta pasando hay que enterarse.
              if (tiempos.enMain === 0) console.warn("Rasterizado en worker fallo, se sigue en el hilo principal:", e);
              img = await enMain();
            }
          } else {
            // Solo llega aca si no hay OffscreenCanvas o si los workers se
            // cayeron: ahi no queda otra que bloquear el hilo principal.
            img = await enMain();
          }
          tiempos.rasterMs += performance.now() - tRaster;
          tiempos.n++;
          if (!img || options.signal?.aborted) {
            if (img && img instanceof ImageBitmap) img.close();
            return;
          }

          // Se guarda la region en espacio de CAJA (la que compara el visor
          // para decidir si lo cargado alcanza), no la convertida al bitmap.
          const entrada: RecursoRasterizado = { img, region: regionCaja ?? null, exif };
          auditarOrientacion(resourceId, exif, entrada);
          loaded[resourceId] = entrada;
          // Los pixeles REALES del bitmap, no los pedidos: el rasterizador
          // capa los bitmaps a su tamano nativo, asi que una foto chica pedida
          // en grande gasta menos de lo solicitado y el presupuesto que sobra
          // tiene que quedar disponible para el resto.
          const wReal = (img as any).width;
          const hReal = (img as any).height;
          pixelesUsados += typeof wReal === "number" && wReal > 0 ? wReal * hReal : width * height;
          options.onEach?.(resourceId, entrada);

          // Guardar para la proxima apertura (no bloquea). Los recortes NO se
          // cachean: son especificos del encuadre que tenias en ese momento y
          // ensuciarian el cache con entradas que no sirven para reabrir.
          if (cachear && !region) {
            if (cacheBlobDelWorker) {
              // El worker ya entrego el JPEG codificado: escribir a
              // IndexedDB es lo unico que queda, y eso es liviano.
              void guardarRasterBlob(options.fileId!, resourceId, pedidoWCache, pedidoHCache, cacheBlobDelWorker, wReal, hReal);
            } else {
              // Fallback (rasterizado en el hilo principal): no hay worker
              // que haya podido pre-codificar nada, asi que se hace aca como
              // siempre. Es el camino raro (sin OffscreenCanvas o workers
              // caidos), no el que paga la mayoria de los recursos.
              void guardarRaster(options.fileId!, resourceId, pedidoWCache, pedidoHCache, img);
            }
          }
        })(),
        timeoutMs
      );
    } catch (e) {
      console.error("Recurso omitido por timeout/error", resourceId, e);
      options.onFallo?.(resourceId, e);
    }
  });
  await adelanto;
  return loaded;
}

/**
 * Entrega los recursos de a uno y suelta los que ya se usaron.
 *
 * Es para EXPORTAR. El export dibuja el documento completo, asi que necesita
 * todos los recursos — pero no todos al mismo tiempo. Pedirlos de una sola vez
 * significaba tener vivos los 94 bitmaps del dibujo mas pesado mientras ademas
 * existe el canvas de export (hasta 96 MB en gama baja) y el JPEG resultante:
 * el pico se iba muy por encima de lo que aguanta un telefono de 1 GB.
 *
 * Filtrar los recursos chicos NO es la solucion: se midio, y a la escala del
 * export las 96 colocaciones del dibujo mas pesado miden 24 px o mas. Son
 * contenido real del PDF. Lo que hay que acotar es cuantos estan vivos a la
 * vez, no cuales se bajan.
 *
 * Mantiene unos pocos en memoria porque un mismo recurso puede estar colocado
 * varias veces seguidas, y ahi recargarlo seria trabajo puro.
 */
export function proveedorEnStreaming(
  doc: Document,
  targets: Record<string, ResourceTarget>,
  opciones: Omit<LoadResourcesOptions, "targets" | "only" | "onEach"> = {},
  maxVivos = 3
) {
  const vivos = new Map<string, RecursoRasterizado>();

  const soltarSobrantes = () => {
    while (vivos.size > maxVivos) {
      const masViejo = vivos.keys().next().value as string | undefined;
      if (masViejo === undefined) break;
      const r = vivos.get(masViejo);
      vivos.delete(masViejo);
      if (r) liberarImagen(r.img);
    }
  };

  return {
    async obtener(resourceId: string): Promise<RecursoRasterizado | null> {
      const hit = vivos.get(resourceId);
      if (hit) {
        // Renovar posicion en la cola de uso.
        vivos.delete(resourceId);
        vivos.set(resourceId, hit);
        return hit;
      }
      const cargados = await loadResourceImages(doc, { ...opciones, targets, only: [resourceId] });
      const recurso = cargados[resourceId];
      if (!recurso) return null;
      vivos.set(resourceId, recurso);
      soltarSobrantes();
      return recurso;
    },
    liberar() {
      vivos.forEach((r) => liberarImagen(r.img));
      vivos.clear();
    },
    get vivos() {
      return vivos.size;
    },
  };
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

  if (!ancho || !alto) {
    ctx.save();
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    return;
  }

  ctx.save();

  // El documento tiene Y hacia ARRIBA y un mapa de pixeles no: sus filas van de
  // arriba hacia abajo. La caja del elemento llega ya en coordenadas de canvas
  // (la matriz de colocacion incluye la inversion de Y del documento), asi que
  // para dibujar el bitmap DERECHO hay que deshacer esa inversion dentro de la
  // caja. Este volteo es lo que antes se conseguia de rebote espejando en X la
  // matriz de colocacion: para un recurso rotado 90 grados las dos cosas dan
  // identico, y todos los planos entran rotados 90, por eso el atajo paso
  // desapercibido — pero espejaba la POSICION de todo lo descentrado. Ver la
  // nota larga en `parser.ts`.
  ctx.translate(0, alto);
  ctx.scale(1, -1);

  // A partir de aca estamos en el frame del recurso CRUDO: (0,0)-(ancho,alto)
  // es la imagen tal cual la guardo Concepts, sin la rotacion EXIF aplicada.
  const orientacion = recurso.exif ?? 1;
  const gira = orientacion >= 5 && orientacion <= 8;
  // El navegador aplica la orientacion EXIF al decodificar, pero Concepts
  // guardo el tamaño CRUDO. Hay que deshacerla, y hay que deshacerla EXACTA:
  // antes se rotaba -90 para cualquier valor entre 5 y 8, asi que las fotos
  // con EXIF 8 quedaban 180 grados al reves, y las EXIF 3 (que no intercambian
  // lados y por eso ni siquiera entraban en la rama) quedaban cabeza abajo.
  aplicarInversaExif(ctx, orientacion, ancho, alto);
  // Tras deshacer un giro de 90 grados el bitmap se dibuja en una caja con los
  // lados intercambiados.
  const bmAncho = gira ? alto : ancho;
  const bmAlto = gira ? ancho : alto;

  if (region) {
    // La region viene en fracciones de la CAJA (asi la calcula el visor), pero
    // el bitmap recortado es el de la imagen ya orientada por el navegador: hay
    // que pasarla al mismo espacio o el recorte se coloca en el lado que no es.
    const r = regionEnBitmap(region, orientacion);
    ctx.drawImage(img, r.x * bmAncho, r.y * bmAlto, r.w * bmAncho, r.h * bmAlto);
  } else {
    ctx.drawImage(img, 0, 0, bmAncho, bmAlto);
  }
  ctx.restore();
}

/**
 * Deja constancia de con que orientacion se resolvio cada recurso.
 *
 * Existe porque una foto mal orientada NO se rompe: se dibuja igual, solo que
 * girada, y eso pasa desapercibido salvo que alguien mire ese recurso puntual.
 * Con `?debug=colocacion` queda el detalle de todos; sin el, solo se avisa de
 * lo que amerita mirarse.
 */
const debugColocacion = () =>
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debug") === "colocacion";

const exifAvisados = new Set<string>();

function auditarOrientacion(resourceId: string, exif: number, recurso: RecursoRasterizado) {
  if (debugColocacion()) {
    console.info(
      `[colocacion] ${resourceId} exif=${exif || "sin"}` +
        `${recurso.region ? ` recorte=${JSON.stringify(recurso.region)}` : ""}`
    );
  }
  // Las orientaciones espejadas (2,4,5,7) se dibujan bien, pero no aparecen en
  // ninguna de las 770 fotos del corpus: si una llega, conviene mirarla en vez
  // de confiar en un camino que nunca vio un archivo real.
  if ([2, 4, 5, 7].includes(exif) && !exifAvisados.has(resourceId)) {
    exifAvisados.add(resourceId);
    console.warn(
      `[colocacion] ${resourceId}: orientacion EXIF ${exif} (espejada). Se dibuja deshaciendola, ` +
        `pero es un caso sin precedente en el corpus — vale la pena confirmarlo a ojo.`
    );
  }
}

/**
 * Deshace en el contexto la orientacion EXIF que el navegador ya aplico, para
 * las 8 orientaciones. Despues de llamarla, dibujar el bitmap en
 * `(0,0,bmAncho,bmAlto)` deja la imagen CRUDA ocupando la caja `ancho x alto`.
 *
 * Las orientaciones 2,3,4,5 y 7 son involuciones (espejos y media vuelta), asi
 * que su inversa es ella misma; 6 y 8 son inversas una de la otra.
 */
function aplicarInversaExif(
  ctx: CanvasRenderingContext2D,
  orientacion: number,
  ancho: number,
  alto: number
) {
  switch (orientacion) {
    case 2: ctx.transform(-1, 0, 0, 1, ancho, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, ancho, alto); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, alto); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, -1, 1, 0, 0, alto); break;
    case 7: ctx.transform(0, -1, -1, 0, ancho, alto); break;
    case 8: ctx.transform(0, 1, -1, 0, ancho, 0); break;
    default: break; // 1 y "sin EXIF": nada que deshacer
  }
}

/**
 * Pasa una region expresada en fracciones de la CAJA del elemento a fracciones
 * del bitmap que devuelve el navegador (la imagen con su EXIF ya aplicado).
 *
 * Son dos pasos, y los dos hacen falta:
 *
 *  1. Invertir Y. El visor calcula la region llevando las esquinas de la vista
 *     al espacio de la caja con la inversa de la matriz de colocacion, o sea en
 *     coordenadas del DOCUMENTO, que va con Y hacia arriba. El bitmap se dibuja
 *     en el marco ya volteado de `dibujarRecurso`, donde las filas van de
 *     arriba hacia abajo. Sin este paso el recorte nitido se pide y se coloca
 *     en la mitad opuesta de la pagina: como los planos entran rotados 90
 *     grados, el error del eje Y de la caja sale por pantalla como un
 *     desplazamiento HORIZONTAL, y al acercarse a una esquina el plano
 *     desaparecia — se veia bien al instante, con la pagina entera, y quedaba
 *     en blanco en cuanto llegaba el recorte.
 *
 *  2. La tabla de orientaciones EXIF, aplicada al rectangulo.
 *
 * Se usa en los DOS lados (al recortar el bitmap y al dibujarlo), asi que
 * cualquier cambio aca tiene que seguir aplicandose en ambos o el recorte deja
 * de coincidir consigo mismo.
 */
export function regionEnBitmap(rCaja: Region, orientacion: number): Region {
  const r: Region = { x: rCaja.x, y: 1 - rCaja.y - rCaja.h, w: rCaja.w, h: rCaja.h };
  switch (orientacion) {
    case 2: return { x: 1 - r.x - r.w, y: r.y, w: r.w, h: r.h };
    case 3: return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 4: return { x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 5: return { x: r.y, y: r.x, w: r.h, h: r.w };
    case 6: return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 7: return { x: 1 - r.y - r.h, y: 1 - r.x - r.w, w: r.h, h: r.w };
    case 8: return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
    default: return r;
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
      isPhoto?: boolean;
    }
  | {
      type: "text";
      lineas: string[];
      color: string;
      alpha: number;
      transform: number[];
      layerIndex: number;
    };

/**
 * Alto de una linea de texto en el espacio del elemento, antes de que la matriz
 * la escale.
 *
 * El archivo no guarda el cuerpo de la letra como numero aparte: viene metido
 * en la escala de la matriz. Este es el factor que convierte esa escala en
 * pixeles, y esta calibrado a ojo contra el `thumb.jpg` que renderiza la propia
 * app (los textos "Corregir en obra" de `Fede y Franco/Concepts/v1/Muebles`).
 * Si algun dia los textos salen sistematicamente grandes o chicos, este es el
 * unico numero que hay que tocar.
 */
export const ALTO_LINEA_TEXTO = 16;

export interface RenderPlan {
  items: RenderItem[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasContent: boolean;
}

/**
 * Orden de dibujo compartido: las notas (trazos) van SIEMPRE arriba de las
 * fotos, sin excepcion, y dentro de cada grupo se respeta el orden de capa.
 * Un solo lugar para esta regla — la usan tanto este archivo (miniaturas y
 * export de galeria) como `Viewer.tsx` (el lienzo en vivo) — para que las
 * dos superficies no puedan divergir si la regla cambia en el futuro.
 */
export function compararOrdenDibujo(
  a: { esImagen: boolean; layerIndex: number },
  b: { esImagen: boolean; layerIndex: number }
): number {
  if (a.esImagen !== b.esImagen) return a.esImagen ? -1 : 1;
  return a.layerIndex - b.layerIndex;
}

/**
 * Junta los trazos e imagenes del documento en items dibujables, y calcula
 * el encuadre ("zoom all"). El encuadre SIEMPRE suma trazos e imagenes: solo
 * trazos dejaba fotos afuera de miniaturas/exports cuando estaban mas
 * extendidas que las anotaciones (mismo criterio que `computeFit` en
 * `Viewer.tsx`, que las dos superficies compartan la regla).
 */
export function buildRenderPlan(doc: Document): RenderPlan {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const items: RenderItem[] = [];

  doc.layers.forEach((layer) => {
    layer.strokes.forEach((stroke) => {
      if (stroke.points.length === 0) return;
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
    layer.texts.forEach((t) => {
      const lineas = t.text.split(/\r?\n/);
      items.push({
        type: "text",
        lineas,
        color: t.color.hex.slice(0, 7),
        alpha: t.color.a,
        transform: t.transform,
        layerIndex: layer.index,
      });
      // Caja aproximada para el encuadre: alto = lineas, ancho estimado por la
      // linea mas larga. No hace falta que sea exacta (medir de verdad exige un
      // contexto de canvas, que aca no hay); solo tiene que evitar que un texto
      // quede fuera del "ver todo".
      const m = t.transform;
      const alto = lineas.length * ALTO_LINEA_TEXTO;
      const ancho = Math.max(...lineas.map((l) => l.length)) * ALTO_LINEA_TEXTO * 0.55;
      for (const [x, y] of [[0, 0], [ancho, 0], [0, alto], [ancho, alto]]) {
        const px = m[0] * x + m[4] * y + m[12];
        const py = m[1] * x + m[5] * y + m[13];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    });
  });

  doc.layers.forEach((layer) => {
    layer.images.forEach((img) => {
      items.push({
        type: "image",
        resourceId: img.resourceId,
        transform: img.transform,
        width: img.width,
        height: img.height,
        layerIndex: layer.index,
        isPhoto: img.isPhoto,
      });
      // Con la matriz aplicada, no [tx, ty, tx+ancho, ty+alto]: ese atajo
      // ignora escala y rotacion, y en los dibujos con planos rotados -90
      // grados daba un encuadre diez veces mas grande y corrido, o sea una
      // miniatura casi vacia con el dibujo perdido en una esquina.
      const m = img.transform;
      const w = img.width || 500;
      const h = img.height || 500;
      if (m && m.length === 16) {
        const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
        for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
          const x = a * px + c * py + e;
          const y = b * px + d * py + f;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    });
  });

  // Las notas (trazos) van SIEMPRE arriba de las fotos, sin excepcion: se
  // armaron en dos pasadas separadas (arriba, trazos primero) solo para
  // calcular bien el encuadre; el orden de DIBUJO se decide aca, aparte,
  // independiente del orden en que se acumularon. Se ordena una sola vez
  // (y no en cada dibujado: drawItems se llama por frame en el visor y
  // re-ordenar decenas de miles de items 60 veces por segundo era puro
  // trabajo tirado).
  items.sort((a, b) =>
    compararOrdenDibujo(
      { esImagen: a.type === "image", layerIndex: a.layerIndex },
      { esImagen: b.type === "image", layerIndex: b.layerIndex }
    )
  );

  return { items, minX, minY, maxX, maxY, hasContent: minX !== Infinity };
}

/** Dibuja los items (ya ordenados: todas las imagenes primero, todos los
 * trazos despues, para que las notas queden siempre arriba) sobre un
 * contexto ya trasladado/escalado por el que llama. */
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
    } else if (item.type === "text") {
      dibujarTexto(ctx, item);
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

/**
 * Dibuja un texto de la herramienta de texto.
 *
 * Se pinta en el espacio del elemento (una linea mide `ALTO_LINEA_TEXTO`) y la
 * matriz se encarga de ubicarlo, rotarlo y escalarlo, igual que con una imagen.
 *
 * El `scale(-1,-1)` NO es un ajuste a ojo: la matriz de colocacion deja el
 * marco local con los DOS ejes invertidos respecto de la pantalla, asi que un
 * texto dibujado "hacia la derecha y hacia abajo" sale hacia la izquierda y
 * hacia arriba, o sea girado media vuelta (se vio: "Dicroicas" y "Panel led"
 * cabeza abajo y al reves). Al invertir los dos ejes el marco vuelve a ser uno
 * normal de pantalla y el ancla (0,0) no se mueve, porque escalar no traslada
 * el origen: el texto sigue arrancando en el mismo punto del documento.
 *
 * Una imagen no necesita esto porque su contenido se estira sobre una caja de
 * ancho x alto —da igual en que direccion crezca la caja—, mientras que un
 * texto se dibuja desde un punto y crece solo.
 */
export function dibujarTexto(
  ctx: CanvasRenderingContext2D,
  item: Extract<RenderItem, { type: "text" }>
) {
  const m = item.transform;
  ctx.save();
  if (m && m.length === 16) ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
  ctx.scale(-1, -1);
  ctx.fillStyle = item.color;
  ctx.globalAlpha = item.alpha;
  ctx.font = `${ALTO_LINEA_TEXTO}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  item.lineas.forEach((linea, i) => {
    ctx.fillText(linea, 0, i * ALTO_LINEA_TEXTO);
  });
  ctx.restore();
}
