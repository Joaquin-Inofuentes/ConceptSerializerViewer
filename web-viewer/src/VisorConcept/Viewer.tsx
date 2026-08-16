import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, useCallback, memo } from "react";
import type { Document, Stroke } from "./parser";
import {
  loadResourceImages,
  releaseResourceImages,
  drawnSizes,
  dibujarRecurso,
  liberarImagen,
  safeExportScale,
  exportFueRecortado,
  proveedorEnStreaming,
  statsCache,
  tiempos,
  soltarPdfsAbiertos,
  programarCierreWorkers,
  cancelarCierreWorkers,
  compararOrdenDibujo,
  dibujarTexto,
  ALTO_LINEA_TEXTO,
} from "../Gallery/renderCore";
import type { RecursoRasterizado, Region } from "../Gallery/renderCore";
import { getBudgets } from "../device";
import { coloresLienzo, temaGuardado } from "../theme";
import type { Tema } from "../theme";

export interface LayerConfig {
  visible: boolean;
  opacity: number;
}

interface ViewerProps {
  doc: Document | null;
  /** Id del archivo en Drive, para el cache persistente de rasterizados. */
  fileId?: string | null;
  layerConfigs: Record<string, LayerConfig>;
  isolatedLayer: string | null;
  /** Opacidad aplicada SOLO a las imagenes/fotos/PDFs, independiente de la
   * opacidad por capa: a veces el usuario quiere ver los trazos a pleno pero
   * las fotos de fondo mas tenues (o al reves), y la opacidad por capa no
   * sirve para eso porque una capa mezcla trazos e imagenes. */
  imageOpacity?: number;
  onImagesLoaded?: (images: Record<string, string>) => void;
  /** Avisa cuando terminaron de cargarse los recursos embebidos (fotos/PDFs),
   * que es lo unico lento al abrir un dibujo pesado. */
  onResourcesReady?: () => void;
  /** Avance de carga de recursos, para mostrarlo en la UI. */
  onResourceProgress?: (listos: number, total: number) => void;
  /** Avisa cuantos planos se estan trabajando y de que tipo: los que hay que
   * TRAER (no existen todavia en el dispositivo, hay que bajarlos) y los que
   * solo hay que AFINAR (ya se ven, a menos resolucion). No es lo mismo para
   * el usuario: traer puede tardar 30 s en 4G, afinar dura un instante. */
  onRefinando?: (activo: boolean, aAfinar: number, aTraer: number) => void;
  /**
   * Bytes que de verdad se van a bajar para el encuadre inicial.
   *
   * El documento declara el peso de TODOS los recursos colocados (250 MB en el
   * dibujo mas pesado), pero el visor solo baja los que se ven y son lo
   * bastante grandes: ~11 MB. Sin este dato la barra calculaba el porcentaje y
   * el tiempo restante contra los 250 MB y anunciaba "faltan 14 min" en una
   * apertura de 50 s.
   */
  onBytesPrevistos?: (bytes: number) => void;
  /** El usuario toco el lienzo: ya no hay que taparlo con la vista previa. */
  onPrimerGesto?: () => void;
  /** Cuantos planos se dieron por perdidos tras varios intentos. Con esto la
   * app puede decirlo en vez de afirmar que termino de cargar. */
  onFallidos?: (cuantos: number) => void;
}

export interface ViewerHandle {
  exportDrawing: (format: 'png' | 'jpg' | 'pdf', zoomAll?: boolean) => Promise<void>;
  /** Encuadra todo el dibujo en pantalla (el "zoom all" del boton). */
  zoomAll: () => void;
  /** Metricas en vivo, para benchmarks y diagnostico. */
  getStats: () => ViewerStats;
}

export interface ViewerStats {
  /** Cadencia real: 1000 / mediana del hueco entre frames presentados. */
  fps: number;
  /** Hueco del percentil 95, en ms. Es el numero que delata los tirones. */
  p95FrameMs: number;
  /** Frames con hueco mayor a 32 ms (dos cuadros perdidos a 60 Hz). */
  framesLargos: number;
  /** Lo que costo DIBUJAR el ultimo frame (distinto de la cadencia). */
  ultimoFrameMs: number;
  framesDibujados: number;
  recursosCargados: number;
  pixelesImagenes: number;
  dpr: number;
}

/** Headroom de resolucion sobre el zoom actual. Se arranca bajo para que el
 * dibujo aparezca rapido; si el usuario se acerca, `pedirRefinado` vuelve a
 * rasterizar mas grande. Rasterizar un PDF cuesta mas o menos lineal en
 * pixeles, asi que subir esto a 2 cuadruplica el tiempo de apertura. */
const RESOURCE_QUALITY = 1.25;

/**
 * Cuanto se carga POR AFUERA de la pantalla, en fracciones de viewport.
 *
 * Es el margen que hace que un paneo normal no descubra recuadros vacios: lo
 * que esta a medio viewport de distancia ya tiene bitmap cuando llegas. Subirlo
 * gasta mas red y RAM sin que se note; bajarlo a 0 hace que cada movimiento
 * muestre huecos hasta que rasteriza.
 */
const MARGEN_ANILLO = 0.6;

/** A que fraccion de la resolucion se trae el anillo. Media escala = un cuarto
 * de los pixeles, y al panear hacia alla se refina solo. */
const ESCALA_ANILLO = 0.5;

/** Cuanto puede quedarse corta la resolucion cargada antes de volver a
 * rasterizar. Con 1 se re-rasterizaria ante el menor movimiento de zoom. */
const TOLERANCIA_ESCALA = 1.1;

/** Espera tras el ultimo gesto antes de tocar la red. Suficiente para no
 * disparar en cada paso de la rueda, corto para que el hueco no se note. */
const DEBOUNCE_SINCRONIZAR = 220;

/**
 * Lado minimo en pixeles de pantalla para que valga la pena bajar un recurso.
 *
 * Medido sobre los tres dibujos mas pesados: los planos que se leen ocupan
 * 80-700 px de lado y suman 11 MB; las fotos adjuntas ocupan 1-5 px y suman
 * 252 MB. Con el umbral en 24 px se baja el 4% de los bytes para ver el 100%
 * de lo que se distingue, y cada foto llega cuando te acercas a ella.
 */
const LADO_MINIMO_PX = 24;

/** Un grupo de trazos que comparten estado de dibujo, unidos en un solo
 * Path2D para poder pintarlos con una sola llamada. */
interface FusionTrazos {
  path: Path2D;
  color: string;
  globalAlpha: number;
  width: number;
  layerId: string;
  layerIndex: number;
}

interface CachedStroke {
  kind: "stroke";
  pathFull: Path2D;
  minX: number; minY: number; maxX: number; maxY: number;
  color: string;
  globalAlpha: number;
  width: number;
  layerId: string;
  layerIndex: number;
}

interface CachedImage {
  kind: "image";
  resourceId: string;
  transform: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  width: number;
  height: number;
  layerId: string;
  layerIndex: number;
  isPhoto?: boolean;
}

interface CachedText {
  kind: "text";
  lineas: string[];
  transform: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  color: string;
  globalAlpha: number;
  layerId: string;
  layerIndex: number;
}

type CachedItem = CachedStroke | CachedImage | CachedText;

/**
 * Arma el Path2D de un trazo salteando puntos que estan a menos de
 * `tolerancia` unidades del ultimo punto conservado. Los trazos de Concepts
 * vienen sobremuestreados (puntos separados por decimas de unidad), asi que
 * con una tolerancia chica se recorta mucho la cantidad de segmentos sin
 * ningun cambio visible — y el costo de dibujar por frame baja igual.
 */
function buildPath(points: Stroke["points"], tolerancia: number): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  let lastX = points[0].x;
  let lastY = points[0].y;
  const tol2 = tolerancia * tolerancia;
  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i].x - lastX;
    const dy = points[i].y - lastY;
    if (dx * dx + dy * dy < tol2) continue;
    path.lineTo(points[i].x, points[i].y);
    lastX = points[i].x;
    lastY = points[i].y;
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    path.lineTo(last.x, last.y);
  }
  return path;
}

