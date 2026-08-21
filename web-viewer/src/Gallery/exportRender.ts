import type { Document } from "../VisorConcept/parser";
import {
  proveedorEnStreaming,
  buildRenderPlan,
  dibujarRecurso,
  dibujarTexto,
  drawnSizes,
  safeExportScale,
} from "./renderCore";
import { getBudgets } from "../device";
import type { ExportMetadata } from "./exportMetadata";

export interface RenderedCanvas {
  canvas: HTMLCanvasElement;
  /** Tamaño logico (sin el supersampling de EXPORT_SCALE) — es el que hay
   * que usar para el tamaño de pagina/imagen del PDF, no canvas.width/height. */
  logicalWidth: number;
  logicalHeight: number;
}

/** Renderiza el documento completo (todas las capas) a un canvas encuadrado
 * al contenido, a EXPORT_SCALE (150 DPI) para que salga nitido. */
export async function renderDocumentCanvas(doc: Document): Promise<RenderedCanvas> {
  const plan = buildRenderPlan(doc);

  let { minX, minY, maxX, maxY } = plan;
  if (!plan.hasContent) {
    minX = 0; minY = 0; maxX = 200; maxY = 200;
  }

  const padding = 20;
  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const logicalWidth = Math.max(1, Math.round(maxX - minX));
  const logicalHeight = Math.max(1, Math.round(maxY - minY));
  // Escala real del export: EXPORT_SCALE salvo que a 600 DPI el canvas no
  // entre en los limites del navegador (dibujo muy grande), en cuyo caso se
  // baja lo justo — antes eso daba directamente una hoja en blanco.
  const scale = safeExportScale(logicalWidth, logicalHeight);

  // Cada recurso embebido se rasteriza al tamaño REAL en px que va a ocupar
  // en este canvas (tamaño dibujado x escala del export), no a un multiplo
  // fijo: un multiplo fijo se queda corto si el recurso se dibuja grande, y
  // desperdicia decenas de megapixeles si se dibuja chico.
  const dibujado = drawnSizes(doc);
  const targets: Record<string, { width: number; height: number }> = {};
  Object.entries(dibujado).forEach(([id, size]) => {
    targets[id] = { width: size.width * scale, height: size.height * scale };
  });
  const budgets = getBudgets();
  // De a uno y soltando: al descargar varias carpetas se encadenan muchos
  // documentos, y retener los recursos de cada uno mientras existe su canvas
  // de export (decenas de MB) es lo que hacia que la pestaña muriera a mitad
  // de una descarga larga.
  const proveedor = proveedorEnStreaming(doc, targets, {
    quality: 1,
    maxPixels: Math.min(40_000_000, budgets.maxExportPixels),
    maxTotalPixels: budgets.maxExportPixels,
    minSide: 256,
    timeoutMs: 60000,
    sinCache: true,
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalWidth * scale);
  canvas.height = Math.round(logicalHeight * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);
  try {
    for (const item of plan.items) {
      if (item.type === "image") {
        const recurso = await proveedor.obtener(item.resourceId);
        if (!recurso) continue;
        ctx.save();
        const m = item.transform;
        if (m && m.length === 16) ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
        dibujarRecurso(ctx, recurso, item.width, item.height);
        ctx.restore();
      } else if (item.type === "text") {
        dibujarTexto(ctx, item);
      } else {
        ctx.strokeStyle = item.color;
        ctx.globalAlpha = item.alpha;
        ctx.lineWidth = item.width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(item.path);
      }
    }
  } finally {
    proveedor.liberar();
  }
  ctx.restore();
  // El documento NO se cierra aca a proposito: "renderizar" no deberia
  // invalidar el documento que te pasaron. Cerrarlo es responsabilidad de
  // quien lo abrio (ver `handleDownload` en Gallery.tsx).
  return { canvas, logicalWidth, logicalHeight };
}

export interface ExportEntry {
  name: string;
  /**
   * JPEG ya codificado, como Blob (no data URL). NO se guarda el canvas: en
   * una descarga de 20 dibujos, retener 20 canvases de export (decenas de
   * MB cada uno) es cientos de MB vivos a la vez y en un telefono mata la
   * pestaña. El JPEG de la misma pagina pesa ~1 MB.
   *
   * Blob y no data URL: `canvas.toBlob()` es asincronico (no bloquea el
   * hilo principal codificando) y el Blob resultante pesa ~25% menos en RAM
   * que su equivalente en base64 -- con 20 archivos exportandose a la vez
   * (`ExportEntry[]` completo vive hasta que termina el PDF/ZIP), esa
   * diferencia es real. `exportSectionsAsZip` lo entrega directo a JSZip
   * (que acepta Blob); `exportSectionsAsPdf` lo convierte a data URL UNO
   * POR VEZ justo antes de `addImage` (jsPDF no acepta Blob), asi que nunca
   * hay mas de un data URL vivo a la vez en vez de todos desde el arranque.
   */
  blob: Blob;
  logicalWidth: number;
  logicalHeight: number;
}

/** Renderiza y codifica de una, liberando el canvas enseguida. Es lo que hay
 * que usar para armar varias paginas sin acumular memoria. */
export async function renderDocumentEntry(
  doc: Document,
  name: string,
  calidad = 0.92
): Promise<ExportEntry> {
  const { canvas, logicalWidth, logicalHeight } = await renderDocumentCanvas(doc);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", calidad));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error(`No se pudo codificar la exportacion de "${name}"`);
  return { name, blob, logicalWidth, logicalHeight };
}

/** Convierte un Blob a data URL. Solo lo necesita jsPDF (`addImage` no
 * acepta Blob); se llama de a uno, justo antes de usarlo, para no tener
 * mas de un data URL vivo a la vez. */
function blobADataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el blob"));
    reader.readAsDataURL(blob);
  });
}

