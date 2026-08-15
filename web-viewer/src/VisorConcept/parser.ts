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
  /**
   * Bytes que hay que transferir de verdad para mostrar el dibujo completo:
   * el arbol del documento mas los recursos efectivamente colocados. Es la
   * base del porcentaje de carga — sin esto habria que inventar un numero,
   * porque el tamaño del archivo (262 MB) no tiene relacion con lo que se
   * baja (11 MB).
   */
  bytesNecesarios: number;
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

/**
 * Concepts guarda el documento girado 180 grados respecto de como lo muestra.
 *
 * Se nota en cuanto se mira texto: los planos salian con el rotulo del lado
 * equivocado y las anotaciones a mano ("FALTA COLOCAR", "CASA") se leian cabeza
 * abajo. No era cosa de un dibujo ni de un PDF puntual — se midio la direccion
 * en la que corre el texto de cada plano, ya pasada por la matriz con la que el
 * documento lo coloca, y dio hacia la izquierda en los 25 planos de los 5
 * archivos mas pesados. O sea: el documento entero.
 *
 * Girar 180 es lo mismo que negar las dos coordenadas, asi que se corrige en el
 * unico lugar por el que pasan todos: el parseo. De ahi para abajo (encuadre,
 * descarte por frustum, recortes, export, miniaturas) todo trabaja con
 * coordenadas ya derechas y no hay que acordarse de nada.
 *
 * OJO con arreglarlo mas arriba, en el rasterizado de los PDF: eso pone los
 * planos derechos pero deja los trazos al reves, y ahi las anotaciones dejan de
 * caer sobre lo que marcan — que es peor que tener todo consistentemente al
 * reves.
 *
 * PENDIENTE, medido en `Fede y Franco/Concepts/HO/Drawing`: ahi pasa
 * justamente eso que este comentario dice que hay que evitar, y pasa HOY. Al
 * acercarse a las anotaciones sueltas se lee "+0,10" y "+0,40" ESPEJADAS,
 * mientras el rotulo del plano que tienen al lado ("Holmberg 1764", "RESs",
 * "R0", "Subsuelo", "ESCALA 1:50") se lee perfecto. O sea: trazos y planos
 * quedaron a media vuelta uno del otro dentro de nuestro propio render.
 *
 * Eso NO deberia poder pasar: `girarPunto` y `girarTransform` aplican el mismo
 * giro de 180 grados alrededor del origen, asi que la geometria relativa entre
 * trazos e imagenes tendria que quedar intacta y o se leen los dos derechos o
 * los dos al reves. Que discrepen significa que el giro se esta aplicando de
 * forma asimetrica en algun punto entre leer los puntos y colocar la pagina
 * rasterizada.
 *
 * Dato que lo confirma: esas dos anotaciones son EXACTAMENTE las que el
 * thumb.jpg del archivo muestra apoyadas sobre las cocheras, asi que el
 * desface medido contra el thumb (~800 unidades) es real y no un thumb viejo.
 */
function girarPunto(x: number, y: number): [number, number] {
  return [-x, -y];
}

/**
 * La misma media vuelta, aplicada a la matriz con la que se coloca un recurso.
 *
 * Solo se tocan las 6 componentes de la afin 2D (las unicas que se usan al
 * dibujar): negarlas equivale a componer la matriz con un giro de 180 grados,
 * asi que la imagen queda derecha Y en el lugar que le corresponde.
 */
function girarTransform(m: number[]): number[] {
  if (!m || m.length !== 16) return m;
  const salida = m.slice();
  for (const i of [0, 1, 4, 5, 12, 13]) salida[i] = -salida[i];
  return salida;
}

