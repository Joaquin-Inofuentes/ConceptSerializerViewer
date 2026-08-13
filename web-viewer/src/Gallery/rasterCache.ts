/**
 * Cache persistente (IndexedDB) de recursos ya rasterizados.
 *
 * Rasterizar un PDF con pdf.js cuesta ~1,5 s en desktop y ~9 s en un telefono
 * de gama baja, y ese costo se pagaba ENTERO cada vez que se abria el mismo
 * dibujo. Guardando el resultado como JPEG/PNG, reabrir cuesta un
 * createImageBitmap (~10-50 ms): dos ordenes de magnitud menos.
 *
 * La clave incluye la escala redondeada, asi que un mismo recurso puede tener
 * la version de pantalla y la de export sin pisarse.
 */

import { getBudgets } from "../device";

const DB_NAME = "concepts-raster";
const DB_VERSION = 1;
const STORE = "bitmaps";

interface FilaCache {
  key: string;
  fileId: string;
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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("usadoEn", "usadoEn");
        store.createIndex("fileId", "fileId");
      }
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

export function claveRaster(fileId: string, resourceId: string, width: number, height: number): string {
  // El tamaño se redondea a escalones de 1,25x: pedir 812 px cuando hay 800
  // guardados no justifica re-rasterizar 9 segundos.
  const escalon = (v: number) => Math.round(Math.pow(1.25, Math.round(Math.log(Math.max(v, 1)) / Math.log(1.25))));
  return `${fileId}|${resourceId}|${escalon(width)}x${escalon(height)}`;
}

/**
 * Busca un rasterizado guardado.
 *
 * NO se compara el tamaño guardado contra el pedido: lo que se guarda es el
 * tamaño ya RECORTADO por los limites (resolucion nativa del bitmap,
 * presupuesto de RAM del dispositivo), que casi siempre es menor que lo
 * pedido. Compararlos hacia que el cache no acertara nunca — se volvia a
 * rasterizar el PDF entero (~9 s en gama baja) aunque estuviera guardado.
 *
 * La clave ya codifica el tamaño PEDIDO en escalones de 1,25x, asi que
 * acercarse de verdad genera otra clave y otra entrada: la nitidez al hacer
 * zoom queda garantizada por la clave, no por esta comparacion.
 */
export async function leerRaster(key: string): Promise<ImageBitmap | null> {
  const fila = (await conStore<FilaCache>("readonly", (s) => s.get(key) as IDBRequest<FilaCache>)) as
    | FilaCache
    | null;
  if (!fila || !fila.blob) return null;
  try {
    const bitmap = await createImageBitmap(fila.blob);
    void conStore("readwrite", (s) => s.put({ ...fila, usadoEn: Date.now() }));
    return bitmap;
  } catch {
    return null;
  }
}

/** Guarda un rasterizado. Silencioso ante errores: el cache es un lujo, no
 * puede romper la apertura de un dibujo. */
export async function guardarRaster(
  key: string,
  fileId: string,
  fuente: CanvasImageSource
): Promise<void> {
  try {
    const width = (fuente as any).width as number;
    const height = (fuente as any).height as number;
    if (!(width > 0) || !(height > 0)) return;

    // Acepta tanto ImageBitmap (camino del worker) como HTMLCanvasElement
    // (fallback en el hilo principal). Guardar solo los ImageBitmap dejaba el
    // cache vacio en cuanto el worker no arrancaba, y como el fallback es
    // silencioso eso no se notaba: reabrir un dibujo volvia a rasterizar
    // todos los PDFs igual que la primera vez.
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
      s.put({ key, fileId, blob, width, height, bytes: blob!.size, usadoEn: Date.now() } as FilaCache)
    );
    void podar();
  } catch {
    /* sin cache */
  }
}

let podando = false;

/** Descarta lo menos usado recientemente hasta entrar en el presupuesto del
 * dispositivo (50 MB en gama baja). */
async function podar(): Promise<void> {
  if (podando) return;
  podando = true;
  try {
    const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
      | FilaCache[]
      | null;
    if (!filas) return;
    const tope = getBudgets().maxRasterCacheBytes;
    let total = filas.reduce((n, f) => n + (f.bytes || 0), 0);
    if (total <= tope) return;
    filas.sort((a, b) => (a.usadoEn || 0) - (b.usadoEn || 0));
    for (const f of filas) {
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
  const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
    | FilaCache[]
    | null;
  if (!filas) return;
  for (const f of filas) {
    if (f.fileId === fileId) await conStore("readwrite", (s) => s.delete(f.key));
  }
}