/** Un grupo de entries; title=null cuando son archivos sueltos (sin
 * carpeta de origen), title="Nombre carpeta" cuando vinieron de descargar
 * una carpeta completa. */
export interface ExportSection {
  title: string | null;
  entries: ExportEntry[];
}

// Antes habia una copia DUPLICADA de esta interfaz aca, separada de la de
// `exportMetadata.ts` (con su propio campo `ip`, que ya no existe del lado
// de quien la produce). Reexportar el mismo tipo evita que las dos vuelvan
// a divergir.
export type { ExportMetadata };

const PAGE_W = 800;
const PAGE_H = 1000;

function drawDividerPage(pdf: any, title: string) {
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
  pdf.setDrawColor(222, 226, 230);
  pdf.setLineWidth(1);
  pdf.rect(30, 30, PAGE_W - 60, PAGE_H - 60);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(34);
  pdf.setTextColor(20, 20, 20);
  // Tratada como un titulo markdown "# {title}": va sola en su pagina,
  // separando visualmente el contenido de cada carpeta dentro del PDF.
  pdf.text(`# ${title}`, PAGE_W / 2, PAGE_H / 2 - 10, { align: "center", maxWidth: PAGE_W * 0.8 });
  pdf.setDrawColor(13, 110, 253);
  pdf.setLineWidth(2);
  pdf.line(PAGE_W * 0.3, PAGE_H / 2 + 20, PAGE_W * 0.7, PAGE_H / 2 + 20);
}

/** Arma un unico PDF con una pagina por dibujo. Si hay mas de una seccion
 * (o una seccion con nombre, ej. una carpeta descargada entera), antepone
 * una pagina divisoria por seccion a modo de titulo markdown "# Carpeta".
 * La metadata (usuario/fecha/hora/IP) va solo en las propiedades del PDF,
 * no como una hoja extra. */
