/**
 * Progreso REAL de apertura de un dibujo, con fase y tiempo estimado.
 *
 * El porcentaje no es decorativo: se calcula sobre los bytes que de verdad
 * hay que traer, que se conocen exactamente apenas se lee el indice del zip
 * (tree.pack + la vista previa + el tamaño comprimido de cada recurso
 * colocado). Antes de eso solo se sabe que estamos bajando el indice, y se
 * dice eso en vez de inventar un numero.
 *
 * El tiempo restante sale de la velocidad MEDIDA sobre lo que ya se
 * transfirio, no de una constante: la velocidad de los primeros megabytes
 * predice el resto, y se re-estima en cada actualizacion. Se suaviza para que
 * el numero no salte (una media movil exponencial), porque un contador que
 * baila entre 8 s y 40 s es peor que no tener contador.
 */

export type Fase = "abriendo" | "descargando" | "procesando" | "dibujando" | "listo";

export const TEXTO_FASE: Record<Fase, string> = {
  abriendo: "Abriendo archivo",
  descargando: "Descargando",
  procesando: "Procesando",
  dibujando: "Dibujando",
  listo: "Listo",
};

export interface EstadoProgreso {
  fase: Fase;
  /** 0..100. null mientras no se pueda calcular de verdad. */
  porcentaje: number | null;
  bytesRecibidos: number;
  bytesEsperados: number | null;
  /** Segundos restantes estimados, o null si todavia no hay datos. */
  segundosRestantes: number | null;
  /** kB/s medidos, para diagnostico. */
  velocidadKBs: number | null;
  /** Detalle opcional: "imagen 3 de 19". */
  detalle: string | null;
}

export class SeguidorProgreso {
  private inicio = performance.now();
  private bytes = 0;
  private esperados: number | null = null;
  private fase: Fase = "abriendo";
  private detalle: string | null = null;
  private velocidadSuavizada: number | null = null; // bytes por ms
  private ultimoAviso = 0;
  private onCambio: (e: EstadoProgreso) => void;

  constructor(onCambio: (e: EstadoProgreso) => void) {
    this.onCambio = onCambio;
  }

  /** Bytes que efectivamente viajaron por la red. */
  sumarBytes(n: number) {
    this.bytes += n;
    this.recalcularVelocidad();
    this.avisar();
  }

  /** Se llama apenas se conoce el indice del zip: a partir de aca el
   * porcentaje es real. */
  fijarEsperados(n: number) {
    this.esperados = Math.max(n, this.bytes);
    this.avisar(true);
  }

  cambiarFase(f: Fase, detalle: string | null = null) {
    this.fase = f;
    this.detalle = detalle;
    this.avisar(true);
  }

  fijarDetalle(d: string | null) {
    this.detalle = d;
    this.avisar();
  }

  private recalcularVelocidad() {
    const transcurrido = performance.now() - this.inicio;
    if (transcurrido < 200 || this.bytes === 0) return;
    const instantanea = this.bytes / transcurrido; // bytes/ms
    // Media movil exponencial: pondera lo nuevo sin saltar.
    this.velocidadSuavizada =
      this.velocidadSuavizada === null ? instantanea : this.velocidadSuavizada * 0.7 + instantanea * 0.3;
  }

  estado(): EstadoProgreso {
    const v = this.velocidadSuavizada;
    let porcentaje: number | null = null;
    let segundosRestantes: number | null = null;

    if (this.esperados && this.esperados > 0) {
      porcentaje = Math.max(0, Math.min(100, (this.bytes / this.esperados) * 100));
      const faltan = Math.max(0, this.esperados - this.bytes);
      if (v && v > 0) segundosRestantes = faltan / v / 1000;
    }
    // Ya no queda red pendiente pero todavia se esta rasterizando: el
    // porcentaje se queda arriba y la fase explica que falta.
    if (porcentaje !== null && porcentaje >= 99.5 && this.fase !== "listo") {
      segundosRestantes = null;
    }
    if (this.fase === "listo") {
      porcentaje = 100;
      segundosRestantes = 0;
    }

    return {
      fase: this.fase,
      porcentaje,
      bytesRecibidos: this.bytes,
      bytesEsperados: this.esperados,
      segundosRestantes,
      velocidadKBs: v ? +((v * 1000) / 1024).toFixed(0) : null,
      detalle: this.detalle,
    };
  }

  /** Avisa como mucho ~10 veces por segundo: actualizar el DOM en cada chunk
   * de red cuesta mas que la propia descarga en un telefono lento. */
  private avisar(forzar = false) {
    const ahora = performance.now();
    if (!forzar && ahora - this.ultimoAviso < 100) return;
    this.ultimoAviso = ahora;
    this.onCambio(this.estado());
  }
}

export function formatearRestante(s: number | null): string {
  if (s === null || !isFinite(s)) return "";
  if (s < 1) return "menos de 1 s";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m} min ${r} s`;
}

export function formatearMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
