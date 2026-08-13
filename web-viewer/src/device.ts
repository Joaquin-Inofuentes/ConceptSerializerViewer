/**
 * Deteccion de gama del dispositivo y presupuestos derivados.
 *
 * Todo el resto de la app (visor, galeria, export, cache) pide sus limites
 * ACA en vez de hardcodear numeros: en un telefono de 1 GB de RAM sin GPU
 * (J7 Neo, TCL 30 SE) los mismos valores que van bien en desktop hacen que
 * Android mate la pestaña.
 *
 * Medido: el dibujo mas pesado de la carpeta (262,9 MB) llegaba a 316 MB de
 * heap pico, y Chrome en Android de 1 GB empieza a matar pestañas entre
 * 300 y 450 MB.
 */

export type DeviceTier = "baja" | "media" | "alta";

export interface Budgets {
  tier: DeviceTier;
  /** Techo de RAM para los bitmaps de TODOS los recursos de un dibujo. */
  maxImagePixels: number;
  /** Techo por recurso individual. */
  maxPixelsPerResource: number;
  /** Cuantos recursos se rasterizan a la vez. */
  concurrency: number;
  /** Techo del canvas de export (el navegador ademas tiene el suyo). */
  maxExportPixels: number;
  /** Tope del cache en memoria de archivos ya bajados. */
  maxBufferCacheBytes: number;
  /** Tope del cache persistente de rasterizados (IndexedDB). */
  maxRasterCacheBytes: number;
  /** DPR maximo del canvas del visor en reposo. */
  maxDpr: number;
  /** DPR durante un gesto de pan/zoom (menos pixeles = mas fps). */
  gestureDpr: number;
  /** Si conviene rasterizar PDFs en un worker con OffscreenCanvas. */
  preferWorker: boolean;
  /** Calidad de suavizado al escalar imagenes. */
  smoothing: ImageSmoothingQuality;
}

function detectarTier(): DeviceTier {
  if (typeof navigator === "undefined") return "media";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ram = nav.deviceMemory;
  const cores = nav.hardwareConcurrency || 0;

  // deviceMemory existe en Chrome/Android (lo que nos importa) y se redondea
  // a potencias de 2: un telefono de 1 GB reporta 1, uno de 3 GB reporta 2.
  if (typeof ram === "number") {
    if (ram <= 2) return "baja";
    if (ram <= 4) return "media";
    return cores >= 8 ? "alta" : "media";
  }
  // Safari no expone deviceMemory. Se usa la cantidad de nucleos + si el UA
  // dice movil, y ante la duda se elige conservador.
  const esMovil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (esMovil) return cores >= 6 ? "media" : "baja";
  return cores <= 2 ? "media" : "alta";
}

const MB = 1024 * 1024;

function construir(tier: DeviceTier): Budgets {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  if (tier === "baja") {
    return {
      tier,
      // 12 Mpx x 4 bytes = 48 MB de bitmaps como mucho.
      maxImagePixels: 12_000_000,
      maxPixelsPerResource: 3_000_000,
      concurrency: 2,
      // 24 Mpx = 96 MB de canvas de export.
      maxExportPixels: 24_000_000,
      maxBufferCacheBytes: 48 * MB,
      maxRasterCacheBytes: 50 * MB,
      maxDpr: Math.min(dpr, 2),
      gestureDpr: Math.min(dpr, 1.5),
      preferWorker: true,
      smoothing: "medium",
    };
  }
  if (tier === "media") {
    return {
      tier,
      maxImagePixels: 40_000_000,
      maxPixelsPerResource: 4_000_000,
      concurrency: 3,
      maxExportPixels: 60_000_000,
      maxBufferCacheBytes: 150 * MB,
      maxRasterCacheBytes: 150 * MB,
      maxDpr: Math.min(dpr, 2),
      gestureDpr: Math.min(dpr, 2),
      preferWorker: true,
      smoothing: "high",
    };
  }
  return {
    tier,
    maxImagePixels: 120_000_000,
    maxPixelsPerResource: 8_000_000,
    concurrency: 4,
    maxExportPixels: 120_000_000,
    maxBufferCacheBytes: 400 * MB,
    maxRasterCacheBytes: 400 * MB,
    maxDpr: Math.min(dpr, 2),
    gestureDpr: Math.min(dpr, 2),
    preferWorker: true,
    smoothing: "high",
  };
}

let cache: Budgets | null = null;

/** Presupuestos del dispositivo actual (se calcula una vez por sesion). */
export function getBudgets(): Budgets {
  if (!cache) cache = construir(detectarTier());
  return cache;
}

/** Fuerza una gama concreta. Solo para benchmarks (?tier=baja en la URL). */
export function forceTier(tier: DeviceTier) {
  cache = construir(tier);
}

/** Aplica ?tier=baja|media|alta de la URL, para poder probar el modo de gama
 * baja desde una maquina de escritorio. */
export function applyTierFromUrl() {
  if (typeof window === "undefined") return;
  const t = new URLSearchParams(window.location.search).get("tier");
  if (t === "baja" || t === "media" || t === "alta") forceTier(t);
}

/** Soporte de OffscreenCanvas + transferencia a worker (Chrome 69+, Safari 16.4+). */
export function soportaOffscreen(): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    // Safari 16.4 tiene OffscreenCanvas pero su contexto 2d en worker es
    // inestable con pdf.js; se exige convertToBlob para filtrar los parciales.
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  );
}
