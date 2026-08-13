import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, useCallback } from "react";
import type { Document, Stroke } from "./parser";
import {
  loadResourceImages,
  releaseResourceImages,
  drawnSizes,
  safeExportScale,
  exportFueRecortado,
  statsCache,
} from "../Gallery/renderCore";
import { getBudgets } from "../device";

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
  onImagesLoaded?: (images: Record<string, string>) => void;
  /** Avisa cuando terminaron de cargarse los recursos embebidos (fotos/PDFs),
   * que es lo unico lento al abrir un dibujo pesado. */
  onResourcesReady?: () => void;
  /** Avance de carga de recursos, para mostrarlo en la UI. */
  onResourceProgress?: (listos: number, total: number) => void;
}

export interface ViewerHandle {
  exportDrawing: (format: 'png' | 'jpg' | 'pdf', zoomAll?: boolean) => Promise<void>;
  /** Metricas en vivo, para benchmarks y diagnostico. */
  getStats: () => ViewerStats;
}

export interface ViewerStats {
  fps: number;
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

interface CachedStroke {
  kind: "stroke";
  pathFull: Path2D;
  pathCoarse: Path2D;
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
}

type CachedItem = CachedStroke | CachedImage;

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

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({ doc, fileId, layerConfigs, isolatedLayer, onImagesLoaded, onResourcesReady, onResourceProgress }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const budgets = useMemo(() => getBudgets(), []);

  // Core state moved to refs for high performance
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const sizeRef = useRef({ width: 0, height: 0 });

  // Cache refs
  const imagesRef = useRef<Record<string, CanvasImageSource>>({});
  /** Px por unidad de documento a la que estan rasterizados los recursos
   * actuales; si el usuario se acerca mas que esto, se re-rasterizan. */
  const resourceScaleRef = useRef(0);
  const layerConfigsRef = useRef<Record<string, LayerConfig>>(layerConfigs);
  const isolatedLayerRef = useRef<string | null>(isolatedLayer);
  const isDirtyRef = useRef(true);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // --- Estado del gesto (pan/zoom) ---------------------------------------
  // Durante un gesto NO se re-dibuja la escena: se estira el ultimo frame ya
  // rasterizado (un solo drawImage, ~1 ms fijo). Redibujar 7000 trazos +
  // 19 imagenes por frame costaba 40-50 ms en gama baja, o sea 20 fps y
  // gestos "pegajosos". Al soltar (o al frenar) se re-dibuja nitido.
  const gestoRef = useRef(false);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  /** pan/zoom en el momento de tomar el snapshot. */
  const snapshotViewRef = useRef({ panX: 0, panY: 0, zoom: 1, dpr: 1 });
  const finGestoTimerRef = useRef<number | null>(null);

  // --- Metricas ----------------------------------------------------------
  const statsRef = useRef<ViewerStats>({
    fps: 0,
    ultimoFrameMs: 0,
    framesDibujados: 0,
    recursosCargados: 0,
    pixelesImagenes: 0,
    dpr: budgets.maxDpr,
  });
  const frameTimesRef = useRef<number[]>([]);

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
  useEffect(() => {
    onImagesLoadedRef.current = onImagesLoaded;
    onResourcesReadyRef.current = onResourcesReady;
    onResourceProgressRef.current = onResourceProgress;
  });

  // Sync props to refs
  useEffect(() => {
    layerConfigsRef.current = layerConfigs;
    isolatedLayerRef.current = isolatedLayer;
    requestRedraw();
  }, [layerConfigs, isolatedLayer, requestRedraw]);

  // Pre-calcula Path2D (en dos niveles de detalle), bounding boxes para
  // frustum culling, y el orden de dibujado por capa. El orden se resuelve
  // ACA y no en cada frame: re-ordenar decenas de miles de items 60 veces
  // por segundo era el costo dominante del pan/zoom en dibujos grandes.
  const docCache = useMemo(() => {
    if (!doc) return null;
    const items: CachedItem[] = [];

    doc.layers.forEach(layer => {
      layer.strokes.forEach(stroke => {
        if (stroke.points.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of stroke.points) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }
        items.push({
          kind: "stroke",
          pathFull: buildPath(stroke.points, 0.25),
          pathCoarse: buildPath(stroke.points, 2.5),
          minX, minY, maxX, maxY,
          color: stroke.color.hex,
          globalAlpha: stroke.color.a,
          width: stroke.width || 1.5,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });

      layer.images.forEach(img => {
        const tx = img.transform[12];
        const ty = img.transform[13];
        const w = img.width || 500;
        const h = img.height || 500;
        items.push({
          kind: "image",
          resourceId: img.resourceId,
          transform: img.transform,
          minX: tx, minY: ty, maxX: tx + w, maxY: ty + h,
          width: img.width, height: img.height,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });
    });

    items.sort((a, b) => a.layerIndex - b.layerIndex);
    return { items };
  }, [doc]);

  useEffect(() => {
    requestRedraw();
  }, [docCache, requestRedraw]);

  const visibleItem = (item: CachedItem) => {
    if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) return false;
    const config = layerConfigsRef.current[item.layerId];
    return !(config && !config.visible);
  };

  useImperativeHandle(ref, () => ({
    getStats: () => ({ ...statsRef.current }),
    exportDrawing: async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
      if (!doc || !docCache) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      if (zoomAll) {
        let hasStrokes = false;
        for (const item of docCache.items) {
          if (item.kind === "image" || !visibleItem(item)) continue;
          hasStrokes = true;
          if (item.minX < minX) minX = item.minX;
          if (item.minY < minY) minY = item.minY;
          if (item.maxX > maxX) maxX = item.maxX;
          if (item.maxY > maxY) maxY = item.maxY;
        }
        if (!hasStrokes) {
          for (const item of docCache.items) {
            if (item.kind === "stroke" || !visibleItem(item)) continue;
            if (item.minX < minX) minX = item.minX;
            if (item.minY < minY) minY = item.minY;
            if (item.maxX > maxX) maxX = item.maxX;
            if (item.maxY > maxY) maxY = item.maxY;
          }
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
      const exportImages = await loadResourceImages(doc, {
        targets,
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
            const imageObj = exportImages[item.resourceId];
            if (!imageObj) continue;
            ctx.save();
            ctx.globalAlpha = layerOpacity;
            const m = item.transform;
            if (m && m.length === 16) {
              ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
            }
            if (item.width && item.height) ctx.drawImage(imageObj, 0, 0, item.width, item.height);
            else ctx.drawImage(imageObj, 0, 0);
            ctx.restore();
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
        releaseResourceImages(exportImages);
      }
    }
  }));

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

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasStrokes = false;
    for (const item of docCache.items) {
      if (item.kind === "image") continue;
      hasStrokes = true;
      if (item.minX < minX) minX = item.minX;
      if (item.minY < minY) minY = item.minY;
      if (item.maxX > maxX) maxX = item.maxX;
      if (item.maxY > maxY) maxY = item.maxY;
    }
    if (!hasStrokes) {
      for (const item of docCache.items) {
        if (item.kind === "stroke") continue;
        if (item.minX < minX) minX = item.minX;
        if (item.minY < minY) minY = item.minY;
        if (item.maxX > maxX) maxX = item.maxX;
        if (item.maxY > maxY) maxY = item.maxY;
      }
    }
    if (minX === Infinity) return null;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    if (!(contentWidth > 0) || !(contentHeight > 0)) return null;

    const pad = 40;
    let zoom = Math.min((rect.width - pad * 2) / contentWidth, (rect.height - pad * 2) / contentHeight);
    zoom = Math.max(0.1, Math.min(zoom, 5));
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
    requestRedraw();
  }, [computeFit, requestRedraw]);

  useEffect(() => {
    fitToBounds();
  }, [docCache, fitToBounds]);

  /** Ids de recursos que caen dentro de la vista actual, primero los que
   * ocupan mas pantalla. Es el orden en que conviene cargarlos: lo que el
   * usuario esta mirando aparece antes. */
  const recursosVisibles = useCallback((): string[] => {
    if (!docCache) return [];
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const size = sizeRef.current;
    const viewMinX = -pan.x / zoom;
    const viewMinY = -pan.y / zoom;
    const viewMaxX = (size.width - pan.x) / zoom;
    const viewMaxY = (size.height - pan.y) / zoom;

    const areas = new Map<string, number>();
    for (const item of docCache.items) {
      if (item.kind !== "image" || !visibleItem(item)) continue;
      const ix = Math.max(0, Math.min(item.maxX, viewMaxX) - Math.max(item.minX, viewMinX));
      const iy = Math.max(0, Math.min(item.maxY, viewMaxY) - Math.max(item.minY, viewMinY));
      const area = ix * iy;
      if (area <= 0) continue;
      areas.set(item.resourceId, Math.max(areas.get(item.resourceId) || 0, area));
    }
    return [...areas.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [docCache]);

  // --- Recursos embebidos (fotos / PDFs) ---------------------------------
  // Esta era la causa real del freeze al abrir un dibujo pesado: cada PDF
  // embebido se rasterizaba a la escala del EXPORT (600 DPI) aunque en
  // pantalla ocupara 400x800 px, dando canvases de 50-77 megapixeles (mas de
  // 1 GB de RAM en un solo dibujo) y ademas se les hacia toDataURL() para la
  // galeria de imagenes. Ahora se rasterizan al tamaño de PANTALLA con algo
  // de margen para zoom, y se re-rasterizan solo si el usuario se acerca de
  // verdad.
  const cargarRecursos = useCallback(async (
    escala: number,
    signal?: AbortSignal,
    only?: string[]
  ) => {
    if (!doc) return;
    const dibujado = drawnSizes(doc);
    if (Object.keys(dibujado).length === 0) return;
    const targets: Record<string, { width: number; height: number }> = {};
    Object.entries(dibujado).forEach(([id, size]) => {
      targets[id] = { width: size.width * escala, height: size.height * escala };
    });

    const total = (only ?? doc.resourceIds).length;
    let listos = 0;

    // Pixeles que ya ocupan los recursos cargados: el presupuesto de RAM es
    // del DOCUMENTO entero, no de cada tanda, asi que la segunda tanda tiene
    // que arrancar donde quedo la primera.
    let yaUsados = 0;
    Object.entries(imagesRef.current).forEach(([id, i]) => {
      if (only && only.includes(id)) return; // se va a reemplazar
      yaUsados += ((i as any).width || 0) * ((i as any).height || 0);
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
      onEach: (id, img) => {
        if (signal?.aborted) return;
        const previa = imagesRef.current[id];
        imagesRef.current = { ...imagesRef.current, [id]: img };
        if (previa && previa !== img) liberarUno(previa);
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
      const sobrantes: Record<string, CanvasImageSource> = {};
      Object.entries(nuevas).forEach(([id, img]) => {
        if (enUso[id] !== img) sobrantes[id] = img;
      });
      releaseResourceImages(sobrantes);
      return;
    }
    resourceScaleRef.current = escala * RESOURCE_QUALITY;
    let px = 0;
    Object.values(imagesRef.current).forEach((i) => {
      px += ((i as any).width || 0) * ((i as any).height || 0);
    });
    statsRef.current.pixelesImagenes = px;
    requestRedraw();
    return nuevas;
  }, [doc, fileId, budgets, requestRedraw]);

  const cargaInicialRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!doc) return;
    let cancelado = false;
    const abort = new AbortController();
    cargaInicialRef.current = abort;

    (async () => {
      // Se espera un frame para que el contenedor ya tenga tamaño y el
      // encuadre inicial sea el real (si no, se rasteriza para un zoom que
      // no es el que va a ver el usuario).
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (cancelado) return;
      const fit = computeFit();
      const escala = (fit?.zoom ?? 1) * budgets.maxDpr;

      // Primero lo que se ve en pantalla, despues el resto. En un dibujo con
      // 19 planos donde entran 3 en el encuadre inicial, esto adelanta lo
      // visible sin esperar a los 16 que estan fuera de cuadro.
      const visibles = recursosVisibles();
      const resto = doc.resourceIds.filter((id) => !visibles.includes(id));

      if (visibles.length > 0) {
        await cargarRecursos(escala, abort.signal, visibles);
      }
      if (cancelado || abort.signal.aborted) return;
      if (resto.length > 0) {
        await cargarRecursos(escala, abort.signal, resto);
      }
      if (cancelado || abort.signal.aborted) return;
      onResourcesReadyRef.current?.();
    })();

    return () => {
      cancelado = true;
      abort.abort();
    };
  }, [doc, computeFit, cargarRecursos, recursosVisibles, budgets]);

  /** Previews chicas para el menu de imagenes. Se generan PEREZOSAMENTE (al
   * abrir el menu), no al terminar de cargar: es un loop de toDataURL en el
   * hilo principal que en gama baja cuesta cientos de ms y no hace falta si
   * el usuario nunca abre ese menu. */
  const previewsPedidasRef = useRef(false);
  const pedirPreviews = useCallback(async () => {
    if (previewsPedidasRef.current || !onImagesLoadedRef.current) return;
    previewsPedidasRef.current = true;
    const urls: Record<string, string> = {};
    for (const [id, fuente] of Object.entries(imagesRef.current)) {
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
      if (snapshotRef.current) {
        snapshotRef.current.width = 0;
        snapshotRef.current.height = 0;
        snapshotRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // Refinado progresivo: si el usuario se acerca mas alla de la resolucion a
  // la que estan rasterizadas las fotos, se vuelven a rasterizar mas grandes.
  // Con debounce, para no re-rasterizar en cada paso de la rueda del mouse.
  // SOLO los recursos que se ven: antes re-rasterizaba los 19 aunque
  // estuvieras mirando uno, multiplicando por 19 el costo y la RAM pico.
  const refinarTimerRef = useRef<number | null>(null);
  const refinarAbortRef = useRef<AbortController | null>(null);
  const pedirRefinado = useCallback(() => {
    if (!doc || Object.keys(imagesRef.current).length === 0) return;
    if (refinarTimerRef.current) window.clearTimeout(refinarTimerRef.current);
    refinarTimerRef.current = window.setTimeout(() => {
      const necesaria = zoomRef.current * budgets.maxDpr;
      if (necesaria <= resourceScaleRef.current * 1.1) return;
      const visibles = recursosVisibles();
      if (visibles.length === 0) return;
      refinarAbortRef.current?.abort();
      const abort = new AbortController();
      refinarAbortRef.current = abort;
      void cargarRecursos(necesaria, abort.signal, visibles);
    }, 400);
  }, [doc, cargarRecursos, recursosVisibles, budgets]);

  useEffect(() => {
    return () => {
      if (refinarTimerRef.current) window.clearTimeout(refinarTimerRef.current);
      refinarAbortRef.current?.abort();
      if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    };
  }, []);

  // --- Gestos: snapshot + blit ------------------------------------------
  const iniciarGesto = useCallback(() => {
    if (gestoRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    let snap = snapshotRef.current;
    if (!snap) {
      snap = document.createElement("canvas");
      snapshotRef.current = snap;
    }
    if (snap.width !== canvas.width || snap.height !== canvas.height) {
      snap.width = canvas.width;
      snap.height = canvas.height;
    }
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, snap.width, snap.height);
    sctx.drawImage(canvas, 0, 0);
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
    requestRedraw();
    pedirRefinado();
  }, [requestRedraw, pedirRefinado]);

  /** Durante un gesto se llama a esto en vez de a requestRedraw: no redibuja
   * la escena, solo re-blitea el snapshot con el nuevo pan/zoom. */
  const marcarGesto = useCallback(() => {
    iniciarGesto();
    requestRedraw();
    // Si el usuario frena (sin soltar), a los 120 ms se re-dibuja nitido.
    if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    finGestoTimerRef.current = window.setTimeout(() => terminarGesto(), 120);
  }, [iniciarGesto, requestRedraw, terminarGesto]);

  // HIGH PERFORMANCE RENDER LOOP
  useEffect(() => {
    const render = () => {
      rafRef.current = null;
      const t0 = performance.now();
      let dibujo = false;

      if (isDirtyRef.current && canvasRef.current && docCache) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const pan = panRef.current;
        const zoom = zoomRef.current;
        const size = sizeRef.current;

        if (ctx && size.width > 0 && size.height > 0) {
          // DPR adaptativo: durante un gesto se rasteriza a menos resolucion
          // (44% menos pixeles en gama baja) y al soltar se vuelve al DPR
          // pleno. Como durante el gesto se blitea, el cambio no se nota.
          const dpr = gestoRef.current ? budgets.gestureDpr : budgets.maxDpr;
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

          // --- Camino rapido: gesto en curso -> estirar el ultimo frame ---
          const snap = snapshotRef.current;
          if (gestoRef.current && snap && snap.width > 0) {
            const s = snapshotViewRef.current;
            const k = zoom / s.zoom;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, bw, bh);
            // El snapshot esta en px de dispositivo del DPR con que se tomo.
            const escala = (k * dpr) / s.dpr;
            const dx = (pan.x - s.panX * k) * dpr;
            const dy = (pan.y - s.panY * k) * dpr;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "low";
            ctx.drawImage(snap, dx, dy, snap.width * escala, snap.height * escala);
            isDirtyRef.current = false;
            dibujo = true;
          } else {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, size.width, size.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = budgets.smoothing;

          // Grid: se dibuja en coordenadas de PANTALLA (una sola pasada de
          // lineas rectas), no en coordenadas de documento — asi la cantidad
          // de lineas depende del tamaño de la ventana y no del zoom.
          const gridSize = 50 * zoom;
          if (gridSize > 4) {
            ctx.save();
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            const startX = pan.x % gridSize;
            const startY = pan.y % gridSize;
            for (let x = startX; x < size.width; x += gridSize) {
              ctx.moveTo(Math.round(x) + 0.5, 0);
              ctx.lineTo(Math.round(x) + 0.5, size.height);
            }
            for (let y = startY; y < size.height; y += gridSize) {
              ctx.moveTo(0, Math.round(y) + 0.5);
              ctx.lineTo(size.width, Math.round(y) + 0.5);
            }
            ctx.stroke();
            ctx.restore();
          }

          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(zoom, zoom);

          // Frustum: solo se dibuja lo que cae dentro de la ventana.
          const viewMinX = -pan.x / zoom;
          const viewMinY = -pan.y / zoom;
          const viewMaxX = (size.width - pan.x) / zoom;
          const viewMaxY = (size.height - pan.y) / zoom;

          // Con el dibujo alejado, los trazos se dibujan con la version
          // simplificada del path: a ese zoom la diferencia no se ve y hay
          // varias veces menos segmentos que rasterizar.
          const usarCoarse = zoom < 0.75;

          let color = "";
          let alpha = -1;
          let ancho = -1;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";

          for (const item of docCache.items) {
            if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) continue;
            const config = layerConfigsRef.current[item.layerId];
            if (config && !config.visible) continue;
            if (item.maxX < viewMinX || item.minX > viewMaxX || item.maxY < viewMinY || item.minY > viewMaxY) {
              continue;
            }

            const layerOpacity = config ? config.opacity : 1.0;

            if (item.kind === "image") {
              const imageObj = imagesRef.current[item.resourceId];
              // Un recurso liberado (canvas con width/height en 0) hace que
              // drawImage TIRE, y una excepcion aca aborta el frame entero:
              // el lienzo queda a medio dibujar. Se saltea en silencio, que
              // es exactamente lo mismo que "todavia no cargo".
              if (!imageObj || !anchoUtil(imageObj)) continue;
              ctx.save();
              ctx.globalAlpha = layerOpacity;
              const m = item.transform;
              if (m && m.length === 16) {
                ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
              }
              if (item.width && item.height) ctx.drawImage(imageObj, 0, 0, item.width, item.height);
              else ctx.drawImage(imageObj, 0, 0);
              ctx.restore();
              // El save/restore invalida el estado de trazo cacheado.
              color = ""; alpha = -1; ancho = -1;
            } else {
              // Cambiar strokeStyle/lineWidth/globalAlpha tiene costo; se
              // saltea cuando el valor no cambio respecto del item anterior.
              const a = item.globalAlpha * layerOpacity;
              if (item.color !== color) { ctx.strokeStyle = item.color; color = item.color; }
              if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
              if (item.width !== ancho) { ctx.lineWidth = item.width; ancho = item.width; }
              ctx.stroke(usarCoarse ? item.pathCoarse : item.pathFull);
            }
          }
          ctx.restore();
          isDirtyRef.current = false;
          dibujo = true;
          }
        }
      }

      if (dibujo) {
        const ms = performance.now() - t0;
        statsRef.current.ultimoFrameMs = ms;
        statsRef.current.framesDibujados++;
        const ft = frameTimesRef.current;
        ft.push(ms);
        if (ft.length > 60) ft.shift();
        const prom = ft.reduce((a, b) => a + b, 0) / ft.length;
        statsRef.current.fps = prom > 0 ? Math.min(60, 1000 / Math.max(prom, 16.67)) : 60;
        framesLimpiosRef.current = 0;
      } else {
        framesLimpiosRef.current++;
      }

      // El loop se apaga tras unos frames sin nada que dibujar. Cualquier
      // interaccion lo vuelve a encender via requestRedraw.
      if (isDirtyRef.current || framesLimpiosRef.current < 3) {
        rafRef.current = requestAnimationFrame(render);
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
  const [lastTap, setLastTap] = useState(0);
  const [tapCount, setTapCount] = useState(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        const newCount = tapCount + 1;
        setTapCount(newCount);
        if (newCount >= 3) {
           fitToBounds();
           setTapCount(0);
        }
      } else {
        setTapCount(1);
      }
      setLastTap(now);

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
      recursosEnMemoria: Object.keys(imagesRef.current).length,
      ramImagenesMB: +((statsRef.current.pixelesImagenes * 4) / 1048576).toFixed(1),
      cache: { ...statsCache },
    });
    return () => {
      delete (window as any).__conceptsPedirPreviews;
      delete (window as any).__viewerStats;
    };
  }, [pedirPreviews]);

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

/** true si la fuente tiene pixeles para dibujar. Un ImageBitmap cerrado o un
 * canvas puesto en 0x0 (que es como se libera memoria en iOS/Android) hacen
 * que drawImage lance InvalidStateError. */
function anchoUtil(img: CanvasImageSource): boolean {
  const w = (img as any).width;
  const h = (img as any).height;
  return typeof w !== "number" || (w > 0 && h > 0);
}

/** Libera un bitmap suelto (helper del reemplazo progresivo). */
function liberarUno(img: CanvasImageSource) {
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
  else if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) {
    img.width = 0;
    img.height = 0;
  }
}