/**
 * Ultimo recurso, deliberadamente cauteloso: si NINGUN trazo del documento
 * cae sobre NINGUNA imagen, es señal de un problema de convencion de
 * posicionamiento y no de anotaciones sueltas — un archivo real con fotos
 * anotadas siempre tiene AL MENOS algunas coincidencias, aunque sea un
 * puñado (medido en todo el corpus de prueba: el peor caso legitimo fue
 * 2%, nunca 0%).
 *
 * En ese caso puntual (0%), los grupos de 2+ imagenes que comparten
 * exactamente la misma escala y rotacion se tratan como paginas de la
 * misma plantilla repetida (la razon de que compartan matriz) y se centran
 * — mismo principio que el ajuste de matriz identidad de arriba, pero
 * generalizado a escalas/rotaciones reales.
 *
 * Por que hace falta el freno del 0%: el mismo patron de "varias imagenes
 * con la escala identica" tambien aparece por PURA COINCIDENCIA en
 * archivos sanos (varias fotos de camara comparten la escala por defecto
 * que la app les da al insertarlas, sin ser copias de una plantilla) — y
 * ahi centrarlas rompe una colocacion que ya estaba bien. Sin el freno del
 * 0% este mismo codigo arruinaba un archivo de referencia real (bajaba de
 * 85% a 6% de trazos coincidiendo). Con el freno, ese archivo nunca entra
 * a esta funcion porque ya tiene coincidencias.
 */
