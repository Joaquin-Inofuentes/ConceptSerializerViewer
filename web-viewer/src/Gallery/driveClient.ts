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

function authHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

/**
 * Lista subcarpetas y archivos de una carpeta publica de Google Drive
 * (raiz o cualquier subcarpeta), sin API key. Solo el id de la carpeta
 * RAIZ se hardcodea en config.ts; esto se puede llamar con el id de
 * cualquier subcarpeta descubierta en vivo.
 */
export async function listDriveFolder(folderId: string): Promise<DriveListing> {
  const res = await fetch(
    `${FUNCTIONS_URL}/concepts-drive?action=list&folderId=${encodeURIComponent(folderId)}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`No se pudo listar la carpeta de Drive (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Error listando la carpeta de Drive");
  return { folders: data.folders || [], files: data.files || [] };
}

/** Descarga los bytes crudos de un archivo publico de Drive via el proxy. */
export async function downloadDriveFile(fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `${FUNCTIONS_URL}/concepts-drive?action=download&fileId=${encodeURIComponent(fileId)}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (${res.status})`);
  return res.arrayBuffer();
}
