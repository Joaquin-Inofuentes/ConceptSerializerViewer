// Config publica del viewer. La anon key de Supabase esta pensada para
// usarse en el cliente (el acceso real se controla con RLS en la tabla).
export const SUPABASE_URL = "https://kuhcxzusnrttkywgalgk.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// Carpeta publica de Google Drive con archivos .concepts de ejemplo.
export const DRIVE_FOLDER_ID = "1lAlcv9-g6HmWVKkYMcrQQWBD3ew15i5Q";

export const THUMBNAIL_SIZE = 32;
