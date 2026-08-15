// ¿El tamaño con el que dibujamos cada recurso es el que el recurso tiene de
// verdad?
//
// El item declara un tamaño (w,h) y nosotros dibujamos el recurso dentro de
// ese rectangulo. Si ese tamaño no coincide con el tamaño NATIVO de la pagina
// del PDF, el plano sale estirado: la geometria del plano deja de coincidir
// con las anotaciones aunque la matriz de colocacion sea correcta. Esto
// compara los dos, recurso por recurso y pagina por pagina.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export interface FilaEscala {
  resourceId: string;
  pagina: number;
  esPdf: boolean;
  declarado: { w: number; h: number };
  nativo: { w: number; h: number } | null;
  /** Cuanto hay que multiplicar el nativo para llegar al declarado. */
  factor: { x: number; y: number } | null;
  /** Si los dos factores no son iguales, el plano sale deformado. */
  deformacion: number | null;
  aspectoDeclarado: number;
  aspectoNativo: number | null;
  numPaginas: number | null;
}

export async function auditarEscala(url: string): Promise<{ error?: string; filas: FilaEscala[] }> {
  const archivo = await openConceptsRemote(url, {});
  const doc = await archivo.parse();

  const colocaciones: Array<{ id: string; w: number; h: number }> = [];
  for (const l of doc.layers) for (const img of l.images)
    colocaciones.push({ id: img.resourceId, w: img.width, h: img.height });

  const filas: FilaEscala[] = [];
  for (const c of colocaciones) {
    const base = c.id.split("#")[0];
    const pagina = Number(c.id.split("#")[1] ?? 0);
    const blob = await doc.loadResource(c.id);
    let nativo: { w: number; h: number } | null = null;
    let numPaginas: number | null = null;
    let esPdf = false;
    if (blob) {
      const cabecera = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      esPdf = cabecera[0] === 0x25 && cabecera[1] === 0x50 && cabecera[2] === 0x44 && cabecera[3] === 0x46;
      if (esPdf) {
        const url2 = URL.createObjectURL(blob);
        const tarea = pdfjsLib.getDocument({ url: url2 });
        try {
          const pdf = await tarea.promise;
          numPaginas = pdf.numPages;
          const nP = Math.min(Math.max(1, pagina + 1), pdf.numPages);
          // rotation: 0, igual que al rasterizar.
          const vp = (await pdf.getPage(nP)).getViewport({ scale: 1, rotation: 0 });
          nativo = { w: vp.width, h: vp.height };
        } catch {
          nativo = null;
        } finally {
          void tarea.destroy();
          URL.revokeObjectURL(url2);
        }
      } else {
        const bm = await createImageBitmap(blob);
        nativo = { w: bm.width, h: bm.height };
        bm.close();
      }
    }
    const factor = nativo ? { x: c.w / nativo.w, y: c.h / nativo.h } : null;
    filas.push({
      resourceId: base.slice(0, 8),
      pagina,
      esPdf,
      declarado: { w: +c.w.toFixed(2), h: +c.h.toFixed(2) },
      nativo: nativo ? { w: +nativo.w.toFixed(2), h: +nativo.h.toFixed(2) } : null,
      factor: factor ? { x: +factor.x.toFixed(4), y: +factor.y.toFixed(4) } : null,
      deformacion: factor ? +(Math.max(factor.x / factor.y, factor.y / factor.x)).toFixed(4) : null,
      aspectoDeclarado: +(c.w / c.h).toFixed(4),
      aspectoNativo: nativo ? +(nativo.w / nativo.h).toFixed(4) : null,
      numPaginas,
    });
  }

  doc.close();
  archivo.close();
  return { filas };
}