const ViewerBase = forwardRef<ViewerHandle, ViewerProps>(({ doc, fileId, layerConfigs, isolatedLayer, imageOpacity, onImagesLoaded, onResourcesReady, onResourceProgress, onRefinando, onBytesPrevistos, onPrimerGesto, onFallidos }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const budgets = useMemo(() => getBudgets(), []);

  // El lienzo dibuja en canvas, asi que no se entera del tema por CSS: hay
  // que releer los colores y repintar cuando cambia.
  const [tema, setTema] = useState<Tema>(() => temaGuardado());
  const coloresRef = useRef(coloresLienzo(tema));
  useEffect(() => {
    coloresRef.current = coloresLienzo(tema);
  }, [tema]);

  // Core state moved to refs for high performance
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const sizeRef = useRef({ width: 0, height: 0 });

  // Cache refs
  const imagesRef = useRef<Record<string, RecursoRasterizado>>({});
  /** Reloj logico de uso, para desalojar por LRU lo que hace mas tiempo que
   * no se ve. Un contador y no Date.now(): dos cargas en el mismo milisegundo
   * tienen que quedar ordenadas igual. */
  const usoRef = useRef<Record<string, number>>({});
  const relojUsoRef = useRef(0);
  const layerConfigsRef = useRef<Record<string, LayerConfig>>(layerConfigs);
  const isolatedLayerRef = useRef<string | null>(isolatedLayer);
  const imageOpacityRef = useRef<number>(imageOpacity ?? 1);
  const isDirtyRef = useRef(true);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // --- Estado del gesto (pan/zoom) ---------------------------------------
  // Durante un gesto NO se re-dibuja la escena: se estira el ultimo frame ya
  // rasterizado (un solo drawImage, ~1 ms fijo). Redibujar 7000 trazos +
  // 19 imagenes por frame costaba 40-50 ms en gama baja, o sea 20 fps y
  // gestos "pegajosos". Al soltar (o al frenar) se re-dibuja nitido.
  const gestoRef = useRef(false);
  /** Da acceso a `limpiarTransformGesto` desde efectos que corren antes de
   * que se defina (el del cambio de tema). */
  const limpiarTransformGestoRef = useRef<() => void>(() => {});
  /** pan/zoom desde el que arranco el gesto en curso. */
  const snapshotViewRef = useRef({ panX: 0, panY: 0, zoom: 1, dpr: 1 });
  const finGestoTimerRef = useRef<number | null>(null);

  // --- Metricas ----------------------------------------------------------
  const statsRef = useRef<ViewerStats>({
    fps: 0,
    p95FrameMs: 0,
    framesLargos: 0,
    ultimoFrameMs: 0,
    framesDibujados: 0,
    recursosCargados: 0,
    pixelesImagenes: 0,
    dpr: budgets.maxDpr,
  });
  // Buffer circular en vez de un array con push/shift: shift es O(n) y hace
  // que V8 degrade el array, y esto corre en cada frame.
  const frameTimesRef = useRef<Float32Array>(new Float32Array(120));
  const ringPosRef = useRef(0);
  const ultimoFrameRef = useRef(0);

  // El loop de render arranca solo cuando hay algo que dibujar y se apaga
  // cuando no. Antes corria a 60 Hz para siempre, despertando la CPU (y
  // gastando bateria) aunque la pantalla estuviera quieta.
  const rafRef = useRef<number | null>(null);
  const framesLimpiosRef = useRef(0);
  const renderRef = useRef<() => void>(() => {});

  const requestRedraw = useCallback(() => {
    isDirtyRef.current = true;
    framesLimpiosRef.current = 0;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => renderRef.current());
    }
  }, []);

  // Los callbacks llegan como arrow functions inline desde App, o sea con
  // identidad nueva en cada render. Guardarlos en refs evita que el efecto
  // que rasteriza los recursos se vuelva a disparar (y re-rasterice todo)
  // cada vez que el padre re-renderiza.
  const onImagesLoadedRef = useRef(onImagesLoaded);
  const onResourcesReadyRef = useRef(onResourcesReady);
  const onResourceProgressRef = useRef(onResourceProgress);
  const onRefinandoRef = useRef(onRefinando);
  const onBytesPrevistosRef = useRef(onBytesPrevistos);
  const onPrimerGestoRef = useRef(onPrimerGesto);
  const onFallidosRef = useRef(onFallidos);
  useEffect(() => {
    onImagesLoadedRef.current = onImagesLoaded;
    onResourcesReadyRef.current = onResourcesReady;
    onResourceProgressRef.current = onResourceProgress;
    onRefinandoRef.current = onRefinando;
    onBytesPrevistosRef.current = onBytesPrevistos;
    onPrimerGestoRef.current = onPrimerGesto;
    onFallidosRef.current = onFallidos;
  });

  /** Se avisa una sola vez, en el primer gesto de verdad. */
  const avisoGestoRef = useRef(false);
  /** Los bytes previstos se calculan para la PRIMERA tanda; despues el
   * usuario ya esta usando el dibujo y lo que venga es carga incremental. */
  const bytesAvisadosRef = useRef(false);

  // Sync props to refs
  useEffect(() => {
    layerConfigsRef.current = layerConfigs;
    isolatedLayerRef.current = isolatedLayer;
    imageOpacityRef.current = imageOpacity ?? 1;
    requestRedraw();
  }, [layerConfigs, isolatedLayer, imageOpacity, requestRedraw]);

  // El tema se cambia desde la galeria; el lienzo se entera por este evento.
  useEffect(() => {
    const alCambiar = (e: Event) => {
      const nuevo = (e as CustomEvent<Tema>).detail;
      // Los colores se actualizan ACA, no solo en el efecto de `tema`: el
      // requestRedraw de abajo agenda el frame de inmediato y el efecto corre
      // despues, asi que dejarlo solo al efecto repintaba con los colores
      // VIEJOS y el lienzo se quedaba con el tema anterior.
      coloresRef.current = coloresLienzo(nuevo);
      setTema(nuevo);
      // Un gesto en curso quedo con los colores viejos: se corta.
      limpiarTransformGestoRef.current();
      gestoRef.current = false;
      requestRedraw();
    };
    window.addEventListener("concepts:tema", alCambiar);
    return () => window.removeEventListener("concepts:tema", alCambiar);
  }, [requestRedraw]);

  // Pre-calcula Path2D (en dos niveles de detalle), bounding boxes para
  // frustum culling, y el orden de dibujado por capa. El orden se resuelve
  // ACA y no en cada frame: re-ordenar decenas de miles de items 60 veces
  // por segundo era el costo dominante del pan/zoom en dibujos grandes.
  const docCache = useMemo(() => {
    if (!doc) return null;
    const items: CachedItem[] = [];

    // Trazos FUSIONADOS por (capa, color, opacidad, grosor).
    //
    // Cuando el dibujo esta alejado, el descarte por frustum no descarta nada
    // —el encuadre por defecto se elige justamente para que entre todo— asi
    // que se hacian 2863 llamadas sueltas a `ctx.stroke()`. El cruce de JS a
    // Skia cuesta unos microsegundos por llamada, que en un ARM viejo son
    // decenas de ms por redibujo. Uniendo los trazos que comparten estado en
    // un solo Path2D, ese mismo dibujo son ~20 llamadas.
    //
    // A este zoom se usa la geometria simplificada, que es la que ya se usaba
    // de lejos: la diferencia no se ve y hay varias veces menos segmentos.
    const fusionados = new Map<string, FusionTrazos>();

    doc.layers.forEach(layer => {
      layer.strokes.forEach(stroke => {
        if (stroke.points.length === 0) return;
        // El bbox ya lo calculo el parser al leer los puntos; recalcularlo aca
        // era recorrer los 58.664 puntos del documento otra vez, al abrir.
        const { minX, minY, maxX, maxY } = stroke.bbox;
        const color = stroke.color.hex;
        const globalAlpha = stroke.color.a;
        const width = stroke.width || 1.5;

        const clave = `${layer.id}|${color}|${globalAlpha}|${width}`;
        let fusion = fusionados.get(clave);
        if (!fusion) {
          fusion = {
            path: new Path2D(),
            color,
            globalAlpha,
            width,
            layerId: layer.id,
            layerIndex: layer.index,
          };
          fusionados.set(clave, fusion);
        }
        fusion.path.addPath(buildPath(stroke.points, 2.5));

        items.push({
          kind: "stroke",
          pathFull: buildPath(stroke.points, 0.25),
          minX, minY, maxX, maxY,
          color,
          globalAlpha,
          width,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });

      layer.images.forEach(img => {
        // La caja se calcula APLICANDO la matriz, esquina por esquina.
        //
        // Antes se usaba [tx, ty, tx+ancho, ty+alto], o sea la posicion cruda
        // de la traslacion mas el tamano NATIVO del recurso, ignorando escala
        // y rotacion. En estos dibujos los planos vienen rotados -90 grados y
        // escalados a ~0,15, asi que la caja calculada quedaba diez veces mas
        // grande que la real y corrida de lugar. Como esta caja es la que usa
        // el frustum culling, habia encuadres en los que un plano que SI
        // estaba en pantalla se descartaba por caer fuera de su caja
        // fantasma: el plano desaparecia al panear o al hacer zoom y volvia
        // solo al mover un poco mas. Era el bug de "se pierden las imagenes".
        const m = img.transform;
        const w = img.width || 500;
        const h = img.height || 500;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
        } else {
          minX = 0; minY = 0; maxX = w; maxY = h;
        }
        items.push({
          kind: "image",
          resourceId: img.resourceId,
          transform: img.transform,
          minX, minY, maxX, maxY,
          width: img.width, height: img.height,
          layerId: layer.id,
          layerIndex: layer.index,
          isPhoto: img.isPhoto,
        });
      });

      // Texto de la herramienta de texto. La caja es aproximada (medirla de
      // verdad exige el contexto de canvas, que aca no esta); alcanza para el
      // encuadre y el descarte por frustum.
      layer.texts.forEach((t) => {
        const lineas = t.text.split(/\r?\n/);
        const m = t.transform;
        const alto = lineas.length * ALTO_LINEA_TEXTO;
        const ancho = Math.max(...lineas.map((l) => l.length)) * ALTO_LINEA_TEXTO * 0.55;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
        for (const [px, py] of [[0, 0], [ancho, 0], [0, -alto], [ancho, -alto]]) {
          const x = a * px + c * py + e;
          const y = b * px + d * py + f;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        items.push({
          kind: "text",
          lineas,
          transform: t.transform,
          minX, minY, maxX, maxY,
          color: t.color.hex.slice(0, 7),
          globalAlpha: t.color.a,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });
    });

    // Las notas (trazos) tienen que quedar SIEMPRE arriba de las fotos, sin
    // excepcion — asi lo pidio el usuario, con independencia de en que orden
    // se hayan pegado o en que capa esten. Antes se ordenaba solo por capa y,
    // dentro de una misma capa, la imagen se pegaba DESPUES del trazo en el
    // array de items, quedando dibujada encima y tapando la anotacion.
    // `compararOrdenDibujo` es la MISMA regla que usa `renderCore.ts` para
    // las miniaturas y el export de galeria — un solo lugar, para que el
    // lienzo en vivo y lo exportado no puedan divergir.
    items.sort((a, b) =>
      compararOrdenDibujo(
        { esImagen: a.kind === "image", layerIndex: a.layerIndex },
        { esImagen: b.kind === "image", layerIndex: b.layerIndex }
      )
    );
    // Los grupos (trazos fusionados) siempre se dibujan DESPUES de todas las
    // imagenes (ver el render loop), asi que alcanza con mantenerlos
    // ordenados por capa entre si.
    const grupos = [...fusionados.values()].sort((a, b) => a.layerIndex - b.layerIndex);
    return { items, grupos };
  }, [doc]);

  useEffect(() => {
    requestRedraw();
  }, [docCache, requestRedraw]);

  const visibleItem = (item: CachedItem) => {
    if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) return false;
    const config = layerConfigsRef.current[item.layerId];
    return !(config && !config.visible);
  };

  // El handle se crea UNA sola vez.
  //
  // Sin array de dependencias, React re-ejecutaba esta fabrica en cada render
  // del Viewer, y adentro hay una funcion `exportDrawing` de 150 lineas que
  // captura todo el scope. Durante la carga eso pasaba ~10 veces por segundo.
  // Lo que necesita del documento lo lee de refs, que siempre estan al dia.
  const docRef = useRef(doc);
  const docCacheRef = useRef(docCache);
  useEffect(() => {
    docRef.current = doc;
    docCacheRef.current = docCache;
  }, [doc, docCache]);

  useImperativeHandle(ref, () => ({
    getStats: () => ({ ...statsRef.current }),
    zoomAll: () => fitToBoundsRef.current(),
    exportDrawing: async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
      const doc = docRef.current;
      const docCache = docCacheRef.current;
      if (!doc || !docCache) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      if (zoomAll) {
        // Trazos E imagenes, igual que fitToBounds/computeFit: solo trazos
        // dejaba fotos afuera del export cuando estan mas extendidas que las
        // anotaciones.
        for (const item of docCache.items) {
          if (!visibleItem(item)) continue;
          if (item.minX < minX) minX = item.minX;
          if (item.minY < minY) minY = item.minY;
          if (item.maxX > maxX) maxX = item.maxX;
          if (item.maxY > maxY) maxY = item.maxY;
        }
      }

      if (zoomAll && minX === Infinity) {
        alert("El lienzo está vacío u oculto.");
        return;
      }

      let exportWidth, exportHeight;
      let translateX, translateY;
      let exportZoom = 1;

      if (zoomAll) {
        const padding = 20;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;
        exportWidth = maxX - minX;
        exportHeight = maxY - minY;
        translateX = -minX;
        translateY = -minY;
      } else {
        exportWidth = sizeRef.current.width;
        exportHeight = sizeRef.current.height;
        translateX = panRef.current.x;
        translateY = panRef.current.y;
        exportZoom = zoomRef.current;
      }

      // Los recursos que tiene cargados la vista estan rasterizados para
      // PANTALLA (poca resolucion a proposito, para que abrir sea rapido).
      // Para el export se vuelven a rasterizar a la resolucion del papel y
      // se descartan al terminar: asi el PDF sale nitido sin que abrir el
      // dibujo cueste un giga de RAM.
      const exportScale = safeExportScale(exportWidth, exportHeight);
      if (exportFueRecortado(exportWidth, exportHeight)) {
        console.warn("Export a menor resolucion por el limite de memoria del dispositivo");
      }
      const escalaRecursos = exportScale * exportZoom;
      const dibujado = drawnSizes(doc);
      const targets: Record<string, { width: number; height: number }> = {};
      Object.entries(dibujado).forEach(([id, size]) => {
        targets[id] = { width: size.width * escalaRecursos, height: size.height * escalaRecursos };
      });
      // Los recursos se traen DE A UNO y se sueltan enseguida.
      //
      // Antes se pedian los 94 juntos y quedaban vivos mientras ademas existia
      // el canvas de export (hasta 96 MB en gama baja) y el JPEG resultante:
      // el pico se iba muy por encima de lo que aguanta un telefono de 1 GB.
      // Filtrar los chicos no sirve — medido, a la escala del export las 96
      // colocaciones miden 24 px o mas, o sea que son contenido real del PDF.
      // Lo que hay que acotar es cuantos estan vivos a la vez.
      const proveedor = proveedorEnStreaming(doc, targets, {
        quality: 1,
        maxPixels: Math.min(40_000_000, budgets.maxExportPixels),
        maxTotalPixels: budgets.maxExportPixels,
        minSide: 256,
        timeoutMs: 60000,
        // El export pide otra resolucion que la pantalla: cachearla
        // desalojaria las versiones de pantalla, que son las que se reusan.
        sinCache: true,
      });

      try {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = Math.round(exportWidth * exportScale);
        exportCanvas.height = Math.round(exportHeight * exportScale);
        const ctx = exportCanvas.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        if (format === 'jpg' || format === 'pdf') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        }

        ctx.save();
        ctx.scale(exportScale, exportScale);
        ctx.translate(translateX, translateY);
        ctx.scale(exportZoom, exportZoom);

        for (const item of docCache.items) {
          if (!visibleItem(item)) continue;
          const config = layerConfigsRef.current[item.layerId];
          const layerOpacity = config ? config.opacity : 1.0;

          if (item.kind === "image") {
            const recurso = await proveedor.obtener(item.resourceId);
            if (!recurso) continue;
            ctx.save();
            ctx.globalAlpha = layerOpacity * imageOpacityRef.current;
            const m = item.transform;
            if (m && m.length === 16) {
              ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
            }
            dibujarRecurso(ctx, recurso, item.width, item.height, item.isPhoto);
            ctx.restore();
          } else if (item.kind === "text") {
            dibujarTexto(ctx, {
              type: "text",
              lineas: item.lineas,
              color: item.color,
              alpha: item.globalAlpha * layerOpacity,
              transform: item.transform,
              layerIndex: item.layerIndex,
            });
          } else {
            ctx.strokeStyle = item.color;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.lineWidth = item.width;
            ctx.globalAlpha = item.globalAlpha * layerOpacity;
            ctx.stroke(item.pathFull);
          }
        }
        ctx.restore();

        // PNG solo para el export PNG. El PDF tambien iba en PNG (sin perdida)
        // y despues se le pasaba a jsPDF declarado como 'JPEG': el resultado
        // era un PDF de una sola pagina de 170 MB. Con JPEG de calidad alta
        // pesa dos ordenes de magnitud menos y se ve igual.
        const dataUrl =
          format === 'png'
            ? exportCanvas.toDataURL('image/png')
            : exportCanvas.toDataURL('image/jpeg', 0.95);

        if (format === 'pdf') {
          const jsPDF = (await import('jspdf')).default;
          const pdf = new jsPDF({
            orientation: exportWidth > exportHeight ? 'landscape' : 'portrait',
            unit: 'px',
            format: [exportWidth, exportHeight]
          });
          pdf.addImage(dataUrl, 'JPEG', 0, 0, exportWidth, exportHeight);
          pdf.save('export.pdf');
        } else {
          const link = document.createElement('a');
          link.download = `export.${format}`;
          link.href = dataUrl;
          link.click();
        }
        // El canvas de export puede pesar decenas de MB; en gama baja hay que
        // soltarlo ya y no esperar al GC.
        exportCanvas.width = 0;
        exportCanvas.height = 0;
      } finally {
        proveedor.liberar();
      }
    }
    // `budgets` sale de un useMemo con dependencias vacias, asi que es estable
    // toda la vida del componente: el handle se sigue creando una sola vez.
  }), [budgets]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      sizeRef.current = { width: el.clientWidth, height: el.clientHeight };
      requestRedraw();
    };
    updateSize();
    // ResizeObserver y no solo el resize de window: el contenedor tambien
    // cambia de tamaño por layout (animacion de apertura, paneles), y ahi
    // window no dispara nada y el canvas quedaba con el tamaño viejo.
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener("resize", updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [requestRedraw]);

  /** Encuadre "zoom all" calculado sin tocar el estado, para poder saber de
   * antemano a que zoom se va a abrir el dibujo (y con eso decidir a que
   * resolucion rasterizar las fotos). */
  const computeFit = useCallback(() => {
    if (!docCache || !containerRef.current) return null;
    // clientWidth/clientHeight (no getBoundingClientRect): el contenedor
    // esta dentro del "hero" que anima con scale/translate al abrir el
    // dibujo, y getBoundingClientRect refleja ese tamaño visual transitorio
    // (chico, a mitad de la animacion) en vez del tamaño real de layout,
    // lo que encuadraba mal el zoom inicial.
    const rect = { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight };
    if (rect.width === 0 || rect.height === 0) return null;

    // Trazos E imagenes, siempre los dos: encuadrar solo por trazos dejaba
    // fotos afuera de la vista cuando estan mas lejos/mas extendidas que las
    // anotaciones (un dibujo con varias laminas pegadas pero anotaciones
    // concentradas en una sola mostraba "zoom all" recortando el resto).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of docCache.items) {
      if (item.minX < minX) minX = item.minX;
      if (item.minY < minY) minY = item.minY;
      if (item.maxX > maxX) maxX = item.maxX;
      if (item.maxY > maxY) maxY = item.maxY;
    }
    if (minX === Infinity) return null;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    if (!(contentWidth > 0) || !(contentHeight > 0)) return null;

    // El padding se pide en px pero se cede si el dibujo es muy ancho: en un
    // telefono de 360 px con un dibujo de 3279 unidades, 40 px por lado son el
    // 22% del ancho util.
    const pad = Math.min(40, rect.width * 0.06, rect.height * 0.06);
    let zoom = Math.min((rect.width - pad * 2) / contentWidth, (rect.height - pad * 2) / contentHeight);
    // El piso tiene que dejar entrar dibujos MUY anchos. Con 0.1 fijo, el
    // dibujo mas pesado (3279 x 2399 unidades) no entraba en 360 px de ancho y
    // "ver todo" dejaba los planos de los costados fuera de pantalla.
    zoom = Math.max(0.001, Math.min(zoom, 5));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      zoom,
      pan: { x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom },
    };
  }, [docCache]);

  const fitToBounds = useCallback(() => {
    const fit = computeFit();
    if (!fit) return;
    zoomRef.current = fit.zoom;
    panRef.current = fit.pan;
    // Al reencuadrar se sale de cualquier gesto en curso, y hay que sacarle
    // el transform al lienzo: si no, el compositor seguiria mostrando los
    // pixeles viejos corridos por un gesto que ya no existe.
    gestoRef.current = false;
    limpiarTransformGestoRef.current();
    requestRedraw();
    pedirRefinadoRef.current();
  }, [computeFit, requestRedraw]);

  // El handle imperativo se crea una sola vez; estos refs le dan acceso a la
  // version actual de las funciones sin recrearlo.
  const fitToBoundsRef = useRef(fitToBounds);
  useEffect(() => {
    fitToBoundsRef.current = fitToBounds;
  }, [fitToBounds]);

  useEffect(() => {
    fitToBounds();
  }, [docCache, fitToBounds]);

  /**
   * Ids de recursos que caen dentro de la vista, primero los que ocupan mas
   * pantalla. Es el orden en que conviene cargarlos: lo que el usuario esta
   * mirando aparece antes.
   *
   * `margen` agranda la ventana en fracciones de si misma (0.5 = medio
   * viewport de mas por lado). Sirve para adelantar lo que esta JUSTO afuera:
   * sin ese anillo, cada paneo corto descubre planos sin bitmap y el usuario
   * ve recuadros vacios hasta que terminan de rasterizarse — que es
   * exactamente el sintoma de "con el paneo se pierden las imagenes".
   */
  const recursosVisibles = useCallback((margen = 0): string[] => {
    if (!docCache) return [];
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const size = sizeRef.current;
    const mx = (size.width * margen) / zoom;
    const my = (size.height * margen) / zoom;
    const viewMinX = -pan.x / zoom - mx;
    const viewMinY = -pan.y / zoom - my;
    const viewMaxX = (size.width - pan.x) / zoom + mx;
    const viewMaxY = (size.height - pan.y) / zoom + my;

    const areas = new Map<string, number>();
    for (const item of docCache.items) {
      if (item.kind !== "image" || !visibleItem(item)) continue;
      const ix = Math.max(0, Math.min(item.maxX, viewMaxX) - Math.max(item.minX, viewMinX));
      const iy = Math.max(0, Math.min(item.maxY, viewMaxY) - Math.max(item.minY, viewMinY));
      const area = ix * iy;
      if (area <= 0) continue;
      // Cuanto ocupa en PANTALLA. Es el criterio que decide si vale la pena
      // bajarlo: en estos dibujos el 96% de los bytes son fotos de 3-5 MB
      // colocadas como "chinches" sobre el plano, que en el encuadre completo
      // miden 2 px de lado. Bajar 252 MB para pintar 73 puntitos de 2 px es lo
      // que hacia que abrir el dibujo mas pesado tardara mas de dos minutos.
      // Por debajo del umbral se dibuja el marcador de posicion, que a ese
      // tamano se ve igual, y la foto se trae recien cuando te acercas.
      const ladoPx = Math.max(item.maxX - item.minX, item.maxY - item.minY) * zoom;
      if (ladoPx < LADO_MINIMO_PX) continue;
      areas.set(item.resourceId, Math.max(areas.get(item.resourceId) || 0, area));
    }
    return [...areas.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [docCache]);

  /**
   * Que PEDAZO de cada recurso se ve en pantalla, en fracciones 0..1 de su
   * propio ancho/alto.
   *
   * Es lo que permite ver nitido un plano grande al acercarse. Un plano de
   * 1544x5717 a 10x de zoom necesitaria ~40 Mpx para verse entero y nitido —
   * imposible en un telefono, y por eso antes se veia borroso al hacer zoom.
   * Rasterizando solo la porcion visible alcanza con 1-2 Mpx para el mismo
   * nivel de detalle.
   *
   * El calculo se hace en el espacio PROPIO del recurso (se invierte su
   * matriz), asi funciona igual con los planos rotados -90 grados, que son
   * casi todos en esta carpeta.
   */
  const regionesVisibles = useCallback((): Record<string, Region> => {
    const out: Record<string, Region> = {};
    if (!docCache) return out;
    // Un mismo recurso puede estar COLOCADO varias veces en el dibujo (en el
    // mas pesado hay planos puestos 3 veces, a distinto tamaño y en distinto
    // lugar), y de cada recurso hay UN solo bitmap. Asi que el recorte tiene
    // que servir para TODAS sus colocaciones a la vez: se acumula la union de
    // lo que se ve de cada una, y si alguna necesita la pagina entera, no se
    // recorta nada.
    //
    // Antes se guardaba una region por recurso y ganaba la ultima colocacion
    // recorrida. El bitmap quedaba recortado segun UNA colocacion y se dibujaba
    // en las otras dos, donde ese recorte no corresponde: al encuadrar una de
    // ellas aparecia una tira blanca o directamente nada. Era el bug de "con
    // zoom o paneo se pierden las imagenes".
    const union = new Map<string, { x0: number; y0: number; x1: number; y1: number } | null>();
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const size = sizeRef.current;
    const vMinX = -pan.x / zoom;
    const vMinY = -pan.y / zoom;
    const vMaxX = (size.width - pan.x) / zoom;
    const vMaxY = (size.height - pan.y) / zoom;

    for (const item of docCache.items) {
      if (item.kind !== "image" || !visibleItem(item)) continue;
      if (!(item.width > 0) || !(item.height > 0)) continue;
      const m = item.transform;
      if (!m || m.length !== 16) continue;
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
      const det = a * d - b * c;
      if (!det) continue;
      // Inversa de la afin, para llevar las esquinas de la vista al espacio
      // del recurso.
      const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
      const ie = -(e * ia + f * ic), iff = -(e * ib + f * id);
      let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
      for (const [x, y] of [[vMinX, vMinY], [vMaxX, vMinY], [vMinX, vMaxY], [vMaxX, vMaxY]]) {
        const rx = x * ia + y * ic + ie;
        const ry = x * ib + y * id + iff;
        if (rx < rMinX) rMinX = rx;
        if (rx > rMaxX) rMaxX = rx;
        if (ry < rMinY) rMinY = ry;
        if (ry > rMaxY) rMaxY = ry;
      }
      // Un poco de margen para poder desplazarse sin re-rasterizar en cada
      // pixel de arrastre.
      const margen = 0.15;
      let x0 = rMinX / item.width - margen;
      let y0 = rMinY / item.height - margen;
      let x1 = rMaxX / item.width + margen;
      let y1 = rMaxY / item.height + margen;
      x0 = Math.max(0, Math.min(1, x0));
      y0 = Math.max(0, Math.min(1, y0));
      x1 = Math.max(0, Math.min(1, x1));
      y1 = Math.max(0, Math.min(1, y1));
      const w = x1 - x0;
      const h = y1 - y0;
      if (!(w > 0.001) || !(h > 0.001)) continue;
      // Si se ve casi entero no vale la pena recortar: complica sin ganar
      // resolucion, y ademas el resultado se puede cachear. `null` marca
      // "esta colocacion necesita la pagina completa" y pisa cualquier union.
      if (w > 0.9 && h > 0.9) {
        union.set(item.resourceId, null);
        continue;
      }
      if (union.has(item.resourceId) && union.get(item.resourceId) === null) continue;
      const previa = union.get(item.resourceId);
      union.set(
        item.resourceId,
        previa
          ? {
              x0: Math.min(previa.x0, x0),
              y0: Math.min(previa.y0, y0),
              x1: Math.max(previa.x1, x1),
              y1: Math.max(previa.y1, y1),
            }
          : { x0, y0, x1, y1 }
      );
    }

    for (const [id, caja] of union) {
      if (!caja) continue;
      const w = caja.x1 - caja.x0;
      const h = caja.y1 - caja.y0;
      if (!(w > 0.001) || !(h > 0.001)) continue;
      // Tras unir, el recorte puede haber crecido hasta cubrir casi todo; ahi
      // ya no aporta y conviene la pagina entera (que ademas se cachea).
      if (w > 0.9 && h > 0.9) continue;
      out[id] = { x: caja.x0, y: caja.y0, w, h };
    }
    return out;
  }, [docCache]);

  // --- Recursos embebidos (fotos / PDFs) ---------------------------------
  // Esta era la causa real del freeze al abrir un dibujo pesado: cada PDF
  // embebido se rasterizaba a la escala del EXPORT (600 DPI) aunque en
  // pantalla ocupara 400x800 px, dando canvases de 50-77 megapixeles (mas de
  // 1 GB de RAM en un solo dibujo) y ademas se les hacia toDataURL() para la
  // galeria de imagenes. Ahora se rasterizan al tamaño de PANTALLA con algo
  // de margen para zoom, y se re-rasterizan solo si el usuario se acerca de
  // verdad.

  // El tamaño dibujado de cada recurso solo depende del documento, y
  // calcularlo recorre todas las capas: se hace una vez y no en cada carga.
  const dibujado = useMemo(() => (doc ? drawnSizes(doc) : {}), [doc]);

  /** A que escala (px por unidad de documento) esta rasterizado cada recurso.
   * Antes habia UN solo valor para todo el documento, que solo funciona si se
   * cargan todos los recursos juntos a la misma escala. Con la carga por
   * viewport cada recurso va por su cuenta, asi que el dato es por recurso. */
  const escalaPorRecursoRef = useRef<Record<string, number>>({});

  /**
   * Cuantas veces fallo cada recurso.
   *
   * Un recurso que no se puede traer (red caida, timeout, PDF roto) volvia a
   * la lista de pendientes en CADA gesto, con 60 s de timeout cada vez: el
   * cartel "Trayendo 1 plano…" quedaba clavado para siempre y cada arrastre
   * relanzaba un pedido condenado. Tras unos intentos se deja de insistir y se
   * marca como fallido, que ademas permite dibujarlo distinto a "todavia no
   * llego".
   */
  const fallosRef = useRef<Record<string, number>>({});
  const MAX_INTENTOS = 2;

  const pixelesDe = (r: RecursoRasterizado | undefined) =>
    r ? ((r.img as any).width || 0) * ((r.img as any).height || 0) : 0;

  const recalcularPixeles = useCallback(() => {
    let px = 0;
    Object.values(imagesRef.current).forEach((r) => {
      px += pixelesDe(r);
    });
    statsRef.current.pixelesImagenes = px;
  }, []);

  /**
   * Suelta los bitmaps que hace rato que no se ven, si nos pasamos del
   * presupuesto de RAM.
   *
   * Hace falta desde que la carga es por viewport: recorrer un dibujo de 96
   * planos iria acumulando bitmaps hasta que Android mate la pestaña. Nunca se
   * desaloja algo que este en pantalla o en el anillo — soltar justo lo que se
   * esta mirando es la forma mas facil de fabricar el bug que se quiere evitar.
   */
  const desalojarLejanos = useCallback(
    (protegidos: string[]) => {
      const salvo = new Set(protegidos);
      let total = 0;
      Object.values(imagesRef.current).forEach((r) => {
        total += pixelesDe(r);
      });
      if (total <= budgets.maxImagePixels) return;

      const candidatos = Object.keys(imagesRef.current)
        .filter((id) => !salvo.has(id))
        .sort((a, b) => (usoRef.current[a] ?? 0) - (usoRef.current[b] ?? 0));

      const siguiente = { ...imagesRef.current };
      let liberados = 0;
      for (const id of candidatos) {
        if (total <= budgets.maxImagePixels) break;
        const r = siguiente[id];
        total -= pixelesDe(r);
        delete siguiente[id];
        delete escalaPorRecursoRef.current[id];
        liberarImagen(r.img);
        liberados++;
      }
      if (liberados > 0) {
        imagesRef.current = siguiente;
        statsRef.current.recursosCargados = Object.keys(siguiente).length;
        recalcularPixeles();
      }
    },
    [budgets, recalcularPixeles]
  );

  const cargarRecursos = useCallback(async (
    escala: number,
    signal?: AbortSignal,
    only?: string[],
    regiones?: Record<string, Region>
  ) => {
    if (!doc) return;
    if (Object.keys(dibujado).length === 0) return;
    const targets: Record<string, { width: number; height: number; region?: Region }> = {};
    Object.entries(dibujado).forEach(([id, size]) => {
      const region = regiones?.[id];
      // Con recorte, el destino en pixeles es el del PEDAZO, no el del
      // recurso entero: por eso se multiplica por el ancho/alto de la region.
      targets[id] = region
        ? { width: size.width * escala * region.w, height: size.height * escala * region.h, region }
        : { width: size.width * escala, height: size.height * escala };
    });

    const total = (only ?? doc.resourceIds).length;
    let listos = 0;

    // Pixeles que ya ocupan los recursos cargados: el presupuesto de RAM es
    // del DOCUMENTO entero, no de cada tanda, asi que la segunda tanda tiene
    // que arrancar donde quedo la primera.
    let yaUsados = 0;
    Object.entries(imagesRef.current).forEach(([id, r]) => {
      if (only && only.includes(id)) return; // se va a reemplazar
      yaUsados += ((r.img as any).width || 0) * ((r.img as any).height || 0);
    });

    const nuevas = await loadResourceImages(doc, {
      targets,
      quality: RESOURCE_QUALITY,
      maxPixels: budgets.maxPixelsPerResource,
      maxTotalPixels: budgets.maxImagePixels,
      pixelesYaUsados: yaUsados,
      minSide: 256,
      timeoutMs: 60000,
      concurrency: budgets.concurrency,
      signal,
      only,
      fileId: fileId || undefined,
      // Cada foto se pinta apenas esta lista. Antes no se veia NINGUNA hasta
      // que terminaba la ultima, que en un dibujo con 19 PDFs adjuntos son
      // mas de 20 segundos de lienzo a medio dibujar.
      onFallo: (id) => {
        fallosRef.current[id] = (fallosRef.current[id] ?? 0) + 1;
        const perdidos = Object.values(fallosRef.current).filter((n) => n >= MAX_INTENTOS).length;
        if (perdidos > 0) onFallidosRef.current?.(perdidos);
      },
      onEach: (id, recurso) => {
        // Un exito borra el historial de fallos: la red vuelve.
        delete fallosRef.current[id];
        if (signal?.aborted) return;
        const previa = imagesRef.current[id];
        // Se MUTA el record en vez de copiarlo: es un ref, no estado de React,
        // y copiarlo por cada recurso es O(n^2) de allocaciones a lo largo de
        // la carga.
        imagesRef.current[id] = recurso;
        if (previa && previa.img !== recurso.img) liberarImagen(previa.img);

        // Se anota la escala que se CONSIGUIO, no la que se pidio.
        //
        // No son lo mismo: si el presupuesto de pixeles estaba casi agotado,
        // el rasterizador entrega el minimo legible; y el cache puede devolver
        // una version mas chica que la pedida. Anotando la pedida, `necesita()`
        // daba false para siempre y ese plano no se volvia a pedir NUNCA,
        // quedando borroso el resto de la sesion aunque despues se liberara
        // presupuesto al alejarse.
        const anchoDoc = dibujado[id]?.width ?? 0;
        const anchoReal = (recurso.img as any).width ?? 0;
        const fraccion = recurso.region?.w ?? 1;
        escalaPorRecursoRef.current[id] =
          anchoDoc > 0 && anchoReal > 0 ? anchoReal / (anchoDoc * fraccion) : escala * RESOURCE_QUALITY;
        usoRef.current[id] = ++relojUsoRef.current;
        listos++;
        statsRef.current.recursosCargados = Object.keys(imagesRef.current).length;
        onResourceProgressRef.current?.(listos, total);
        requestRedraw();
      },
    });

    if (signal?.aborted) {
      // Solo se liberan los que NO quedaron publicados en imagesRef: `onEach`
      // ya fue poniendo los listos ahi y el render los esta usando. Liberar
      // todo en bloque cerraba ImageBitmaps en uso, y dibujar un bitmap
      // cerrado tira excepcion (el lienzo quedaba en negro al abortar un
      // refinado por zoom).
      const enUso = imagesRef.current;
      const sobrantes: Record<string, RecursoRasterizado> = {};
      Object.entries(nuevas).forEach(([id, recurso]) => {
        if (enUso[id]?.img !== recurso.img) sobrantes[id] = recurso;
      });
      releaseResourceImages(sobrantes);
      return;
    }
    recalcularPixeles();
    requestRedraw();
    return nuevas;
  }, [doc, fileId, budgets, dibujado, requestRedraw, recalcularPixeles]);

  const cargaInicialRef = useRef<AbortController | null>(null);

  /** Previews chicas para el menu de imagenes. Se generan PEREZOSAMENTE (al
   * abrir el menu), no al terminar de cargar: es un loop de toDataURL en el
   * hilo principal que en gama baja cuesta cientos de ms y no hace falta si
   * el usuario nunca abre ese menu. */
  // Se regenera si cambio el conjunto de recursos cargados. Antes era un
  // pestillo permanente: las fotos que llegaban despues de la primera apertura
  // del menu no aparecian nunca, o sea que se pagaba la RAM de las previews
  // sin dar la funcionalidad.
  const previewsDeRef = useRef<string>("");
  const pedirPreviews = useCallback(async () => {
    if (!onImagesLoadedRef.current) return;
    const firma = Object.keys(imagesRef.current).sort().join(",");
    if (previewsDeRef.current === firma) return;
    previewsDeRef.current = firma;
    const urls: Record<string, string> = {};
    for (const [id, recurso] of Object.entries(imagesRef.current)) {
      const fuente = recurso.img;
      const w = (fuente as any).width || 384;
      const h = (fuente as any).height || 384;
      const k = Math.min(384 / Math.max(w, h), 1);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      const cctx = c.getContext("2d");
      if (!cctx) continue;
      cctx.imageSmoothingQuality = budgets.smoothing;
      cctx.drawImage(fuente, 0, 0, c.width, c.height);
      urls[id] = c.toDataURL("image/jpeg", 0.85);
      c.width = 0;
      c.height = 0;
      // Cede el hilo entre imagenes para no bloquear los gestos.
      await new Promise((r) => setTimeout(r, 0));
    }
    onImagesLoadedRef.current?.(urls);
  }, [budgets]);

  // Al desmontar (cerrar el dibujo) se liberan los bitmaps Y se cierra el
  // documento (que suelta el archivo/las conexiones). Sin esto, abrir y
  // cerrar varios dibujos seguidos va acumulando RAM hasta que el navegador
  // empieza a andar mal.
  useEffect(() => {
    return () => {
      cargaInicialRef.current?.abort();
      releaseResourceImages(imagesRef.current);
      imagesRef.current = {};
      escalaPorRecursoRef.current = {};
      usoRef.current = {};
      fallosRef.current = {};
      // Los workers guardan los ultimos PDFs parseados para abaratar el
      // refinado por zoom. Al cerrar el dibujo ya no sirven, y si no se
      // sueltan se suman a la RAM del siguiente.
      soltarPdfsAbiertos();
      // Y los workers mismos se cierran si el usuario no vuelve a entrar en un
      // rato: cada uno retiene pdf.js entero.
      programarCierreWorkers();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  /**
   * Mantiene cargado lo que se ve, y SOLO lo que se ve.
   *
   * Antes el visor cargaba los recursos del documento entero: primero los
   * visibles y despues "el resto". Con los dibujos reales eso es inviable —
   * el mas pesado tiene 96 imagenes colocadas que suman 262 MB, o sea que
   * abrirlo significaba bajar el archivo completo (medido: 387 MB de red por
   * culpa del cache de bloques, 136 s hasta terminar) y repartir el
   * presupuesto de pixeles entre 94 recursos, dejando a cada plano con 128 kpx
   * ilegibles. Cargando por viewport se bajan ~10 MB y esos mismos pixeles se
   * gastan en los 4-6 planos que estas mirando.
   *
   * Resuelve tres cosas a la vez, y por eso es una sola funcion:
   *   - lo que ENTRO en pantalla y no tiene bitmap (paneo)
   *   - lo que necesita MAS resolucion (acercarse)
   *   - lo que tiene un recorte que ya no cubre lo que se ve (alejarse)
   */
  const sincronizarTimerRef = useRef<number | null>(null);
  const sincronizarAbortRef = useRef<AbortController | null>(null);
  // Se declara antes de definirla porque fitToBounds (que esta mas arriba)
  // necesita dispararla tras reencuadrar.
  const pedirRefinadoRef = useRef<() => void>(() => {});

  const sincronizarRecursos = useCallback(
    async (signal?: AbortSignal) => {
      if (!doc) return;
      const necesaria = zoomRef.current * budgets.maxDpr;
      const visibles = recursosVisibles();
      // Anillo alrededor de lo visible: se adelanta lo que esta a un paneo
      // corto de distancia para que no aparezcan recuadros vacios al mover.
      const cercanos = recursosVisibles(MARGEN_ANILLO);
      if (cercanos.length === 0) return;
      const regiones = regionesVisibles();

      // Un recorte cargado cubre lo pedido? Importa sobre todo al ALEJARSE:
      // un bitmap recortado dibuja solo su pedazo, asi que sin este chequeo
      // el resto del plano quedaria en blanco al volver a la vista completa.
      const cubre = (cargada: Region | null, pedida: Region | undefined) => {
        if (!cargada) return true; // el completo cubre cualquier recorte
        if (!pedida) return false; // ahora se ve todo y solo tenemos un pedazo
        const t = 0.02;
        return (
          cargada.x <= pedida.x + t &&
          cargada.y <= pedida.y + t &&
          cargada.x + cargada.w >= pedida.x + pedida.w - t &&
          cargada.y + cargada.h >= pedida.y + pedida.h - t
        );
      };

      const necesita = (id: string) => {
        const cargada = imagesRef.current[id];
        if (!cargada) return true;
        if (!cubre(cargada.region ?? null, regiones[id])) return true;
        return necesaria > (escalaPorRecursoRef.current[id] ?? 0) * TOLERANCIA_ESCALA;
      };

      // Los que ni siquiera tienen bitmap van primero: un recuadro vacio
      // molesta mucho mas que un plano con menos resolucion de la ideal.
      const sinBitmap = cercanos.filter(
        (id) => !imagesRef.current[id] && (fallosRef.current[id] ?? 0) < MAX_INTENTOS
      );
      // Mismo tope que sinBitmap: sin este chequeo, un recurso que ya tiene
      // bitmap pero cuyo refinado a mas resolucion sigue fallando (timeout
      // persistente, region invalida) se volvia a pedir en CADA sync
      // (~cada 220ms tras un gesto) para siempre, aunque ya estuviera
      // contado como "fallido" en otros lados de la UI.
      const aRefinar = visibles.filter(
        (id) => imagesRef.current[id] && necesita(id) && (fallosRef.current[id] ?? 0) < MAX_INTENTOS
      );
      // El anillo se trae a la resolucion de pantalla, sin recorte: todavia no
      // se sabe que pedazo va a mirar el usuario y el recorte solo tiene
      // sentido para lo que ya esta en cuadro.
      const pendientes = [...sinBitmap, ...aRefinar];

      // Marcar como recien usados y desalojar SIEMPRE, incluso sin nada nuevo
      // que traer: si no, quedarse paneando dentro de una zona ya cacheada
      // nunca libera lo que quedo lejos de un recorrido anterior, y el
      // presupuesto de RAM del dispositivo deja de cumplirse en silencio.
      for (const id of cercanos) usoRef.current[id] = ++relojUsoRef.current;
      desalojarLejanos(cercanos);
      if (pendientes.length === 0) return;

      // Cuantos bytes va a costar ESTA tanda de verdad. Es lo unico con lo que
      // se puede calcular un porcentaje y un tiempo restante honestos.
      if (!bytesAvisadosRef.current && sinBitmap.length > 0) {
        bytesAvisadosRef.current = true;
        const bytes = sinBitmap.reduce((n, id) => n + (doc.resourceSizes[id] || 0), 0);
        onBytesPrevistosRef.current?.(bytes);
      }

      onRefinandoRef.current?.(true, aRefinar.length, sinBitmap.length);
      const soloVisibles = sinBitmap.filter((id) => visibles.includes(id));
      const soloAnillo = sinBitmap.filter((id) => !visibles.includes(id));
      try {
        // El orden importa mas de lo que parece, y es todo sobre lo que el
        // usuario esta MIRANDO:
        //
        //   1. lo que esta en pantalla y no tiene nada          (hueco gris)
        //   2. lo que esta en pantalla y se ve borroso          (afinar)
        //   3. lo que esta afuera, para el proximo paneo        (anillo)
        //
        // Antes el anillo iba segundo, asi que al acercarte a un plano el
        // plano que tenias delante esperaba a que se rasterizaran otros que
        // estaban FUERA de cuadro. Con 2 workers y ~4,7 s por plano eso son
        // varios segundos mirando algo borroso mientras la CPU trabaja para
        // pixeles que no se ven.
        if (soloVisibles.length > 0) {
          await cargarRecursos(necesaria, signal, soloVisibles, regiones);
        }
        if (aRefinar.length > 0 && !signal?.aborted) {
          await cargarRecursos(necesaria, signal, aRefinar, regiones);
        }
        if (soloAnillo.length > 0 && !signal?.aborted) {
          // El anillo va a MEDIA escala: es un cuarto de los pixeles. Todavia
          // no se sabe que pedazo va a mirar el usuario, y gastar resolucion
          // plena ahi le come presupuesto a los planos que si se ven. Cuando
          // el usuario panea hacia alla, `necesita()` lo ve corto de
          // resolucion y lo refina solo — que es el mecanismo que ya existe.
          await cargarRecursos(necesaria * ESCALA_ANILLO, signal, soloAnillo);
        }
      } finally {
        if (!signal?.aborted) onRefinandoRef.current?.(false, 0, 0);
      }
    },
    [doc, budgets, cargarRecursos, recursosVisibles, regionesVisibles, desalojarLejanos]
  );

  /** Version con debounce, que es la que llaman los gestos: no tiene sentido
   * re-rasterizar en cada paso de la rueda del mouse. */
  const pedirRefinado = useCallback(() => {
    if (!doc) return;
    if (sincronizarTimerRef.current) window.clearTimeout(sincronizarTimerRef.current);
    sincronizarTimerRef.current = window.setTimeout(() => {
      sincronizarAbortRef.current?.abort();
      const abort = new AbortController();
      sincronizarAbortRef.current = abort;
      void sincronizarRecursos(abort.signal);
    }, DEBOUNCE_SINCRONIZAR);
  }, [doc, sincronizarRecursos]);

  useEffect(() => {
    pedirRefinadoRef.current = pedirRefinado;
  }, [pedirRefinado]);

  // Carga inicial: encuadrar, traer lo que entra en pantalla y avisar. Ya no
  // se carga "el resto" — lo que quede fuera de cuadro llega cuando el usuario
  // se mueva hacia ahi.
  useEffect(() => {
    if (!doc) return;
    // Si habia un cierre de workers programado (el usuario cerro otro dibujo
    // hace poco), se cancela: los vamos a necesitar ya.
    cancelarCierreWorkers();
    let cancelado = false;
    const abort = new AbortController();
    cargaInicialRef.current = abort;

    (async () => {
      // Se espera un frame para que el contenedor ya tenga tamaño y el
      // encuadre inicial sea el real (si no, se rasteriza para un zoom que
      // no es el que va a ver el usuario).
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (cancelado || abort.signal.aborted) return;
      await sincronizarRecursos(abort.signal);
      if (cancelado || abort.signal.aborted) return;
      onResourcesReadyRef.current?.();
    })();

    return () => {
      cancelado = true;
      abort.abort();
    };
  }, [doc, sincronizarRecursos]);

  useEffect(() => {
    return () => {
      if (sincronizarTimerRef.current) window.clearTimeout(sincronizarTimerRef.current);
      sincronizarAbortRef.current?.abort();
      if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    };
  }, []);

  // --- Gestos: el compositor mueve los pixeles, no nosotros --------------
  //
  // Durante un pan/zoom NO se toca el canvas: se deja el ultimo frame como
  // esta y se lo desplaza/escala con un `transform` de CSS. El compositor del
  // navegador ya sabe hacer eso en la GPU, gratis para el hilo principal.
  //
  // Antes esto se hacia copiando el canvas a un snapshot y re-bliteandolo con
  // drawImage en cada frame. Medido en el perfil: 2376 ms de `drawImage` en
  // 11 s de gestos, o sea ~3,6 ms por frame — el 21% del tiempo, todo para
  // reproducir a mano algo que el compositor hace solo. Ademas obligaba a
  // reasignar el buffer del canvas dos veces por gesto (por el cambio de DPR)
  // y a leer el canvas vivo al empezar cada gesto.
  //
  // El resultado en pantalla es el mismo: los pixeles se estiran igual. Lo
  // que cambia es quien los estira.
  const aplicarTransformGesto = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = snapshotViewRef.current;
    const k = zoomRef.current / s.zoom;
    const dx = panRef.current.x - s.panX * k;
    const dy = panRef.current.y - s.panY * k;
    canvas.style.transformOrigin = "0 0";
    canvas.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
  }, []);

  const limpiarTransformGesto = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas && canvas.style.transform) canvas.style.transform = "";
  }, []);
  limpiarTransformGestoRef.current = limpiarTransformGesto;

  const iniciarGesto = useCallback(() => {
    if (gestoRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    // Solo se anota desde que encuadre parte el gesto. Cero pixeles copiados.
    snapshotViewRef.current = {
      panX: panRef.current.x,
      panY: panRef.current.y,
      zoom: zoomRef.current,
      dpr: statsRef.current.dpr,
    };
    gestoRef.current = true;
  }, []);

  const terminarGesto = useCallback(() => {
    if (!gestoRef.current) return;
    gestoRef.current = false;
    limpiarTransformGesto();
    requestRedraw();
    pedirRefinado();
  }, [limpiarTransformGesto, requestRedraw, pedirRefinado]);

  /** Durante un gesto se llama a esto en vez de a requestRedraw: el unico
   * trabajo por movimiento es escribir una propiedad CSS. */
  const marcarGesto = useCallback(() => {
    iniciarGesto();
    aplicarTransformGesto();
    // El primer movimiento real destapa el lienzo: la vista previa deja de
    // tener sentido en cuanto el usuario empieza a usar el dibujo.
    if (!avisoGestoRef.current) {
      avisoGestoRef.current = true;
      onPrimerGestoRef.current?.();
    }
    // Si el usuario frena (sin soltar), se re-dibuja nitido. 250 ms y no 120:
    // con 120 un arrastre lento con micro-pausas dispara redibujos completos
    // varias veces por gesto.
    if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    finGestoTimerRef.current = window.setTimeout(() => terminarGesto(), 250);
  }, [iniciarGesto, aplicarTransformGesto, terminarGesto]);

  // HIGH PERFORMANCE RENDER LOOP
  useEffect(() => {
    const render = () => {
      rafRef.current = null;
      const t0 = performance.now();
      let dibujo = false;

      // Durante un gesto no hay nada que dibujar: los pixeles ya estan y los
      // mueve el compositor. Redibujar seria trabajo que se descarta.
      if (isDirtyRef.current && !gestoRef.current && canvasRef.current && docCache) {
        const canvas = canvasRef.current;
        const ctx = contextoCanvas(canvas);
        const pan = panRef.current;
        const zoom = zoomRef.current;
        const size = sizeRef.current;

        if (ctx && size.width > 0 && size.height > 0) {
          // Un solo DPR. Antes se bajaba durante el gesto para ahorrar
          // pixeles, pero eso obligaba a reasignar el buffer del canvas al
          // entrar y al salir de CADA gesto (dos allocaciones de megabytes mas
          // dos invalidaciones de layout). Ahora el gesto no dibuja, asi que
          // no hay nada que ahorrar y si hay mucho que dejar de reasignar.
          const dpr = budgets.maxDpr;
          statsRef.current.dpr = dpr;

          // Reasignar canvas.width/height reserva un buffer nuevo y es caro;
          // solo se hace cuando el tamaño cambio de verdad.
          const bw = Math.round(size.width * dpr);
          const bh = Math.round(size.height * dpr);
          if (canvasSizeRef.current.width !== bw || canvasSizeRef.current.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
            canvas.style.width = `${size.width}px`;
            canvas.style.height = `${size.height}px`;
            canvasSizeRef.current = { width: bw, height: bh };
          }

          {
          const colores = coloresRef.current;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Se PINTA el fondo en vez de limpiarlo: con tema oscuro un canvas
          // transparente dejaba ver el blanco del contenedor.
          ctx.fillStyle = colores.fondo;
          ctx.fillRect(0, 0, size.width, size.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = budgets.smoothing;

          // Grid: se dibuja en coordenadas de PANTALLA (una sola pasada de
          // lineas rectas), no en coordenadas de documento — asi la cantidad
          // de lineas depende del tamaño de la ventana y no del zoom.
          // La grilla se pinta como un PATRON: un solo fillRect en vez de
          // hasta ~290 segmentos de linea antialiaseada por redibujo. El
          // mosaico se genera una vez por (tamaño de celda, color) y se reusa;
          // solo cambia al cambiar el zoom o el tema, no en cada frame.
          const gridSize = 50 * zoom;
          if (gridSize > 4) {
            const patron = patronGrilla(ctx, gridSize, colores.grilla);
            if (patron) {
              ctx.save();
              ctx.fillStyle = patron;
              // El patron se ancla al pan para que la grilla acompañe al
              // dibujo en vez de quedarse fija a la pantalla.
              ctx.translate(pan.x % gridSize, pan.y % gridSize);
              ctx.fillRect(-gridSize, -gridSize, size.width + gridSize * 2, size.height + gridSize * 2);
              ctx.restore();
            }
          }

          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(zoom, zoom);

          // Frustum: solo se dibuja lo que cae dentro de la ventana.
          const viewMinX = -pan.x / zoom;
          const viewMinY = -pan.y / zoom;
          const viewMaxX = (size.width - pan.x) / zoom;
          const viewMaxY = (size.height - pan.y) / zoom;

          // Con el dibujo alejado se usan los trazos FUSIONADOS: a ese zoom el
          // frustum no descarta nada (el encuadre entra entero), asi que ir
          // trazo por trazo son 2863 llamadas para dibujar lo mismo que sale
          // en ~20. De cerca no conviene: ahi el descarte SI trabaja y dibujar
          // el grupo entero pintaria un monton de tinta fuera de pantalla.
          const usarFusionado = zoom < 0.75;

          let color = "";
          let alpha = -1;
          let ancho = -1;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";

          // Las notas (trazos) van SIEMPRE arriba de las fotos, sin excepcion:
          // por eso las imagenes se dibujan primero y los trazos fusionados
          // (el camino de lejos) se dejan para el final, despues del loop de
          // items. `docCache.items` ya viene ordenado imagenes-antes-que-
          // trazos (ver el sort en el useMemo de mas arriba), asi que alcanza
          // con mover el bloque de grupos fusionados de antes del loop a
          // despues.
          for (const item of docCache.items) {
            // Los trazos ya se dibujaron todos juntos mas abajo.
            if (usarFusionado && item.kind === "stroke") continue;
            if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) continue;
            const config = layerConfigsRef.current[item.layerId];
            if (config && !config.visible) continue;
            if (item.maxX < viewMinX || item.minX > viewMaxX || item.maxY < viewMinY || item.minY > viewMaxY) {
              continue;
            }

            const layerOpacity = config ? config.opacity : 1.0;

            if (item.kind === "image") {
              const recurso = imagesRef.current[item.resourceId];
              // Un recurso liberado (canvas con width/height en 0) hace que
              // drawImage TIRE, y una excepcion aca aborta el frame entero.
              const usable = recurso && anchoUtil(recurso.img);
              ctx.save();
              ctx.globalAlpha = layerOpacity * imageOpacityRef.current;
              const m = item.transform;
              if (m && m.length === 16) {
                ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
              }
              if (usable) {
                dibujarRecurso(ctx, recurso!, item.width, item.height, item.isPhoto);
              } else {
                // Marcador de posicion: un recuadro solido en el lugar exacto
                // que ocupa el recurso. Sin esto, una imagen que todavia no
                // cargo (o que fallo, o que se oculto) simplemente no se
                // dibuja y el lienzo parece vacio o incompleto sin explicar
                // por que — que es justo lo que pasaba con los dibujos cuyos
                // trazos son anotaciones finas sobre los planos.
                // La escala en pantalla del recurso sale de datos que ya
                // tenemos (el zoom y la escala de su matriz), sin preguntarle
                // al contexto.
                const m2 = item.transform;
                const escalaItem =
                  m2 && m2.length === 16 ? Math.hypot(m2[0], m2[1]) * zoom : zoom;
                const fallo = (fallosRef.current[item.resourceId] ?? 0) >= MAX_INTENTOS;
                dibujarHueco(ctx, item.width || 0, item.height || 0, colores, escalaItem, fallo);
              }
              ctx.restore();
              // El save/restore invalida el estado de trazo cacheado.
              color = ""; alpha = -1; ancho = -1;
            } else if (item.kind === "text") {
              dibujarTexto(ctx, {
                type: "text",
                lineas: item.lineas,
                color: item.color,
                alpha: item.globalAlpha * layerOpacity,
                transform: item.transform,
                layerIndex: item.layerIndex,
              });
              color = ""; alpha = -1; ancho = -1;
            } else {
              // Cambiar strokeStyle/lineWidth/globalAlpha tiene costo; se
              // saltea cuando el valor no cambio respecto del item anterior.
              const a = item.globalAlpha * layerOpacity;
              if (item.color !== color) { ctx.strokeStyle = item.color; color = item.color; }
              if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
              if (item.width !== ancho) { ctx.lineWidth = item.width; ancho = item.width; }
              ctx.stroke(item.pathFull);
            }
          }

          // Camino de lejos: los trazos fusionados se dibujan ACA, despues de
          // todas las imagenes, para que las notas queden arriba de las fotos
          // sin excepcion (antes se dibujaban primero y una foto pegada
          // encima de una capa tapaba las anotaciones de esa capa).
          if (usarFusionado) {
            for (const g of docCache.grupos) {
              if (isolatedLayerRef.current && isolatedLayerRef.current !== g.layerId) continue;
              const config = layerConfigsRef.current[g.layerId];
              if (config && !config.visible) continue;
              const a = g.globalAlpha * (config ? config.opacity : 1.0);
              if (g.color !== color) { ctx.strokeStyle = g.color; color = g.color; }
              if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
              if (g.width !== ancho) { ctx.lineWidth = g.width; ancho = g.width; }
              ctx.stroke(g.path);
            }
          }
          ctx.restore();
          isDirtyRef.current = false;
          dibujo = true;
          }
        }
      }

      // --- Cadencia REAL de presentacion -------------------------------
      // Se mide el hueco entre callbacks de requestAnimationFrame, no lo que
      // cuesta dibujar. Antes se calculaba `1000 / promedio(costoDeDibujar)`
      // topeado a 60, y ese numero no puede bajar aunque la pantalla se
      // congele: no ve los frames que el navegador descarta, ni el trabajo de
      // React, del GC o de IndexedDB que cae ENTRE frames. Un tiron de 200 ms
      // codificando un JPEG era literalmente invisible.
      const ahora = performance.now();
      const anterior = ultimoFrameRef.current;
      ultimoFrameRef.current = ahora;
      if (anterior > 0) {
        const delta = ahora - anterior;
        // Un delta enorme es el loop que se apago y volvio a arrancar, no un
        // tiron: contarlo ensuciaria la medida.
        if (delta < 1000) {
          const ring = frameTimesRef.current;
          ring[ringPosRef.current % ring.length] = delta;
          ringPosRef.current++;
          if (delta > 32) statsRef.current.framesLargos++;
        }
      }

      if (dibujo) {
        statsRef.current.ultimoFrameMs = ahora - t0;
        statsRef.current.framesDibujados++;
        framesLimpiosRef.current = 0;
      } else {
        framesLimpiosRef.current++;
      }

      // El loop se apaga tras unos frames sin nada que dibujar. Cualquier
      // interaccion lo vuelve a encender via requestRedraw.
      if (isDirtyRef.current || framesLimpiosRef.current < 3) {
        rafRef.current = requestAnimationFrame(render);
      } else {
        // Al apagarse se corta la serie de tiempos: si no, el hueco entre que
        // el loop se duerme y lo despierta el proximo gesto se contaria como
        // un frame larguisimo. Eso convertiria el ahorro de no dibujar —que es
        // el objetivo— en un tiron inventado de cientos de ms.
        ultimoFrameRef.current = 0;
      }
    };
    renderRef.current = render;
    requestRedraw();

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [docCache, budgets, requestRedraw]);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const [isRightDragging, setIsRightDragging] = useState(false);
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const dragStartZoomRef = useRef(1);
  const dragStartPanRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       dragStartZoomRef.current = zoomRef.current;
       dragStartPanRef.current = { ...panRef.current };
       iniciarGesto();
    } else if (e.button === 0) {
       setIsDragging(true);
       dragStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
       iniciarGesto();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightDragging) {
       const totalDx = e.clientX - rightDragStartPos.x;
       const totalDy = e.clientY - rightDragStartPos.y;

       const distance = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
       const sign = (totalDx - totalDy) >= 0 ? 1 : -1;
       const zoomDelta = sign * distance;
       const zoomFactor = Math.exp(zoomDelta * 0.015);
       let newZoom = dragStartZoomRef.current * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       const centerX = rightDragStartPos.x - rect.left;
       const centerY = rightDragStartPos.y - rect.top;

       const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
       const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

       zoomRef.current = newZoom;
       panRef.current = { x: newPanX, y: newPanY };
       marcarGesto();

    } else if (isDragging) {
      panRef.current = {
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      };
      marcarGesto();
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (e.button === 2) setIsRightDragging(false);
    if (e.button === 0) setIsDragging(false);
    terminarGesto();
  };

  const handleWheel = (e: React.WheelEvent) => {
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(zoomFactor, direction);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = e.clientX - rect.left;
    const centerY = e.clientY - rect.top;

    let newZoom = zoomRef.current * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - panRef.current.x) * (newZoom / zoomRef.current);
    const newPanY = centerY - (centerY - panRef.current.y) * (newZoom / zoomRef.current);

    zoomRef.current = newZoom;
    panRef.current = { x: newPanX, y: newPanY };
    marcarGesto();
  };

  // El wheel se registra a mano como listener no pasivo: React lo adjunta
  // como pasivo y preventDefault() dentro de onWheel no hace nada, asi que
  // la rueda tambien scrolleaba la pagina detras del visor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bloquear = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", bloquear, { passive: false });
    return () => el.removeEventListener("wheel", bloquear);
  }, []);

  const touchDistStartRef = useRef<number | null>(null);
  // Puro conteo interno del gesto de triple-tap, no se lee en ningun JSX: va
  // en refs como el resto del estado de gestos de este archivo, para no
  // pedir un re-render en cada toque (el mismo motivo por el que pan/zoom/
  // drag viven en refs y no en useState).
  const lastTapRef = useRef(0);
  const tapCountRef = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        const newCount = tapCountRef.current + 1;
        tapCountRef.current = newCount;
        if (newCount >= 3) {
           fitToBounds();
           tapCountRef.current = 0;
        }
      } else {
        tapCountRef.current = 1;
      }
      lastTapRef.current = now;

      setIsDragging(true);
      dragStartRef.current = { x: e.touches[0].clientX - panRef.current.x, y: e.touches[0].clientY - panRef.current.y };
      iniciarGesto();
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistStartRef.current = Math.sqrt(dx * dx + dy * dy);
      dragStartZoomRef.current = zoomRef.current;
      dragStartPanRef.current = { ...panRef.current };

      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setRightDragStartPos({ x: cx, y: cy });
      iniciarGesto();
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging) {
      panRef.current = {
        x: e.touches[0].clientX - dragStartRef.current.x,
        y: e.touches[0].clientY - dragStartRef.current.y,
      };
      marcarGesto();
    } else if (e.touches.length === 2 && touchDistStartRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);

      const zoomFactor = currentDist / touchDistStartRef.current;
      let newZoom = dragStartZoomRef.current * zoomFactor;
      newZoom = Math.max(0.01, Math.min(newZoom, 100));

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerX = rightDragStartPos.x - rect.left;
      const centerY = rightDragStartPos.y - rect.top;

      const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
      const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

      zoomRef.current = newZoom;
      panRef.current = { x: newPanX, y: newPanY };
      marcarGesto();
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    touchDistStartRef.current = null;
    terminarGesto();
  };

  // Expuesto para que App pueda pedir las previews al abrir el menu, y para
  // que los benchmarks puedan leer metricas del render sin instrumentar la UI.
  useEffect(() => {
    (window as any).__conceptsPedirPreviews = pedirPreviews;
    (window as any).__viewerStats = () => ({
      ...statsRef.current,
      // Se resume ACA y no en cada frame: ordenar 120 numeros 60 veces por
      // segundo seria justamente el tipo de trabajo que estamos sacando.
      ...resumirCadencia(frameTimesRef.current),
      // Cuantos trazos sueltos hay y en cuantos grupos quedaron: si los grupos
      // fueran casi tantos como los trazos, fusionar no serviria de nada.
      trazos: (docCache?.items ?? []).filter((i) => i.kind === "stroke").length,
      grupos: docCache?.grupos.length ?? 0,
      fallidos: Object.keys(fallosRef.current).filter((id) => (fallosRef.current[id] ?? 0) >= MAX_INTENTOS).length,
      recursosEnMemoria: Object.keys(imagesRef.current).length,
      ramImagenesMB: +((statsRef.current.pixelesImagenes * 4) / 1048576).toFixed(1),
      recortados: Object.values(imagesRef.current).filter((r) => r.region).length,
      cache: { ...statsCache },
      tiempos: { ...tiempos },
    });

    // Cuantas de las imagenes que CAEN EN PANTALLA tienen de verdad un bitmap
    // dibujable. Es la medida directa de "se pierden imagenes con el zoom o el
    // paneo": si visiblesConBitmap baja despues de un gesto, se perdieron.
    (window as any).__viewerCobertura = () => {
      if (!docCache) return { visibles: 0, visiblesConBitmap: 0 };
      const pan = panRef.current;
      const zoom = zoomRef.current;
      const size = sizeRef.current;
      const vMinX = -pan.x / zoom;
      const vMinY = -pan.y / zoom;
      const vMaxX = (size.width - pan.x) / zoom;
      const vMaxY = (size.height - pan.y) / zoom;
      const enPantalla = new Set<string>();
      const conBitmap = new Set<string>();
      // "Chinches": las que caen en pantalla pero son tan chicas que no se
      // bajan a proposito. Se cuentan aparte para que no ensucien la medida
      // de "se ven todas las que se tienen que ver".
      const chinches = new Set<string>();
      let colocadas = 0;
      for (const item of docCache.items) {
        if (item.kind !== "image") continue;
        colocadas++;
        if (!visibleItem(item)) continue;
        if (item.maxX < vMinX || item.minX > vMaxX || item.maxY < vMinY || item.minY > vMaxY) continue;
        const ladoPx = Math.max(item.maxX - item.minX, item.maxY - item.minY) * zoom;
        if (ladoPx < LADO_MINIMO_PX) {
          chinches.add(item.resourceId);
          continue;
        }
        enPantalla.add(item.resourceId);
        const recurso = imagesRef.current[item.resourceId];
        if (recurso && anchoUtil(recurso.img)) conBitmap.add(item.resourceId);
      }
      return {
        colocadas,
        visibles: enPantalla.size,
        visiblesConBitmap: conBitmap.size,
        chinches: chinches.size,
        faltantes: [...enPantalla].filter((id) => !conBitmap.has(id)).map((id) => id.slice(0, 8)),
      };
    };

    // Cajas de las imagenes colocadas, en coordenadas del documento. Permite
    // que el test recorra plano por plano en vez de panear al azar.
    (window as any).__viewerCajas = () =>
      (docCache?.items ?? [])
        .filter((it): it is CachedImage => it.kind === "image")
        .map((it) => ({
          resourceId: it.resourceId,
          x0: it.minX,
          y0: it.minY,
          x1: it.maxX,
          y1: it.maxY,
        }));

    // Leer y fijar el encuadre, para poder volver EXACTAMENTE a la misma vista
    // y comparar el lienzo contra si mismo tras un vendaval de gestos.
    (window as any).__viewerVista = () => ({
      zoom: zoomRef.current,
      panX: panRef.current.x,
      panY: panRef.current.y,
    });
    (window as any).__viewerFijarVista = (v: { zoom: number; panX: number; panY: number }) => {
      if (!v) return;
      zoomRef.current = v.zoom;
      panRef.current = { x: v.panX, y: v.panY };
      gestoRef.current = false;
      limpiarTransformGestoRef.current();
      requestRedraw();
      pedirRefinadoRef.current();
    };

    return () => {
      delete (window as any).__conceptsPedirPreviews;
      delete (window as any).__viewerStats;
      delete (window as any).__viewerCobertura;
      delete (window as any).__viewerCajas;
      delete (window as any).__viewerVista;
      delete (window as any).__viewerFijarVista;
    };
  }, [pedirPreviews, docCache, requestRedraw]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
        cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
        touchAction: "none"
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          touchAction: "none"
        }}
      />
      {/* Zoom Reference Indicator */}
      {isRightDragging && (
        <div style={{
          position: 'absolute',
          left: rightDragStartPos.x - (containerRef.current?.getBoundingClientRect().left || 0),
          top: rightDragStartPos.y - (containerRef.current?.getBoundingClientRect().top || 0),
          width: '16px',
          height: '16px',
          marginLeft: '-8px',
          marginTop: '-8px',
          border: '2px solid red',
          borderRadius: '50%',
          pointerEvents: 'none',
          boxShadow: '0 0 4px rgba(0,0,0,0.5)',
          zIndex: 100
        }}>
          <div style={{ width: '4px', height: '4px', background: 'red', borderRadius: '50%', margin: '4px' }} />
        </div>
      )}
    </div>
  );
});

