/**
 * Acceso a Supabase por REST directo (PostgREST), sin el SDK.
 *
 * El SDK `@supabase/supabase-js` pesa ~33 KB gzip y trae realtime, auth y
 * storage — nada de lo cual se usa aca: los cuatro accesos son un select con
 * filtro `in`, dos upserts y un insert, o sea llamadas HTTP con dos headers.
 * En una conexion 3G de un telefono viejo, esos 33 KB son medio segundo de
 * arranque regalado.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, THUMBNAIL_SIZE } from "../config";
import type { DriveFolderRef, DriveFile } from "./driveClient";

const REST = `${SUPABASE_URL}/rest/v1`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function pedir<T>(url: string, init: RequestInit, etiqueta: string): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      console.error(`Supabase ${etiqueta}: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    if (res.status === 204) return null;
    const texto = await res.text();
    return texto ? (JSON.parse(texto) as T) : null;
  } catch (e) {
    console.error(`Supabase ${etiqueta}:`, e);
    return null;
  }
}

export interface ThumbnailRow {
  drive_file_id: string;
  file_name: string;
  thumbnail_base64: string;
  updated_at: string;
}

/** Trae del cache de Supabase las miniaturas ya generadas para estos ids. */
export async function fetchCachedThumbnails(
  ids: string[]
): Promise<Map<string, ThumbnailRow>> {
  const map = new Map<string, ThumbnailRow>();
  if (ids.length === 0) return map;

  // PostgREST: in.(a,b,c). Los ids de Drive son alfanumericos con - y _, sin
  // comas ni comillas, pero se citan igual por las dudas.
  const lista = ids.map((id) => `"${id}"`).join(",");
  const url =
    `${REST}/concept_thumbnails` +
    `?select=drive_file_id,file_name,thumbnail_base64,updated_at` +
    `&drive_file_id=in.(${encodeURIComponent(lista)})`;

  const data = await pedir<ThumbnailRow[]>(url, { headers: headers() }, "leer thumbnails");
  (data || []).forEach((row) => map.set(row.drive_file_id, row));
  return map;
}

/** Sube (o actualiza) la miniatura generada para un archivo. */
export async function upsertThumbnail(row: {
  drive_file_id: string;
  file_name: string;
  thumbnail_base64: string;
  source_size_bytes: number;
}): Promise<void> {
  await pedir(
    `${REST}/concept_thumbnails`,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        drive_file_id: row.drive_file_id,
        file_name: row.file_name,
        thumbnail_base64: row.thumbnail_base64,
        source_size_bytes: row.source_size_bytes,
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        updated_at: new Date().toISOString(),
      }),
    },
    "guardar thumbnail"
  );
}

export interface FolderCacheRow {
  folder_id: string;
  name: string;
  subfolders: DriveFolderRef[];
  files: DriveFile[];
  updated_at: string;
}

/**
 * Trae TODO el arbol de carpetas cacheado en un solo query (son solo ids y
 * nombres, liviano). Con esto la Gallery puede navegar entre carpetas ya
 * visitadas sin volver a pegarle a Drive.
 */
export async function fetchAllFolderCache(): Promise<Map<string, FolderCacheRow>> {
  const map = new Map<string, FolderCacheRow>();
  const data = await pedir<FolderCacheRow[]>(
    `${REST}/drive_folder_cache?select=*`,
    { headers: headers() },
    "leer cache de carpetas"
  );
  (data || []).forEach((row) => map.set(row.folder_id, row));
  return map;
}

/** Guarda (o actualiza) el listado de una carpeta puntual en el cache. */
export async function upsertFolderCache(
  folderId: string,
  name: string,
  subfolders: DriveFolderRef[],
  files: DriveFile[]
): Promise<void> {
  await pedir(
    `${REST}/drive_folder_cache`,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        folder_id: folderId,
        name,
        subfolders,
        files,
        updated_at: new Date().toISOString(),
      }),
    },
    "guardar cache de carpeta"
  );
}

/**
 * Busca un archivo por id en el arbol de carpetas cacheado y devuelve su
 * nombre y su ruta.
 *
 * Sirve para los links directos (`?file=<id>`): sin esto la app no sabe como
 * se llama el dibujo ni donde vive, y terminaba mostrando el id crudo como
 * nombre y una URL sin carpetas.
 */
export async function ubicarArchivo(
  fileId: string
): Promise<{ nombre: string; ruta: string[] } | null> {
  const arbol = await fetchAllFolderCache();
  if (arbol.size === 0) return null;

  // Padre de cada carpeta, para poder reconstruir la ruta hacia arriba.
  const padre = new Map<string, string>();
  arbol.forEach((fila) => {
    fila.subfolders.forEach((sub) => padre.set(sub.id, fila.folder_id));
  });

  for (const fila of arbol.values()) {
    const archivo = fila.files.find((f) => f.id === fileId);
    if (!archivo) continue;
    const ruta: string[] = [];
    let actual: string | undefined = fila.folder_id;
    // Se sube hasta la raiz (la raiz no tiene padre y no entra en la ruta).
    while (actual && padre.has(actual)) {
      ruta.unshift(arbol.get(actual)?.name || "");
      actual = padre.get(actual);
    }
    return { nombre: archivo.name.replace(/\.concepts$/i, "").trim(), ruta: ruta.filter(Boolean) };
  }
  return null;
}

/** Inserta un evento de uso (abrir/cerrar/descargar). */
export async function insertEvento(fila: Record<string, unknown>): Promise<void> {
  await pedir(
    `${REST}/visor_eventos`,
    {
      method: "POST",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(fila),
    },
    "registrar metrica de uso"
  );
}
