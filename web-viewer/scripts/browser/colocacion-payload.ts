// Devuelve, para cada imagen del documento, DONDE la coloca el visor de
// verdad (centro en coordenadas de canvas) y con que orientacion EXIF la
// dibuja. Es lo que `verificar-colocacion.mjs` contrasta contra el archivo.
//
// Solo parsea: no rasteriza nada pesado salvo la lectura de cabecera EXIF de
// las fotos, asi que corre rapido sobre muchos archivos.
import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { orientacionExifDe } from "../../src/Gallery/renderCore";

export interface ColocacionImagen {
  resourceId: string;
  /** Centro de la caja de la imagen, en coordenadas de canvas. */
  centro: [number, number];
  ancho: number;
  alto: number;
  isPhoto?: boolean;
  /** Orientacion EXIF leida del recurso (solo fotos). */
  exif?: number;
}

export async function colocacionDeImagenes(url: string): Promise<ColocacionImagen[]> {
  const archivo = await openConceptsRemote(url, {});
  const doc = await archivo.parse();
  const salida: ColocacionImagen[] = [];
  try {
    for (const capa of doc.layers) {
      for (const img of capa.images) {
        const m = img.transform;
        // El centro de la caja, pasado por la matriz de colocacion.
        const cx = m[0] * (img.width / 2) + m[4] * (img.height / 2) + m[12];
        const cy = m[1] * (img.width / 2) + m[5] * (img.height / 2) + m[13];
        let exif: number | undefined;
        if (img.isPhoto) {
          const blob = await doc.loadResource(img.resourceId);
          if (blob) exif = await orientacionExifDe(blob);
        }
        salida.push({
          resourceId: img.resourceId,
          centro: [cx, cy],
          ancho: img.width,
          alto: img.height,
          isPhoto: img.isPhoto,
          exif,
        });
      }
    }
  } finally {
    doc.close();
    archivo.close();
  }
  return salida;
}
