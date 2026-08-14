// ¿El visor dibuja el documento cabeza abajo?
//
// La pregunta parecia de "a ojo", pero se puede contestar con un numero: el
// texto de un plano corre de izquierda a derecha. Si se toma la direccion de
// las lineas de texto DENTRO del PDF y se la pasa por la matriz con la que el
// documento coloca ese plano, el resultado dice hacia donde corre el texto YA
// dibujado en el lienzo. Si apunta a la izquierda, el plano se ve al reves.
//
// Se mira el texto y no la imagen porque es la unica senal inequivoca de cual
// es el "arriba" que quiso el que hizo el plano.

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export async function sentidoTexto(url: string, headers: Record<string, string>, maxRecursos = 6) {
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();

  // Colocaciones con recurso, de la mas grande a la mas chica.
  const puestas: Array<{ id: string; m: number[]; area: number }> = [];
  for (const l of doc.layers) {
    for (const img of l.images) {
      const m = img.transform;
      const sx = Math.hypot(m[0], m[1]);
      const sy = Math.hypot(m[4], m[5]);
      puestas.push({ id: img.resourceId, m, area: img.width * sx * img.height * sy });
    }
  }
  puestas.sort((a, b) => b.area - a.area);

  const vistos = new Set<string>();
  const filas: Array<{
    id: string;
    rotatePdf: number;
    rotacionElemento: number;
    /** Hacia donde corre el texto una vez dibujado: +1 derecha, -1 izquierda. */
    sentidoX: number;
    derecho: boolean;
    items: number;
  }> = [];

  for (const p of puestas) {
    if (filas.length >= maxRecursos) break;
    if (vistos.has(p.id)) continue;
    vistos.add(p.id);
    const blob = await doc.loadResource(p.id);
    if (!blob) continue;
    if ((await blob.slice(0, 5).text()) !== "%PDF-") continue;

    const tarea = pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
    try {
      const pdf = await tarea.promise;
      const page = await pdf.getPage(1);
      // MISMO viewport que usa el rasterizador del visor.
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const texto = await page.getTextContent();

      // Direccion media de las lineas de texto, en el espacio del viewport.
      let dx = 0;
      let dy = 0;
      let n = 0;
      for (const item of texto.items as any[]) {
        const t = item.transform;
        if (!t || item.str?.trim?.() === "") continue;
        // t = [a,b,c,d,e,f] en espacio PDF; se lleva al viewport.
        const [a, b] = vp.transform;
        // Direccion del avance del texto: la primera columna de la matriz del
        // item, rotada por el viewport (solo importa el signo, asi que alcanza
        // con la parte lineal).
        const vx = t[0] * vp.transform[0] + t[1] * vp.transform[2];
        const vy = t[0] * vp.transform[1] + t[1] * vp.transform[3];
        void a;
        void b;
        const largo = Math.hypot(vx, vy) || 1;
        const peso = (item.str || "").length;
        dx += (vx / largo) * peso;
        dy += (vy / largo) * peso;
        n += peso;
      }
      if (n === 0) continue;
      dx /= n;
      dy /= n;

      // Ahora por la matriz del elemento (solo la parte lineal).
      const m = p.m;
      const fx = m[0] * dx + m[4] * dy;
      const fy = m[1] * dx + m[5] * dy;

      filas.push({
        id: p.id.slice(0, 8),
        rotatePdf: (page as any).rotate ?? 0,
        rotacionElemento: +((Math.atan2(m[1], m[0]) * 180) / Math.PI).toFixed(1),
        sentidoX: +fx.toFixed(3),
        // Derecho = el texto corre hacia la derecha en el lienzo.
        derecho: fx > 0,
        items: n,
      });
      void fy;
    } catch {
      /* PDF que no se pudo abrir: no aporta */
    } finally {
      void tarea.destroy();
    }
  }

  doc.close();
  archivo.close();
  const derechos = filas.filter((f) => f.derecho).length;
  return { filas, derechos, total: filas.length };
}
