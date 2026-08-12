import { supabase } from "./supabaseClient";

export type DescargaOrigen = "galeria" | "lienzo" | "foto";

// Un id por pestaña/sesion de navegacion, para poder agrupar eventos del
// mismo visitante sin pedir login.
const SESION_ID = crypto.randomUUID();

async function registrarEvento(evento: "abrir" | "cerrar" | "descargar", campos: Record<string, unknown>) {
  try {
    const { error } = await supabase.from("visor_eventos").insert({
      evento,
      sesion_id: SESION_ID,
      ...campos,
    });
    if (error) console.error("Error registrando metrica de uso:", error);
  } catch (e) {
    console.error("Error registrando metrica de uso:", e);
  }
}

export function logAbrir(archivoId: string, archivoNombre: string, carpetaId: string) {
  void registrarEvento("abrir", { archivo_id: archivoId, archivo_nombre: archivoNombre, carpeta_id: carpetaId });
}

export function logCerrar(archivoId: string | null, archivoNombre: string | null) {
  void registrarEvento("cerrar", { archivo_id: archivoId, archivo_nombre: archivoNombre });
}

export function logDescarga(
  origen: DescargaOrigen,
  formato: string,
  archivoIds: string[],
  archivoNombre?: string | null
) {
  void registrarEvento("descargar", {
    origen,
    formato,
    archivo_ids: archivoIds,
    archivo_id: archivoIds.length === 1 ? archivoIds[0] : null,
    archivo_nombre: archivoNombre ?? null,
    cantidad_archivos: archivoIds.length,
  });
}
