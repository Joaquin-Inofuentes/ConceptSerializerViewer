import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { ZipArchive, BufferSource, FileSource, RemoteSource } from "./zip";
import type { ZipSource } from "./zip";

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Point {
  x: number;
  y: number;
  p: number; // pressure
  t1: number; // tilt1
  t2: number; // tilt2
}

export interface Stroke {
  id: string;
  points: Point[];
  color: { r: number; g: number; b: number; a: number; hex: string };
  width: number;
  bbox: BBox;
}

export interface ImageElement {
  id: string;
  resourceId: string;
  blobUrl?: string;
  width: number;
  height: number;
  transform: number[];
}

export interface Layer {
  id: string;
  index: number;
  strokes: Stroke[];
  images: ImageElement[];
}

export interface Document {
  layers: Layer[];
  bbox: BBox;
  /**
   * Ids de los recursos efectivamente COLOCADOS en alguna capa, del mas
   * chico al mas grande (asi lo que se puede mostrar antes se muestra
   * antes). Un .concepts guarda todos los adjuntos que se usaron alguna vez
   * — el dibujo de 262 MB trae 96 PDFs y solo 19 estan en el lienzo — asi
   * que esta lista es MUCHO mas corta que el contenido del zip.
   */
  resourceIds: string[];
  /** Tamaño comprimido de cada recurso, para poder priorizar y estimar. */
  resourceSizes: Record<string, number>;
  /**
   * Materializa un recurso a demanda. En un archivo remoto esto dispara un
   * rango HTTP; en uno local, una lectura del buffer. Devuelve null si el
   * recurso no esta en el zip (referencia rota).
   */
  loadResource(id: string): Promise<Blob | null>;
  /**
   * Trae por adelantado los bytes de varios recursos en pocas requests (los
   * recursos estan contiguos en el archivo). Sin esto se gasta una ida y
   * vuelta HTTP por recurso: 19 planos = 19 viajes de ~1,1 s cada uno.
   * Es una optimizacion: si falla, `loadResource` igual funciona.
   */
  prefetchResources(ids: string[]): Promise<void>;
  /** Suelta el archivo/las conexiones. Idempotente. */
  close(): void;
  /** Total de bytes del archivo (para diagnostico y metricas). */
  totalBytes: number;
}

const extensionCodec = new ExtensionCodec();
const dummyEncode = () => new Uint8Array();

extensionCodec.register({
  type: 0,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 1,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 2,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 4,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
      view.getFloat32(12, true),
    ];
  },
});
extensionCodec.register({
  type: 5,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});
extensionCodec.register({
  type: 7,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const m = [];
    for (let i = 0; i < 16; i++) {
      m.push(view.getFloat32(i * 4, true));
    }
    return m;
  },
});

function rgbaToHex(r: number, g: number, b: number, a: number) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const hexR = Math.round(clamp(r) * 255).toString(16).padStart(2, "0");
  const hexG = Math.round(clamp(g) * 255).toString(16).padStart(2, "0");
  const hexB = Math.round(clamp(b) * 255).toString(16).padStart(2, "0");
  const hexA = Math.round(clamp(a) * 255).toString(16).padStart(2, "0");
  return `#${hexR}${hexG}${hexB}${hexA}`;
}

/**
 * Devuelve la vista previa que la propia app Concepts deja adentro del
 * archivo (`thumb.jpg`), si esta. Es una imagen de 640x1024 renderizada por
 * Concepts: se ve mejor que cualquier cosa que podamos dibujar nosotros y
 * sale por dos ordenes de magnitud menos de trabajo — no hay que decodificar
 * el arbol del documento ni rasterizar los PDFs embebidos (que cuestan ~1,5 s
 * cada uno sin importar a que tamaño se los pida).
 */
export async function readEmbeddedThumbnail(
  fuente: ArrayBuffer | ZipSource
): Promise<Blob | null> {
  try {
    const zip = await ZipArchive.open(fuente as ZipSource);
    const nombre = zip.names().find((n) => /(^|\/)thumb\.jpe?g$/i.test(n));
    if (!nombre) return null;
    return await zip.readBlob(nombre, "image/jpeg");
  } catch {
    return null;
  }
}

