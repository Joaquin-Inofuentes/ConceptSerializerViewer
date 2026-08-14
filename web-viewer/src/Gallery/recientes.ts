/**
 * Ultimos dibujos abiertos.
 *
 * Guarda SOLO la ruta y el id (unos cientos de bytes por entrada), nunca la
 * miniatura ni los bytes del archivo: la miniatura ya vive en el cache de
 * Supabase y el archivo no se guarda en ningun lado. Asi la lista de
 * recientes es gratis en memoria y en disco.
 *
 * Comparte la base de datos con el cache de rasterizados pero en otro store,
 * para no abrir dos conexiones de IndexedDB.
 */

const DB_NAME = "concepts-recientes";
const DB_VERSION = 1;
const STORE = "recientes";
const MAX = 12;

export interface Reciente {
  /** id del archivo en Drive. */
  id: string;
  /** Nombre del dibujo, ya limpio. */
  nombre: string;
  /** Ruta legible: ["Guada y Flor Re", "Concepts", "ROOSEVELT 4464"]. */
  ruta: string[];
  /** Slug compartible que va en la URL. */
  slug: string;
  abiertoEn: number;
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
        db.createObjectStore(STORE, { keyPath: "id" }).createIndex("abiertoEn", "abiertoEn");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function conStore<T>(modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
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

export async function registrarAbierto(r: Omit<Reciente, "abiertoEn">): Promise<void> {
  await conStore("readwrite", (s) => s.put({ ...r, abiertoEn: Date.now() } as Reciente));
  // Recorte por cola: solo se conservan los MAX mas recientes.
  const todos = (await conStore<Reciente[]>("readonly", (s) => s.getAll() as IDBRequest<Reciente[]>)) as
    | Reciente[]
    | null;
  if (!todos || todos.length <= MAX) return;
  todos.sort((a, b) => b.abiertoEn - a.abiertoEn);
  for (const viejo of todos.slice(MAX)) {
    await conStore("readwrite", (s) => s.delete(viejo.id));
  }
}

export async function listarRecientes(limite = 6): Promise<Reciente[]> {
  const todos = (await conStore<Reciente[]>("readonly", (s) => s.getAll() as IDBRequest<Reciente[]>)) as
    | Reciente[]
    | null;
  if (!todos) return [];
  return todos.sort((a, b) => b.abiertoEn - a.abiertoEn).slice(0, limite);
}

export async function vaciarRecientes(): Promise<void> {
  await conStore("readwrite", (s) => s.clear());
}
