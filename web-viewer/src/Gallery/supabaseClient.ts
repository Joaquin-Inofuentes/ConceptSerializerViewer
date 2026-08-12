import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, THUMBNAIL_SIZE } from "../config";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

  const { data, error } = await supabase
    .from("concept_thumbnails")
    .select("drive_file_id, file_name, thumbnail_base64, updated_at")
    .in("drive_file_id", ids);

  if (error) {
    console.error("Error leyendo cache de thumbnails:", error);
    return map;
  }
  (data || []).forEach((row) => map.set(row.drive_file_id, row as ThumbnailRow));
  return map;
}

/** Sube (o actualiza) la miniatura 32x32 generada para un archivo. */
export async function upsertThumbnail(row: {
  drive_file_id: string;
  file_name: string;
  thumbnail_base64: string;
  source_size_bytes: number;
}): Promise<void> {
  const { error } = await supabase.from("concept_thumbnails").upsert({
    drive_file_id: row.drive_file_id,
    file_name: row.file_name,
    thumbnail_base64: row.thumbnail_base64,
    source_size_bytes: row.source_size_bytes,
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("Error subiendo thumbnail a Supabase:", error);
}