/** Miniatura embebida leyendo por rangos: en vez de bajar el archivo entero
 * (262 MB) para sacar una imagen de 192 px, baja el indice + el thumb.jpg
 * (~110 KB en el peor caso, 2400x menos datos). */
export async function readEmbeddedThumbnailRemote(
  url: string,
  headers: Record<string, string> = {}
): Promise<Blob | null> {
  try {
    const source = await RemoteSource.open(url, headers);
    return await readEmbeddedThumbnail(source);
  } catch {
    return null;
  }
}

export interface ParseOptions {
  /** Se llama con los bytes transferidos, para medir el ahorro real. */
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
}

/**
 * FASE 1 del parseo: decodifica el arbol del documento (trazos, capas y la
 * ubicacion de las imagenes) leyendo SOLO `tree.pack`. Los recursos pesados
 * (fotos, PDFs) no se tocan: quedan disponibles via `doc.loadResource(id)`.
 *
 * Medido sobre la carpeta real: `tree.pack` pesa 0,79 MB en el dibujo de
 * 262,9 MB y vive en el offset 0 del zip, asi que los trazos se pueden
 * mostrar bajando ~1 MB en vez de 262.
 */
export async function parseConceptsSource(
  fuente: ZipSource,
  opts: ParseOptions = {}
): Promise<Document> {
  void opts;
  return documentoDesdeZip(await ZipArchive.open(fuente), fuente);
}

async function documentoDesdeZip(zip: ZipArchive, fuente: ZipSource): Promise<Document> {
  const nombreTree = zip.has("tree.pack")
    ? "tree.pack"
    : zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) {
    throw new Error("No se encontró tree.pack en el archivo.");
  }
  const treeData = await zip.read(nombreTree);
  const tree = decode(treeData, { extensionCodec }) as any;

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;

  const layers: Layer[] = [];
  const globalBbox: BBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  if (Array.isArray(docData)) {
    const docCapas = docData.find(x => Array.isArray(x) && x.length > 0 && x.every(c => Array.isArray(c) && c.length > 0 && c[0] === 1));

    if (docCapas) {
      docCapas.forEach((capa: any, index: number) => {
        layers.push(procesarCapa(capa, index, globalBbox));
      });
    } else {
      const fallbackLayer: Layer = { id: "fallback", index: 0, strokes: [], images: [] };
      buscarElementos(docData, fallbackLayer, globalBbox);
      if (fallbackLayer.strokes.length > 0 || fallbackLayer.images.length > 0) {
        layers.push(fallbackLayer);
      }
    }
  }

  const { ids, sizes, porId } = mapearRecursos(zip, layers);

  const cacheBlobs = new Map<string, Blob>();
  let cerrado = false;

  const doc: Document = {
    layers,
    bbox: globalBbox,
    resourceIds: ids,
    resourceSizes: sizes,
    totalBytes: fuente.size,
    async loadResource(id: string) {
      if (cerrado) return null;
      const hit = cacheBlobs.get(id);
      if (hit) return hit;
      const nombre = porId.get(id);
      if (!nombre) return null;
      try {
        const blob = await zip.readBlob(nombre);
        if (cerrado) return null;
        cacheBlobs.set(id, blob);
        return blob;
      } catch (e) {
        console.error("No se pudo leer el recurso", id, nombre, e);
        return null;
      }
    },
    async prefetchResources(ids: string[]) {
      if (cerrado) return;
      const nombres = ids.map((id) => porId.get(id)).filter((n): n is string => !!n);
      if (nombres.length === 0) return;
      try {
        await zip.prefetch(nombres);
      } catch {
        // Es solo un adelanto; si falla, cada recurso se pide por su cuenta.
      }
    },
    close() {
      cerrado = true;
      cacheBlobs.clear();
      if (fuente instanceof RemoteSource) fuente.liberar();
    },
  };
  return doc;
}

/**
 * Archivo .concepts abierto UNA sola vez, del que se pueden sacar tanto la
 * vista previa como el documento.
 *
 * Importa porque leer el indice del zip cuesta una ida y vuelta HTTP (~1,7 s
 * a traves del proxy de Drive): abrir dos lectores distintos —uno para el
 * thumbnail y otro para parsear— pagaba ese costo dos veces, y ademas volvia
 * a pedir bytes que ya estaban en el cache de bloques del primero.
 */
