import { getUserName } from "./userIdentity";

export interface ExportMetadata {
  userName: string;
  fecha: string;
  hora: string;
}

/**
 * Junta los datos de "quien/cuando" para estampar en las descargas
 * (PDF/ZIP).
 *
 * Antes tambien consultaba `api.ipify.org` (un tercero, sin consentimiento
 * del usuario) para incluir su IP publica, y la escribia dentro del PDF/ZIP
 * -- un archivo pensado para COMPARTIRSE. Cualquiera que recibiera la
 * exportacion terminaba con la IP y el nombre de quien la genero. Si en
 * algun momento hace falta trazabilidad real, el lugar correcto es el
 * `insertEvento` de analytics.ts contra el edge function (que YA ve la IP
 * real del cliente en el request, sin depender de un tercero) guardada en
 * la tabla de eventos -- no incrustada en un archivo que sale de la app.
 */
export async function gatherExportMetadata(): Promise<ExportMetadata> {
  const userName = getUserName() || "Invitado";
  const now = new Date();
  const fecha = now.toLocaleDateString("es-AR");
  const hora = now.toLocaleTimeString("es-AR");
  return { userName, fecha, hora };
}
