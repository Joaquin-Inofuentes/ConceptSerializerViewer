import { listDriveFolder, driveFileUrl, driveAuthHeaders } from "./driveClient";
import { upsertFolderCache, upsertThumbnail } from "./supabaseClient";
import { renderThumbnailDataUrl, thumbnailFromRemote } from "./thumbnail";
import { parseConceptsRemote } from "../VisorConcept/parser";
import { DRIVE_FOLDER_ID } from "../config";

export interface CrawlProgress {
  foldersDone: number;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
}

/**
 * Recorre TODO el arbol de Drive desde la raiz (sin limite de profundidad),
 * cachea el listado de cada carpeta en Supabase (para navegacion instantanea)
 * y regenera el thumbnail de cada archivo desde cero (fuerza la actualizacion,
 * no solo llena huecos). Pensado para correrse manualmente cuando hace falta
 * un refresco completo, no en cada carga de la app.
 */
export async function crawlAndCacheEverything(
  onProgress?: (p: CrawlProgress) => void
): Promise<CrawlProgress> {
  const progress: CrawlProgress = { foldersDone: 0, filesDone: 0, filesTotal: 0 };

  async function crawlFolder(folderId: string, name: string): Promise<void> {
    const listing = await listDriveFolder(folderId);
    await upsertFolderCache(folderId, name, listing.folders, listing.files);
    progress.foldersDone++;
    progress.filesTotal += listing.files.length;
    onProgress?.({ ...progress });

    for (const file of listing.files) {
      progress.currentFile = file.name;
      onProgress?.({ ...progress });
      try {
        const url = driveFileUrl(file.id);
        const headers = driveAuthHeaders();
        // Igual que la galeria: primero la vista previa embebida por rangos
        // (~110 KB), y solo si el archivo no la trae se dibuja el documento.
        // Antes esto bajaba cada archivo entero — 3,57 GB para recorrer la
        // carpeta completa.
        let thumbnail = await thumbnailFromRemote(url, headers);
        let bytesFuente = 0;
        if (!thumbnail) {
          const doc = await parseConceptsRemote(url, headers);
          try {
            thumbnail = await renderThumbnailDataUrl(doc);
            bytesFuente = doc.totalBytes;
          } finally {
            doc.close();
          }
        }
        await upsertThumbnail({
          drive_file_id: file.id,
          file_name: file.name,
          thumbnail_base64: thumbnail,
          source_size_bytes: bytesFuente,
          source_modified_at: file.modifiedAt,
        });
      } catch (e) {
        console.error("Error regenerando thumbnail", file.id, file.name, e);
      }
      progress.filesDone++;
      onProgress?.({ ...progress });
    }

    for (const sub of listing.folders) {
      await crawlFolder(sub.id, sub.name);
    }
  }

  await crawlFolder(DRIVE_FOLDER_ID, "Inicio");
  return progress;
}