export interface ConceptsFile {
  /** Vista previa embebida (thumb.jpg). null si el archivo no la trae. */
  thumbnail(): Promise<Blob | null>;
  /** Documento completo (trazos + capas). Los recursos siguen a demanda. */
  parse(): Promise<Document>;
  close(): void;
  totalBytes: number;
}

export async function openConceptsSource(fuente: ZipSource): Promise<ConceptsFile> {
  const zip = await ZipArchive.open(fuente);
  return {
    totalBytes: fuente.size,
    async thumbnail() {
      const nombre = zip.names().find((n) => /(^|\/)thumb\.jpe?g$/i.test(n));
      if (!nombre) return null;
      try {
        return await zip.readBlob(nombre, "image/jpeg");
      } catch {
        return null;
      }
    },
    parse: () => documentoDesdeZip(zip, fuente),
    close() {
      if (fuente instanceof RemoteSource) fuente.liberar();
    },
  };
}

/** Abre un archivo remoto (por rangos) una sola vez. */
export async function openConceptsRemote(
  url: string,
  headers: Record<string, string> = {},
  opts: ParseOptions & { size?: number } = {}
): Promise<ConceptsFile> {
  const source = await RemoteSource.open(url, headers, {
    size: opts.size,
    signal: opts.signal,
    onBytes: opts.onBytes,
  });
  return openConceptsSource(source);
}

/** Abre un archivo local elegido por el usuario (sin cargarlo entero). */
export async function openConceptsLocal(file: File): Promise<ConceptsFile> {
  return openConceptsSource(new FileSource(file));
}

/** Compat: parsear desde un ArrayBuffer ya en memoria. */
export async function parseConceptsFile(fileBuffer: ArrayBuffer): Promise<Document> {
  return parseConceptsSource(new BufferSource(fileBuffer));
}

/** Parsear un archivo local elegido por el usuario, sin cargarlo entero. */
export async function parseConceptsLocalFile(file: File): Promise<Document> {
  return parseConceptsSource(new FileSource(file));
}

/**
 * Parsear un archivo REMOTO leyendo por rangos HTTP. Es el camino normal de
 * la app: baja el indice del zip + tree.pack (~1 MB) y despues cada recurso
 * colocado a demanda.
 */
export async function parseConceptsRemote(
  url: string,
  headers: Record<string, string> = {},
  opts: ParseOptions & { size?: number } = {}
): Promise<Document> {
  const source = await RemoteSource.open(url, headers, {
    size: opts.size,
    signal: opts.signal,
    onBytes: opts.onBytes,
  });
  return parseConceptsSource(source, opts);
}

/**
 * Resuelve, para cada recurso COLOCADO en una capa, cual entrada del zip le
 * corresponde. El mapeo id -> archivo se hace por nombre
 * (resources/<uuid>.<ext>) comparando el uuid sin guiones, que es como venia
 * haciendose. No materializa nada: solo arma el indice.
 */
function mapearRecursos(zip: ZipArchive, layers: Layer[]) {
  const usados = new Set<string>();
  layers.forEach((l) => l.images.forEach((img) => img.resourceId && usados.add(img.resourceId)));

  const porId = new Map<string, string>();
  const sizes: Record<string, number> = {};
  if (usados.size === 0) return { ids: [] as string[], sizes, porId };

  // Un solo recorrido de las entradas, indexadas por nombre normalizado: con
  // 96 entradas y 19 recursos, el doble for anidado que habia antes hacia
  // casi 2000 comparaciones de strings largos.
  const normalizadas = zip.names().map((n) => ({ real: n, norm: n.replace(/-/g, "") }));

  for (const uuid of usados) {
    const plano = uuid.replace(/-/g, "");
    const hit = normalizadas.find((n) => n.norm.includes(plano));
    if (!hit) continue;
    porId.set(uuid, hit.real);
    sizes[uuid] = zip.get(hit.real)?.compressedSize ?? 0;
  }

  // De menor a mayor: los recursos chicos se rasterizan y aparecen antes, asi
  // el lienzo se va completando en vez de quedarse vacio esperando al PDF de
  // 20 MB.
  const ids = [...porId.keys()].sort((a, b) => (sizes[a] || 0) - (sizes[b] || 0));
  return { ids, sizes, porId };
}