/**
 * Recuadro que ocupa el lugar de un recurso que no esta dibujado (todavia
 * cargando, fallado, u oculto). Se dibuja en el espacio YA transformado del
 * recurso, asi que hereda su rotacion y escala y queda exactamente donde ira
 * la imagen. Lleva una diagonal tenue para que se lea como "hueco" y no como
 * un rectangulo del dibujo.
 */
function dibujarHueco(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  colores: { huecoBorde: string; huecoRelleno: string },
  escalaPantalla: number,
  fallo = false
) {
  if (!(w > 0) || !(h > 0)) return;
  const escala = Math.max(escalaPantalla, 0.0001);
  // Cuanto mide en PANTALLA. Decide como se dibuja: lo que a 3 px se lee como
  // suciedad, a 300 px se lee como un marco vacio.
  const ladoPx = Math.max(w, h) * escala;

  // Muy chico: un punto de tamaño CONSTANTE en pantalla, sin caja ni
  // diagonales. Antes se pintaba un rectangulo relleno con dos diagonales —la
  // iconografia universal de "imagen rota"— y en el encuadre completo de estos
  // dibujos eso son 73 motas oscuras salpicadas sobre planos blancos. El
  // arquitecto pensaba que el escaneo salio sucio, no que ahi hay una foto.
  if (ladoPx < 16) {
    const r = 3.5 / escala;
    ctx.fillStyle = colores.huecoBorde;
    ctx.globalAlpha *= 0.75;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // De tamaño util: relleno TRANSLUCIDO (tiñe el plano en vez de taparlo) y
  // un marco fino. Sin diagonales: no es un error, es una foto que todavia no
  // se trajo.
  ctx.globalAlpha *= 0.35;
  ctx.fillStyle = colores.huecoRelleno;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha /= 0.35;

  // El grosor se compensa por la escala para que el borde se vea igual de fino
  // sin importar el zoom. La escala llega calculada: pedirsela al contexto con
  // getTransform() aloca un DOMMatrix, y durante la carga TODAS las imagenes
  // son huecos, o sea decenas de DOMMatrix por frame.
  ctx.strokeStyle = colores.huecoBorde;
  ctx.lineWidth = 1 / escala;
  ctx.globalAlpha *= 0.7;
  ctx.strokeRect(0, 0, w, h);

  // Y un glifo simple de foto en el centro, para que se entienda que falta una
  // imagen. Solo cuando hay lugar de sobra.
  if (ladoPx >= 64) {
    const lado = Math.min(w, h) * 0.28;
    const cx = w / 2;
    const cy = h / 2;
    ctx.beginPath();
    if (fallo) {
      // Se dio por perdido: una cruz, que si significa "no se pudo".
      ctx.moveTo(cx - lado / 2, cy - lado / 2);
      ctx.lineTo(cx + lado / 2, cy + lado / 2);
      ctx.moveTo(cx + lado / 2, cy - lado / 2);
      ctx.lineTo(cx - lado / 2, cy + lado / 2);
    } else {
      ctx.rect(cx - lado / 2, cy - lado / 2, lado, lado);
      // La "montaña" del icono clasico de imagen.
      ctx.moveTo(cx - lado / 2, cy + lado / 4);
      ctx.lineTo(cx - lado / 8, cy - lado / 8);
      ctx.lineTo(cx + lado / 8, cy + lado / 8);
      ctx.lineTo(cx + lado / 3, cy - lado / 6);
      ctx.lineTo(cx + lado / 2, cy + lado / 4);
    }
    ctx.stroke();
  }
}

/**
 * Resume los huecos entre frames en algo comparable entre corridas.
 *
 * Devuelve la MEDIANA (no el promedio) porque un solo tiron de 300 ms
 * arrastra el promedio y hace parecer que todo va mal, cuando lo que hay que
 * ver son dos cosas separadas: la cadencia habitual (mediana) y cuanto se
 * rompe (p95 y cantidad de frames largos).
 */
function resumirCadencia(ring: Float32Array): { fps: number; p95FrameMs: number } {
  const usados: number[] = [];
  for (const v of ring) if (v > 0) usados.push(v);
  if (usados.length < 4) return { fps: 0, p95FrameMs: 0 };
  usados.sort((a, b) => a - b);
  const mediana = usados[Math.floor(usados.length / 2)];
  const p95 = usados[Math.min(usados.length - 1, Math.floor(usados.length * 0.95))];
  return {
    fps: +(1000 / Math.max(mediana, 0.001)).toFixed(1),
    p95FrameMs: +p95.toFixed(1),
  };
}

/**
 * El Viewer no se re-renderiza si sus props no cambiaron.
 *
 * Va de la mano con estabilizar los callbacks en App: sin memo, cada aviso de
 * progreso (10 por segundo durante la carga) re-renderizaba un componente con
 * ~15 closures y el handle imperativo adentro. Con memo + callbacks estables,
 * la carga deja de pelear con los gestos por el hilo principal.
 */
export const Viewer = memo(ViewerBase);

/**
 * Mosaico de la grilla, cacheado por (tamaño de celda, color).
 *
 * Dibujar la grilla linea por linea eran hasta ~290 segmentos por redibujo;
 * con un patron es un solo `fillRect`. El mosaico se regenera solo cuando
 * cambia el zoom lo suficiente como para cambiar el tamaño de celda, o cuando
 * cambia el tema.
 */
let grillaCache: { clave: string; patron: CanvasPattern | null } | null = null;
function patronGrilla(
  ctx: CanvasRenderingContext2D,
  gridSize: number,
  color: string
): CanvasPattern | null {
  // Se redondea el lado para no regenerar el mosaico por diferencias
  // invisibles de zoom.
  const lado = Math.max(4, Math.round(gridSize));
  const clave = `${lado}|${color}`;
  if (grillaCache && grillaCache.clave === clave) return grillaCache.patron;

  const tile = document.createElement("canvas");
  tile.width = lado;
  tile.height = lado;
  const tctx = tile.getContext("2d");
  let patron: CanvasPattern | null = null;
  if (tctx) {
    tctx.strokeStyle = color;
    tctx.lineWidth = 1;
    tctx.beginPath();
    // Las lineas van en el borde del mosaico, a medio pixel, para que salgan
    // nitidas igual que con el dibujado directo.
    tctx.moveTo(0.5, 0);
    tctx.lineTo(0.5, lado);
    tctx.moveTo(0, 0.5);
    tctx.lineTo(lado, 0.5);
    tctx.stroke();
    patron = ctx.createPattern(tile, "repeat");
  }
  grillaCache = { clave, patron };
  return patron;
}

/**
 * Contexto 2D del lienzo, creado una sola vez y con `alpha: false`.
 *
 * El canvas nunca es transparente (siempre se pinta el fondo del tema), asi
 * que declararlo opaco le permite al compositor saltear el mezclado de toda
 * la capa — que en un movil de gama baja es trabajo por frame presentado.
 * Los atributos solo se pueden pasar en la PRIMERA llamada a getContext, por
 * eso hace falta guardarlo en vez de pedirlo en cada frame.
 */
const contextos = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();
function contextoCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  let ctx = contextos.get(canvas);
  if (ctx === undefined) {
    ctx = canvas.getContext("2d", { alpha: false });
    contextos.set(canvas, ctx);
  }
  return ctx;
}

/** true si la fuente tiene pixeles para dibujar. Un ImageBitmap cerrado o un
 * canvas puesto en 0x0 (que es como se libera memoria en iOS/Android) hacen
 * que drawImage lance InvalidStateError. */
function anchoUtil(img: CanvasImageSource): boolean {
  const w = (img as any).width;
  const h = (img as any).height;
  return typeof w !== "number" || (w > 0 && h > 0);
}

