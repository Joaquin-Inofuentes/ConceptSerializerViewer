/**
 * Tema claro/oscuro, con oscuro por defecto.
 *
 * El tema se aplica como `data-theme` en <html> y todo el CSS cuelga de ahi
 * (variables). El lienzo NO usa CSS: dibuja en canvas, asi que lee los
 * colores desde `coloresLienzo()` — si no, el visor quedaria blanco dentro de
 * una app oscura, que es justamente lo que se veia antes.
 *
 * Se guarda en localStorage y se aplica lo antes posible (ver el script
 * inline en index.html) para que no haya un flash blanco al cargar.
 */

export type Tema = "claro" | "oscuro";

const CLAVE = "conceptserializer_tema";

export function temaGuardado(): Tema {
  if (typeof localStorage === "undefined") return "oscuro";
  const v = localStorage.getItem(CLAVE);
  return v === "claro" || v === "oscuro" ? v : "oscuro";
}

export function aplicarTema(t: Tema) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(CLAVE, t);
  } catch {
    /* modo incognito */
  }
  // Avisa al visor, que dibuja en canvas y no se entera por CSS.
  window.dispatchEvent(new CustomEvent("concepts:tema", { detail: t }));
}

export function alternarTema(): Tema {
  const nuevo: Tema = temaGuardado() === "oscuro" ? "claro" : "oscuro";
  aplicarTema(nuevo);
  return nuevo;
}

export interface ColoresLienzo {
  fondo: string;
  grilla: string;
  /** Color con el que se dibuja el recuadro de un recurso que no cargo. */
  huecoBorde: string;
  huecoRelleno: string;
  huecoTexto: string;
}

/** Colores que necesita el canvas del visor, segun el tema activo. */
export function coloresLienzo(t: Tema = temaGuardado()): ColoresLienzo {
  if (t === "oscuro") {
    return {
      fondo: "#14161c",
      grilla: "#232733",
      huecoBorde: "#3a4152",
      huecoRelleno: "#1b1f28",
      huecoTexto: "#6b7488",
    };
  }
  return {
    fondo: "#ffffff",
    grilla: "#e0e0e0",
    huecoBorde: "#c9cedb",
    huecoRelleno: "#f1f3f7",
    huecoTexto: "#98a0b0",
  };
}
