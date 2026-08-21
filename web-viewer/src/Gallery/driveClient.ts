import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "../config";

export interface DriveFolderRef {
  id: string;
  name: string;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedAt: string | null;
  hasTime: boolean;
}

export interface DriveListing {
  folders: DriveFolderRef[];
  files: DriveFile[];
}

function authHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

/** Sin timeout, un fetch que cuelga (tunel, red movil muerta a mitad de
 * camino sin RST) no resuelve NI rechaza: el try/catch que lo rodea nunca se
 * dispara y los reintentos de mas abajo no corren nunca. La galeria se queda
 * con el spinner de "cargando" para siempre. */
function fetchConTimeout(url: string, init: RequestInit, ms = 10_000): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal = init.signal ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...init, signal });
}

/**
 * Lista subcarpetas y archivos de una carpeta publica de Google Drive
 * (raiz o cualquier subcarpeta), sin API key. Solo el id de la carpeta
 * RAIZ se hardcodea en config.ts; esto se puede llamar con el id de
 * cualquier subcarpeta descubierta en vivo.
 */
export async function listDriveFolder(folderId: string): Promise<DriveListing> {
  // Con reintentos: Drive devuelve 5xx esporadicos cuando se le piden varias
  // carpetas seguidas (el proxy los reporta como 502), y en una conexion
  // movil los pedidos se cortan. Sin esto, un fallo puntual dejaba la galeria
  // en pantalla de error aunque el siguiente intento hubiera funcionado.
  let ultimoError: unknown;
  for (let intento = 0; intento < 3; intento++) {
    try {
      const res = await fetchConTimeout(
        `${FUNCTIONS_URL}/concepts-drive?action=list&folderId=${encodeURIComponent(folderId)}`,
        { headers: authHeaders() },
        8_000
      );
      if (!res.ok) throw new Error(`No se pudo listar la carpeta de Drive (${res.status})`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Error listando la carpeta de Drive");
      return { folders: data.folders || [], files: data.files || [] };
    } catch (e) {
      ultimoError = e;
      if (intento < 2) await new Promise((r) => setTimeout(r, 500 * Math.pow(3, intento)));
    }
  }
  throw ultimoError instanceof Error ? ultimoError : new Error(String(ultimoError));
}

/**
 * URL del proxy para un archivo de Drive. Es la que consume el lector de zip
 * por rangos: en vez de bajar los 262 MB, pide los pedazos que necesita.
 *
 * En DESARROLLO acepta `?origen=<url>` para leer el mismo .concepts desde un
 * servidor local. No es una funcion de la app: es para poder medir. Contra
 * Drive cada rango tarda entre 0,3 y 3 s segun la hora, y con esa varianza dos
 * corridas del banco de pruebas no se pueden comparar — o sea que no se puede
 * saber si un cambio mejoro algo. Va detras de `import.meta.env.DEV` para que
 * el build de produccion ni siquiera lo incluya.
 */
export function driveFileUrl(fileId: string): string {
  if (import.meta.env.DEV) {
    const origen = new URLSearchParams(window.location.search).get("origen");
    if (origen) return `${origen.replace(/\/+$/, "")}/${encodeURIComponent(fileId)}.concepts`;
  }
  return `${FUNCTIONS_URL}/concepts-drive?action=download&fileId=${encodeURIComponent(fileId)}`;
}

/** Headers de autenticacion del proxy, para pasarlos al lector de rangos. */
export function driveAuthHeaders(): Record<string, string> {
  return authHeaders();
}

export interface DownloadProgress {
  /** Bytes recibidos hasta ahora. */
  loaded: number;
  /** Bytes totales, si el servidor los informo. */
  total: number | null;
}

/**
 * Descarga los bytes crudos de un archivo publico de Drive via el proxy.
 * Con `onProgress` se lee por chunks para poder mostrar avance: los dibujos
 * de esta carpeta llegan a 260 MB y sin esto la tarjeta se queda girando
 * medio minuto sin decir nada.
 */
export async function downloadDriveFile(
  fileId: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  const res = await fetchConTimeout(
    `${FUNCTIONS_URL}/concepts-drive?action=download&fileId=${encodeURIComponent(fileId)}`,
    { headers: authHeaders() },
    20_000
  );
  if (!res.ok) {
    let detalle = "";
    try {
      const cuerpo = await res.json();
      if (cuerpo?.error) detalle = `: ${cuerpo.error}`;
    } catch {
      // el cuerpo no era JSON, se ignora
    }
    throw new Error(`No se pudo descargar el archivo (${res.status})${detalle}`);
  }
  if (!onProgress || !res.body) return res.arrayBuffer();

  const lenHeader = res.headers.get("content-length");
  const total = lenHeader ? Number(lenHeader) : null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