function procesarCapa(nodo: any, idx: number, globalBbox: BBox): Layer {
  const hdr = nodo[1];
  let capaId = "";
  if (Array.isArray(hdr) && hdr.length > 1) {
     capaId = hdr[1]; 
  }
  
  const layer: Layer = { id: capaId, index: idx, strokes: [], images: [] };
  
  const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
  for (const item of items) {
    procesarItem(item, layer, globalBbox);
  }
  return layer;
}

function procesarItem(item: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(item) || item.length === 0) return;
  
  const tipo = item[0];
  const cuerpo = item.length > 1 ? item[1] : null;
  
  if (tipo === 8 && Array.isArray(cuerpo)) {
    const interno = Array.isArray(cuerpo) && cuerpo.length > 1 && Array.isArray(cuerpo[1]) ? cuerpo[1] : [];
    
    let elementoId = "";
    const u = interno.find(x => typeof x === "string" && x.includes("-"));
    if (u) elementoId = u;
    
    let resourceId = "";
    const ru = cuerpo.find(x => typeof x === "string" && x.includes("-"));
    if (ru) resourceId = ru;
    
    let width = 0, height = 0;
    const tam = cuerpo.find(x => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
    if (tam) { width = tam[0]; height = tam[1]; }
    
    let transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const mat = interno.find(x => Array.isArray(x) && x.length === 16);
    if (mat) transform = mat;
    
    layer.images.push({
      id: elementoId,
      resourceId,
      width,
      height,
      transform
    });
    
  } else if (tipo === 1 && item.length > 1 && Array.isArray(item[1]) && item[1].length > 0 && item[1][0] === 4) {
    // subcapa
  } else {
    buscarElementos(item, layer, globalBbox);
  }
}

function buscarElementos(o: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(o)) return;
  
  const blobs = o.filter(x => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);
  
  if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
    emitirTrazo(o, blobs[0], layer, globalBbox);
    return;
  }
  
  for (const x of o) {
    buscarElementos(x, layer, globalBbox);
  }
}

function emitirTrazo(o: any, blob: Uint8Array, layer: Layer, globalBbox: BBox) {
  const hdr = o[1];
  
  const stroke: Stroke = {
    id: "",
    points: [],
    color: { r: 0, g: 0, b: 0, a: 1, hex: "#000000" },
    width: 1,
    bbox: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  };
  
  try {
    const bw = hdr[1][1];
    const core = bw[1];
    const col = core[2];
    if (Array.isArray(col) && col.length >= 4) {
      stroke.color = {
        r: col[0], g: col[1], b: col[2], a: col[3],
        hex: rgbaToHex(col[0], col[1], col[2], col[3])
      };
    }
    stroke.width = bw[3] || 1;
  } catch {
    // fallback
  }
  
  const u = hdr.find((x: any) => typeof x === "string" && x.includes("-"));
  if (u) stroke.id = u;
  
  const n = Math.floor(blob.length / 16);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  
  for (let i = 0; i < n; i++) {
    const x = view.getFloat32(i * 16, true);
    const y = view.getFloat32(i * 16 + 4, true);
    const p = view.getUint16(i * 16 + 8, true);
    const t1 = view.getUint16(i * 16 + 10, true);
    const t2 = view.getUint16(i * 16 + 12, true);
    
    stroke.points.push({ x, y, p, t1, t2 });
    
    if (x < stroke.bbox.minX) stroke.bbox.minX = x;
    if (x > stroke.bbox.maxX) stroke.bbox.maxX = x;
    if (y < stroke.bbox.minY) stroke.bbox.minY = y;
    if (y > stroke.bbox.maxY) stroke.bbox.maxY = y;
    
    if (x < globalBbox.minX) globalBbox.minX = x;
    if (x > globalBbox.maxX) globalBbox.maxX = x;
    if (y < globalBbox.minY) globalBbox.minY = y;
    if (y > globalBbox.maxY) globalBbox.maxY = y;
  }
  
  layer.strokes.push(stroke);
}