function corregirColocacionesFlotantes(layers: Layer[]) {
  const trazos: Array<{ cx: number; cy: number }> = [];
  for (const l of layers) {
    for (const s of l.strokes) {
      const b = s.bbox;
      trazos.push({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 });
    }
  }
  if (trazos.length === 0) return;

  const todasImagenes: ImageElement[] = [];
  for (const l of layers) todasImagenes.push(...l.images);
  if (todasImagenes.length === 0) return;

  const cajaDe = (img: ImageElement) => {
    const m = img.transform;
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const esquinas = [
      [0, 0],
      [img.width, 0],
      [0, img.height],
      [img.width, img.height],
    ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = esquinas.map((p) => p[0]);
    const ys = esquinas.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const cajas = todasImagenes.map(cajaDe);

  const algunaCoincide = trazos.some((t) =>
    cajas.some((c) => t.cx >= c.x0 && t.cx <= c.x1 && t.cy >= c.y0 && t.cy <= c.y1)
  );
  if (algunaCoincide) return;

  const claveDe = (m: number[]) => `${m[0].toFixed(6)},${m[1].toFixed(6)},${m[4].toFixed(6)},${m[5].toFixed(6)}`;
  const conteo = new Map<string, number>();
  for (const img of todasImagenes) {
    const k = claveDe(img.transform);
    conteo.set(k, (conteo.get(k) || 0) + 1);
  }

  for (const img of todasImagenes) {
    const k = claveDe(img.transform);
    if ((conteo.get(k) || 0) < 2) continue;
    const m = img.transform;
    const a = m[0], b = m[1], c = m[4], d = m[5];
    const nuevo = m.slice();
    nuevo[12] = m[12] - (a * img.width) / 2 - (c * img.height) / 2;
    nuevo[13] = m[13] - (b * img.width) / 2 - (d * img.height) / 2;
    img.transform = nuevo;
  }
}

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

  corregirColocacionesFlotantes(layers);

  const { ids, sizes, porId } = mapearRecursos(zip, layers);

  /**
   * Bytes ya bajados de cada recurso, con tope.
   *
   * Antes era un Map sin limite que solo se vaciaba al cerrar el dibujo: con
   * 96 imagenes colocadas, recorrer el dibujo entero terminaba reteniendo los
   * 262 MB del archivo en memoria de blobs — duplicados, porque lo que se
   * dibuja es el bitmap ya rasterizado, no el blob. En un telefono de 1 GB
   * Chrome pagina eso a disco y se siente como tirones de I/O, no como un
   * error limpio, asi que no aparecia en ningun bench.
   *
   * Se conserva lo ultimo usado: sirve para el refinado por zoom, que vuelve a
   * pedir el mismo recurso enseguida. Lo que se desaloja se vuelve a pedir por
   * rango HTTP si hace falta.
   */
  const cacheBlobs = new Map<string, Blob>();
  const lecturas = new Map<string, Promise<Blob | null>>();
  let bytesEnCache = 0;
  const MAX_BYTES_BLOBS = 16 * 1024 * 1024;
  const podarBlobs = () => {
    while (bytesEnCache > MAX_BYTES_BLOBS && cacheBlobs.size > 1) {
      const masViejo = cacheBlobs.keys().next().value as string | undefined;
      if (masViejo === undefined) break;
      const b = cacheBlobs.get(masViejo);
      cacheBlobs.delete(masViejo);
      bytesEnCache -= b ? b.size : 0;
    }
  };
  let cerrado = false;

  const bytesRecursos = ids.reduce((n, id) => n + (sizes[id] || 0), 0);
  const bytesTree = zip.get(nombreTree)?.compressedSize ?? 0;

  const doc: Document = {
    layers,
    bbox: globalBbox,
    resourceIds: ids,
    resourceSizes: sizes,
    totalBytes: fuente.size,
    bytesNecesarios: bytesTree + bytesRecursos,
    async loadResource(id: string) {
      if (cerrado) return null;
      const hit = cacheBlobs.get(id);
      if (hit) {
        // Renovar la posicion en la cola de uso.
        cacheBlobs.delete(id);
        cacheBlobs.set(id, hit);
        return hit;
      }
      // Si ya hay una lectura EN VUELO para este recurso, se espera esa. Sin
      // esto, dos pedidos simultaneos del mismo id (pasa cuando el refinado
      // por zoom se cruza con la carga del anillo) bajaban y materializaban
      // dos Blobs de varios MB del mismo contenido.
      const enVuelo = lecturas.get(id);
      if (enVuelo) return enVuelo;

      const nombre = porId.get(id);
      if (!nombre) return null;
      const tarea = (async () => {
        try {
          const blob = await zip.readBlob(nombre);
          if (cerrado) return null;
          cacheBlobs.set(id, blob);
          bytesEnCache += blob.size;
          podarBlobs();
          return blob;
        } catch (e) {
          console.error("No se pudo leer el recurso", id, nombre, e);
          return null;
        } finally {
          lecturas.delete(id);
        }
      })();
      lecturas.set(id, tarea);
      return tarea;
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
      lecturas.clear();
      bytesEnCache = 0;
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
    // El id puede traer el numero de pagina colgado (`uuid#2`); al zip hay que
    // pedirle el archivo del recurso, que es uno solo para todas sus paginas.
    const plano = uuid.split("#")[0].replace(/-/g, "");
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
  
  // Elemento con un recurso embebido colocado en el lienzo. Hay DOS tipos:
  //
  //   8 = el que usa Concepts para los PDF
  //   7 = el que usa para las fotos (jpg)
  //
  // Los dos traen las mismas piezas (uuid del recurso, tamaño y matriz), solo
  // que con campos intermedios distintos, asi que se extraen igual. Soportar
  // solo el 8 hacia que un dibujo de fotos no mostrara NINGUNA imagen: un
  // archivo de 87 MB con 29 fotos se abria con el lienzo vacio y las
  // anotaciones sueltas, porque el parser no encontraba nada que colocar.
  if ((tipo === 8 || tipo === 7) && Array.isArray(cuerpo)) {
    const interno = Array.isArray(cuerpo) && cuerpo.length > 1 && Array.isArray(cuerpo[1]) ? cuerpo[1] : [];

    let elementoId = "";
    const u = interno.find(x => typeof x === "string" && x.includes("-"));
    if (u) elementoId = u;

    let resourceId = "";
    const ru = cuerpo.find(x => typeof x === "string" && x.includes("-"));
    if (ru) resourceId = ru;

    // UN MISMO PDF puede estar colocado varias veces, una por pagina: en el
    // item, justo despues del uuid del recurso, viene el numero de pagina.
    // Sin leerlo, todas esas colocaciones comparten el mismo id y terminan
    // mostrando LA MISMA pagina (la primera), porque tanto el cache como el
    // rasterizador indexan por id de recurso. El plano dibujado no era el que
    // corresponde, asi que las anotaciones de la pagina 2 caian sobre el
    // dibujo de la pagina 1 — se veia como un problema de posicion cuando en
    // realidad la posicion estaba bien y el CONTENIDO estaba mal.
    //
    // El numero se cuelga del id (`uuid#2`) para que el cache, el pool de
    // workers y el rasterizado queden separados por pagina sin tener que
    // cambiar la forma de todo lo que ya indexa por resourceId. La pagina 0
    // se deja SIN sufijo a proposito: es la unica que existe en un PDF de una
    // sola pagina (la enorme mayoria del corpus), asi que esos archivos
    // conservan exactamente el id de antes y no cambian en nada.
    if (ru) {
      const iRu = cuerpo.indexOf(ru);
      const pag = iRu >= 0 ? cuerpo[iRu + 1] : null;
      if (typeof pag === "number" && Number.isInteger(pag) && pag > 0) {
        resourceId = `${ru}#${pag}`;
      }
    }

    let width = 0, height = 0;
    const tam = cuerpo.find(x => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
    if (tam) { width = tam[0]; height = tam[1]; }

    let transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const mat = interno.find(x => Array.isArray(x) && x.length === 16);
    if (mat) transform = mat;

    // Cuando la parte LINEAL de la matriz (escala + rotacion: indices
    // 0,1,4,5) es identidad — el recurso nunca se escalo ni se roto desde
    // que se pego — tratar (0,0) como su esquina superior izquierda deja su
    // caja en un cuadrante sin relacion con los trazos que la anotan.
    //
    // Un primer intento centraba SOLO cuando la matriz entera (incluida la
    // traslacion) era identidad, y eso rompio un archivo real: dos copias
    // del mismo recurso, una con traslacion (0,0) y otra con una traslacion
    // chica pero no cero, pasaron de estar prolijamente apiladas a
    // superponerse, porque solo la primera calificaba.
    //
    // La traslacion NO importa para esto: centrar resta la misma constante
    // (a*ancho/2 + c*alto/2, b*ancho/2 + d*alto/2) sin importar cuanto valga
    // la traslacion, asi que si dos colocaciones comparten la parte lineal
    // (aunque esten en lugares distintos) su posicion relativa queda
    // intacta. Medido contra el corpus real: arregla los 3 archivos que
    // tenian este patron (0-33% de trazos coincidiendo con su imagen ->
    // 100%, 100%, 38%) y no mueve ni un pixel a ninguno de los otros 13,
    // incluidos los dos de referencia con matrices reales (rotacion,
    // escala) donde ya se confirmo a ojo que el render es correcto.
    if (transform[0] === 1 && transform[1] === 0 && transform[4] === 0 && transform[5] === 1) {
      transform = transform.slice();
      transform[12] -= width / 2;
      transform[13] -= height / 2;
    }

    // Solo se acepta si de verdad parece una imagen colocada. Sin esta guarda,
    // aceptar el tipo 7 a ciegas podria fabricar elementos vacios a partir de
    // cualquier otra cosa que comparta la etiqueta.
    if (resourceId && width > 0 && height > 0) {
      layer.images.push({
        id: elementoId,
        resourceId,
        width,
        height,
        transform: girarTransform(transform)
      });
      return;
    }
    // Si no cumple, se sigue buscando trazos adentro como con cualquier item.
    buscarElementos(item, layer, globalBbox);

  } else if (tipo === 1 && item.length > 1 && Array.isArray(item[1]) && item[1].length > 0 && item[1][0] === 4) {
    // subcapa: a diferencia de cualquier otro tipo de item, esta rama no
    // recorria adentro — si una subcapa tiene trazos anidados (no se pudo
    // confirmar que nunca los tenga), quedaban descartados en silencio. Se
    // busca igual que en el resto de los casos: `buscarElementos` solo
    // extrae trazos (tipo 6 con su blob de puntos), asi que no hay riesgo de
    // fabricar una imagen de la nada si la subcapa viene vacia.
    buscarElementos(item, layer, globalBbox);
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
    // Media vuelta al documento entero, ver `girarPunto`.
    const [x, y] = girarPunto(view.getFloat32(i * 16, true), view.getFloat32(i * 16 + 4, true));
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
