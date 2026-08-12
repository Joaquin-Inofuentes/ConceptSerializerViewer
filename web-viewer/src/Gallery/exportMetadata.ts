import { getUserName } from "./userIdentity";

export interface ExportMetadata {
  userName: string;
  fecha: string;
  hora: string;
  ip: string;
}

/** Junta los datos de "quien/cuando/desde donde" para estampar en las
 * descargas (PDF/ZIP). La IP es la publica del que exporta, consultada a
 * un servicio publico sin key; si no hay red o el request falla, queda
 * "desconocida" en vez de trabar la descarga. */
export async function gatherExportMetadata(): Promise<ExportMetadata> {
  const userName = getUserName() || "Invitado";
  const now = new Date();
  const fecha = now.toLocaleDateString("es-AR");
  const hora = now.toLocaleTimeString("es-AR");
  let ip = "desconocida";
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data?.ip) ip = data.ip;
    }
  } catch {
    // sin red o bloqueado por el navegador: sigue con "desconocida".
  }
  return { userName, fecha, hora, ip };
}
