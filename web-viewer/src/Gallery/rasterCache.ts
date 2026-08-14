/**
 * Cache persistente (IndexedDB) de recursos ya rasterizados.
 *
 * Rasterizar un PDF con pdf.js cuesta ~1,5 s en desktop y ~9 s en un telefono
 * de gama baja, y ese costo se pagaba ENTERO cada vez que se abria el mismo
 * dibujo. Guardando el resultado como JPEG, reabrir cuesta un
 * createImageBitmap (~10-50 ms): dos ordenes de magnitud menos.
 *
 * Se guardan como mucho los ULTIMOS 3 archivos abiertos, y se desaloja por
 * cola (el que hace mas que no se usa sale primero). Guardar mas no ayuda: en
 * un telefono de 1 GB el espacio de IndexedDB es limitado y el usuario vuelve
 * casi siempre a los dibujos que acaba de ver.
 */

import { getBudgets } from "../device";

const DB_NAME = "concepts-raster";
/**
 * v3: los rasterizados de la v2 estan DEFORMADOS. Se guardaron usando el
 * viewport que pdf.js rota por /Rotate, cuando la geometria de Concepts vive
 * en el espacio sin rotar; subir la version borra el store y obliga a
 * regenerarlos bien. Sin esto, quien ya abrio un dibujo seguiria viendo los
 * planos aplastados aunque el codigo este arreglado.
 */
const DB_VERSION = 3;
const STORE = "bitmaps";
/** Cuantos ARCHIVOS distintos se conservan. */
export const MAX_ARCHIVOS_CACHEADOS = 3;

interface FilaCache {
  key: string;
  fileId: string;
  resourceId: string;
  /** Tamaño que se habia PEDIDO (no el guardado, que suele ser menor tras
   * recortar por resolucion nativa o presupuesto de RAM). */
  pedidoW: number;
  pedidoH: number;
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  usadoEn: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function abrirDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // La v1 no tenia el indice por recurso; se recrea el store entero en vez
      // de migrar (es un cache, perderlo solo cuesta una rasterizacion).
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("usadoEn", "usadoEn");
      store.createIndex("fileId", "fileId");
      store.createIndex("porRecurso", ["fileId", "resourceId"]);
    };
    req.onsuccess = () => resolve(req.result);
    // Modo incognito / storage bloqueado: se sigue sin cache, no es fatal.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function conStore<T>(
  modo: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return abrirDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, modo);
        } catch {
          return resolve(null);
        }
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      })
  );
}

/** Redondea a escalones de 1,25x para que un pedido de 812 px reuse el de 800
 * en vez de re-rasterizar 9 segundos por una diferencia invisible. */
function escalon(v: number): number {
  return Math.round(Math.pow(1.25, Math.round(Math.log(Math.max(v, 1)) / Math.log(1.25))));
}

export function claveRaster(fileId: string, resourceId: string, width: number, height: number): string {
  return `${fileId}|${resourceId}|${escalon(width)}x${escalon(height)}`;
}

/**
 * Busca un rasterizado guardado.
 *
 * Dos niveles, y el segundo es el que importa: primero la clave exacta, y si
 * no esta, CUALQUIER version guardada del mismo recurso que sea al menos tan
 * grande como la pedida. Sin ese segundo nivel el cache fallaba cada vez que
 * la clave se corria un escalon —lo que pasa por ejemplo si el encuadre
 * inicial cambia unos pixeles, o si el presupuesto de RAM recorto el pedido—
 * y el resultado era volver a rasterizar el PDF entero teniendolo guardado.
 * Medido: en un dibujo de 6 recursos acertaba 4 y fallaba 2 por esto.
 */
export async function leerRaster(
  fileId: string,
  resourceId: string,
  pedidoW: number,
  pedidoH: number
): Promise<ImageBitmap | null> {
  const exacta = claveRaster(fileId, resourceId, pedidoW, pedidoH);
  let fila = (await conStore<FilaCache>("readonly", (s) => s.get(exacta) as IDBRequest<FilaCache>)) as
    | FilaCache
    | null;

  if (!fila) {
    const candidatas = (await conStore<FilaCache[]>("readonly", (s) =>
      s.index("porRecurso").getAll([fileId, resourceId]) as IDBRequest<FilaCache[]>
    )) as FilaCache[] | null;
    if (candidatas && candidatas.length) {
      // Sirve la que se pidio con al menos el 80% del tamaño actual (por
      // debajo de eso se veria borrosa al acercarse). De las que sirven, la
      // mas chica, para no gastar RAM de mas.
      const utiles = candidatas
        .filter((c) => c.pedidoW >= pedidoW * 0.8 && c.pedidoH >= pedidoH * 0.8)
        .sort((a, b) => a.pedidoW * a.pedidoH - b.pedidoW * b.pedidoH);
      fila = utiles[0] || null;
    }
  }

  if (!fila || !fila.blob) return null;
  try {
    const bitmap = await createImageBitmap(fila.blob);
    void conStore("readwrite", (s) => s.put({ ...fila!, usadoEn: Date.now() }));
    return bitmap;
  } catch {
    return null;
  }
}

