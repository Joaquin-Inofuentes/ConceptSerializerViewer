/**
 * Rasteriza PDFs y fotos FUERA del hilo principal.
 *
 * Es la diferencia entre "el dibujo se congela 24 segundos mientras cargan
 * las fotos" y "podes pan/zoom mientras aparecen". pdf.js hace un trabajo de
 * CPU intenso (~1,5 s por PDF en desktop, ~9 s en un telefono de gama baja),
 * y hacerlo en el hilo principal bloquea el render loop y los gestos.
 *
 * Devuelve ImageBitmap transferibles (coste cero al pasarlos al main thread).
 */

import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// Nota: se probo compartir UN solo `PDFWorker` entre todos los documentos
// para ahorrar los ~300 ms de arranque por PDF. No sirve con esta version de
// pdf.js: la unica forma de liberar el buffer del PDF es `loadingTask
// .destroy()`, y eso termina tambien el worker que se le paso, asi que el
// siguiente documento levanta uno nuevo igual (medido: 22 workers para 10
// PDFs, con y sin worker compartido). Entre "ahorrar el arranque" y "liberar
// la RAM del PDF", en un telefono de 1 GB gana liberar la RAM.

interface PedidoRaster {
  id: number;
  resourceId: string;
  blob: Blob;
  /** Tamaño destino en px reales, ya clampeado por el que llama. */
  width: number;
  height: number;
  smoothing: ImageSmoothingQuality;
}

async function rasterizar(p: PedidoRaster): Promise<ImageBitmap> {
  const header = await p.blob.slice(0, 5).text();

  if (header === "%PDF-") {
    const data = new Uint8Array(await p.blob.arrayBuffer());
    // `destroy()` vive en el loading task, no en el documento: hay que
    // guardarse la referencia para poder liberar el worker de pdf.js y el
    // buffer del PDF, que con 19 planos de varios MB es RAM que no vuelve
    // sola.
    const tarea = pdfjsLib.getDocument({ data });
    const pdf = await tarea.promise;
    try {
      const page = await pdf.getPage(1);
      const nativo = page.getViewport({ scale: 1 });
      const canvas = new OffscreenCanvas(p.width, p.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("sin contexto 2d en el worker");
      // Escala NO uniforme via el `transform` de pdf.js: el recurso se dibuja
      // despues estirado a un ancho/alto arbitrario, asi que rasterizarlo con
      // una escala unica (forzosamente la mayor) generaba canvases absurdos
      // (15278x5042 = 77 Mpx para algo que se muestra a 266x807).
      await (page as any).render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: nativo,
        transform: [p.width / nativo.width, 0, 0, p.height / nativo.height, 0, 0],
      }).promise;
      const bitmap = canvas.transferToImageBitmap();
      page.cleanup();
      return bitmap;
    } finally {
      void tarea.destroy();
    }
  }

  // Imagen raster: createImageBitmap decodifica y reescala nativamente, sin
  // pasar por un canvas intermedio.
  const base = await createImageBitmap(p.blob);
  if (p.width >= base.width && p.height >= base.height) return base;
  const chico = await createImageBitmap(base, {
    resizeWidth: p.width,
    resizeHeight: p.height,
    resizeQuality: p.smoothing === "high" ? "high" : "medium",
  });
  base.close();
  return chico;
}

self.onmessage = async (e: MessageEvent<PedidoRaster>) => {
  const p = e.data;
  try {
    const bitmap = await rasterizar(p);
    (self as unknown as Worker).postMessage(
      { id: p.id, resourceId: p.resourceId, bitmap, width: bitmap.width, height: bitmap.height },
      [bitmap as unknown as Transferable]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: p.id,
      resourceId: p.resourceId,
      error: String(err).slice(0, 300),
    });
  }
};