export async function exportSectionsAsPdf(sections: ExportSection[], metadata: ExportMetadata): Promise<void> {
  // Hoy el unico llamador (`Gallery.tsx`) ya filtra `totalFiles === 0` antes
  // de invocar esto, pero esa es una precondicion IMPLICITA de esta funcion
  // exportada, no algo que el tipo garantice. Sin ningun `entries.length`,
  // `pdf` nunca se inicializa (`startPage` no se llama nunca) y
  // `pdf.setProperties`/`pdf.save` mas abajo revientan contra null.
  if (sections.every((s) => s.entries.length === 0)) {
    throw new Error("No hay nada para exportar (todas las secciones estan vacias).");
  }
  const { default: JsPDF } = await import("jspdf");
  let pdf: any = null;
  const showDividers = sections.length > 1 || (sections.length === 1 && !!sections[0].title);

  const startPage = (w: number, h: number, orientation: "portrait" | "landscape") => {
    if (!pdf) {
      pdf = new JsPDF({ orientation, unit: "px", format: [w, h] });
    } else {
      pdf.addPage([w, h], orientation);
    }
  };

  // Secuencial (no Promise.all): son data URLs de varios MB cada una, y la
  // idea de guardar Blob en vez de data URL en `ExportEntry` es justamente
  // no tener mas de una viva a la vez.
  for (const section of sections) {
    if (showDividers && section.title) {
      startPage(PAGE_W, PAGE_H, "portrait");
      drawDividerPage(pdf, section.title);
    }
    for (const { blob, logicalWidth, logicalHeight } of section.entries) {
      const orientation = logicalWidth > logicalHeight ? "landscape" : "portrait";
      startPage(logicalWidth, logicalHeight, orientation);
      const dataUrl = await blobADataUrl(blob);
      // El JPEG tiene mas pixeles que logicalWidth/Height (EXPORT_SCALE) —
      // addImage lo encuadra al tamaño logico de pagina, asi que el resultado
      // sale nitido en vez de pixelado.
      pdf.addImage(dataUrl, "JPEG", 0, 0, logicalWidth, logicalHeight);
    }
  }

  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);

  pdf.setProperties({
    title: "ConceptSerializer - Exportacion",
    subject: `Exportado por ${metadata.userName} el ${metadata.fecha} ${metadata.hora}`,
    author: metadata.userName,
    keywords: `archivos:${totalFiles}`,
    creator: "ConceptSerializer",
  });

  pdf.save(`concepts-${totalFiles}.pdf`);
}

/** Arma un zip con un JPG por dibujo. Las secciones con nombre (carpetas
 * descargadas enteras) se guardan como subcarpetas reales dentro del zip.
 * Incluye metadata.txt en la raiz con usuario/fecha/hora/IP y el listado
 * completo de archivos. */
export async function exportSectionsAsZip(sections: ExportSection[], metadata: ExportMetadata): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  sections.forEach((section) => {
    const target = section.title ? zip.folder(section.title) || zip : zip;
    const usedNames = new Set<string>();
    section.entries.forEach(({ name, blob }) => {
      let fileName = `${name}.jpg`;
      let n = 2;
      while (usedNames.has(fileName)) {
        fileName = `${name} (${n}).jpg`;
        n++;
      }
      usedNames.add(fileName);
      // Blob directo: JSZip lo acepta sin pasar por base64 (mas liviano en
      // RAM: sin el ~33% extra de codificar a texto, y sin el split(",")[1]
      // de antes).
      target.file(fileName, blob);
    });
  });

  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);
  const metaLines = [
    `Usuario: ${metadata.userName}`,
    `Fecha: ${metadata.fecha}`,
    `Hora: ${metadata.hora}`,
    `Total de archivos: ${totalFiles}`,
    "",
    "Contenido:",
    ...sections.flatMap((s) => [
      s.title ? `${s.title}/` : "Archivos sueltos:",
      ...s.entries.map((e) => `  - ${e.name}`),
    ]),
  ];
  zip.file("metadata.txt", metaLines.join("\n"));

  // STORE, no DEFLATE (el default de JSZip): los JPEGs que se estan
  // guardando ya vienen comprimidos, y aplicarles DEFLATE encima es CPU
  // pura en el hilo principal a cambio de ~0% de ahorro de tamaño --
  // literalmente el peor trato posible en un dispositivo de gama baja.
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `concepts-${totalFiles}.zip`;
  // El link tiene que estar en el DOM para que Firefox dispare la descarga
  // de forma confiable, y revocar el ObjectURL DE INMEDIATO tras el click()
  // es una carrera conocida: en Safari/Firefox moviles el navegador todavia
  // no empezo a leer el blob en ese instante, y la descarga puede fallar o
  // bajar truncada sin ningun error visible. Se difiere el revoke y se
  // limpia el link del DOM despues.
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}