/** Guarda un rasterizado. Silencioso ante errores: el cache es un lujo, no
 * puede romper la apertura de un dibujo. */
export async function guardarRaster(
  fileId: string,
  resourceId: string,
  pedidoW: number,
  pedidoH: number,
  fuente: CanvasImageSource
): Promise<void> {
  try {
    const width = (fuente as any).width as number;
    const height = (fuente as any).height as number;
    if (!(width > 0) || !(height > 0)) return;

    // Acepta tanto ImageBitmap (camino del worker) como HTMLCanvasElement
    // (fallback en el hilo principal). Guardar solo los ImageBitmap dejaba el
    // cache vacio en cuanto el worker no arrancaba, y como el fallback es
    // silencioso eso no se notaba.
    let blob: Blob | null = null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(fuente, 0, 0);
      // JPEG: un plano rasterizado de 1500x800 pesa ~150 KB en JPEG contra
      // ~5 MB en PNG, y la diferencia visual a esta escala es nula.
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
      canvas.width = 0;
      canvas.height = 0;
    } else if (typeof HTMLCanvasElement !== "undefined" && fuente instanceof HTMLCanvasElement) {
      blob = await new Promise<Blob | null>((r) => fuente.toBlob(r, "image/jpeg", 0.88));
    }
    if (!blob) return;

    await conStore("readwrite", (s) =>
      s.put({
        key: claveRaster(fileId, resourceId, pedidoW, pedidoH),
        fileId,
        resourceId,
        pedidoW: Math.round(pedidoW),
        pedidoH: Math.round(pedidoH),
        blob,
        width,
        height,
        bytes: blob!.size,
        usadoEn: Date.now(),
      } as FilaCache)
    );
    void podar();
  } catch {
    /* sin cache */
  }
}

let podando = false;

/**
 * Desaloja por cola: primero los ARCHIVOS que hace mas que no se abren (se
 * conservan los ultimos MAX_ARCHIVOS_CACHEADOS), y despues, si aun no entra
 * en el presupuesto del dispositivo, las entradas mas viejas.
 */
async function podar(): Promise<void> {
  if (podando) return;
  podando = true;
  try {
    const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
      | FilaCache[]
      | null;
    if (!filas || filas.length === 0) return;

    // Ultimo uso por archivo, para saber cuales son los 3 mas recientes.
    const ultimoPorArchivo = new Map<string, number>();
    filas.forEach((f) => {
      ultimoPorArchivo.set(f.fileId, Math.max(ultimoPorArchivo.get(f.fileId) || 0, f.usadoEn || 0));
    });
    const archivosOrdenados = [...ultimoPorArchivo.entries()].sort((a, b) => b[1] - a[1]);
    const aConservar = new Set(archivosOrdenados.slice(0, MAX_ARCHIVOS_CACHEADOS).map(([id]) => id));

    let quedan: FilaCache[] = [];
    for (const f of filas) {
      if (aConservar.has(f.fileId)) quedan.push(f);
      else await conStore("readwrite", (s) => s.delete(f.key));
    }

    // Segundo corte: el presupuesto de bytes del dispositivo.
    const tope = getBudgets().maxRasterCacheBytes;
    let total = quedan.reduce((n, f) => n + (f.bytes || 0), 0);
    if (total <= tope) return;
    quedan.sort((a, b) => (a.usadoEn || 0) - (b.usadoEn || 0));
    for (const f of quedan) {
      if (total <= tope) break;
      await conStore("readwrite", (s) => s.delete(f.key));
      total -= f.bytes || 0;
    }
  } finally {
    podando = false;
  }
}

/** Borra todo lo cacheado de un archivo (ej. cambio en Drive). */
export async function invalidarArchivo(fileId: string): Promise<void> {
  const filas = (await conStore<FilaCache[]>("readonly", (s) =>
    s.index("fileId").getAll(fileId) as IDBRequest<FilaCache[]>
  )) as FilaCache[] | null;
  if (!filas) return;
  for (const f of filas) await conStore("readwrite", (s) => s.delete(f.key));
}

/** Cuantos archivos y bytes hay cacheados (para diagnostico y para la UI). */
export async function estadoCache(): Promise<{ archivos: number; entradas: number; bytes: number }> {
  const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
    | FilaCache[]
    | null;
  if (!filas) return { archivos: 0, entradas: 0, bytes: 0 };
  return {
    archivos: new Set(filas.map((f) => f.fileId)).size,
    entradas: filas.length,
    bytes: filas.reduce((n, f) => n + (f.bytes || 0), 0),
  };
}

/** Vacia el cache de rasterizados. Lo usa el boton de restablecer. */
export async function vaciarCache(): Promise<void> {
  await conStore("readwrite", (s) => s.clear());
}
