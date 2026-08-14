// Audita, recurso por recurso, si el tamaño que el parser cree que tiene una
// imagen coincide con el REAL del archivo embebido.
//
// Es la comprobacion que decide si los planos se ven estirados: el bitmap se
// dibuja con `drawImage(img, 0, 0, item.width, item.height)`, o sea que se
// ESTIRA hasta ese ancho/alto. Si `item.width/height` no tiene la misma
// proporcion que la pagina del PDF (o que la foto), el plano sale deformado y
// las anotaciones dejan de caer donde corresponde.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export async function auditarImagenes(url: string, headers: Record<string, string>) {
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();

  // Bbox de los trazos: las anotaciones a mano.
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let nTrazos = 0;
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      nTrazos++;
      sMinX = Math.min(sMinX, s.bbox.minX);
      sMinY = Math.min(sMinY, s.bbox.minY);
      sMaxX = Math.max(sMaxX, s.bbox.maxX);
      sMaxY = Math.max(sMaxY, s.bbox.maxY);
    }
  }

  const recursos: any[] = [];
  for (const l of doc.layers) {
    for (const img of l.images) {
      const blob = await doc.loadResource(img.resourceId);
      if (!blob) {
        recursos.push({ id: img.resourceId.slice(0, 8), error: "no se pudo leer" });
        continue;
      }
      const header = await blob.slice(0, 5).text();
      const esPdf = header === "%PDF-";

      // Tamaño REAL del recurso.
      let realW = 0, realH = 0, extra: any = {};
      if (esPdf) {
        const tarea = pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
        const pdf = await tarea.promise;
        const page = await pdf.getPage(1);
        // SIN rotar: es el espacio en el que Concepts guarda la geometria del
        // recurso (la rotacion va en la matriz del elemento) y por lo tanto
        // el que usa el rasterizador. Comparar contra el viewport rotado
        // —lo que pdf.js devuelve por defecto— da un falso "deformado".
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        const vpRotado = page.getViewport({ scale: 1 });
        realW = vp.width;
        realH = vp.height;
        extra = {
          paginas: pdf.numPages,
          rotatePdf: (page as any).rotate,
          rotado: `${Math.round(vpRotado.width)}x${Math.round(vpRotado.height)}`,
          view: (page as any).view,
        };
        void tarea.destroy();
      } else {
        const bm = await createImageBitmap(blob);
        realW = bm.width;
        realH = bm.height;
        bm.close();
      }

      const m = img.transform;
      const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
      const sx = Math.hypot(a, b);
      const sy = Math.hypot(c, d);

      // Caja que ocupa en el documento, con la matriz aplicada.
      const esquinas = [[0, 0], [img.width, 0], [0, img.height], [img.width, img.height]].map(
        ([x, y]) => [a * x + c * y + e, b * x + d * y + f]
      );
      const xs = esquinas.map((p) => p[0]);
      const ys = esquinas.map((p) => p[1]);
      const cajaW = Math.max(...xs) - Math.min(...xs);
      const cajaH = Math.max(...ys) - Math.min(...ys);

      const aspectoDeclarado = img.width / img.height;
      const aspectoReal = realW / realH;

      recursos.push({
        id: img.resourceId.slice(0, 8),
        tipo: esPdf ? "pdf" : "bitmap",
        declarado: `${Math.round(img.width)}x${Math.round(img.height)}`,
        real: `${Math.round(realW)}x${Math.round(realH)}`,
        aspectoDeclarado: +aspectoDeclarado.toFixed(4),
        aspectoReal: +aspectoReal.toFixed(4),
        // >1 significa que se lo esta estirando horizontalmente respecto a su
        // forma real; <1, verticalmente. 1.00 = sin deformar.
        deformacion: +(aspectoDeclarado / aspectoReal).toFixed(4),
        escala: `${sx.toFixed(3)}x${sy.toFixed(3)}`,
        rotacion: +((Math.atan2(b, a) * 180) / Math.PI).toFixed(2),
        caja: `${Math.round(cajaW)}x${Math.round(cajaH)}`,
        traslacion: `${Math.round(e)},${Math.round(f)}`,
        ...extra,
      });
    }
  }

  const r = {
    trazos: nTrazos,
    bboxTrazos:
      nTrazos > 0
        ? `${Math.round(sMinX)},${Math.round(sMinY)} .. ${Math.round(sMaxX)},${Math.round(sMaxY)}`
        : "sin trazos",
    recursos,
  };
  doc.close();
  archivo.close();
  return r;
}
