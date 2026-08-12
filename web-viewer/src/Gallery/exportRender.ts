import type { Document } from "../VisorConcept/parser";
import { loadResourceImages, buildRenderPlan, drawItems, EXPORT_SCALE } from "./renderCore";

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

  // Cada recurso PDF embebido se rasteriza al tamaño real que va a ocupar
  // en el canvas final (en px, ya multiplicado por EXPORT_SCALE), no a un
  // multiplo fijo arbitrario — si el PDF fuente es chico en su propio
  // espacio de pagina pero se dibuja grande en el documento, un multiplo
  // fijo se queda corto y sale pixelado sin importar el DPI del canvas.
  const targetSizes: Record<string, { width: number; height: number }> = {};
  plan.items.forEach((item) => {
    if (item.type === "image" && item.width && item.height) {
      // item.width/height son el tamaño NATIVO de la imagen, no el tamaño
      // dibujado — la matriz de transform (que puede achicar mucho, ej.
      // encoger una foto a un lugar chico del documento) es la que define
      // el tamaño real en pantalla/canvas. Sin esto se sobreestima cuanta
      // resolucion hace falta.
      const m = item.transform;
      const scaleX = m && m.length === 16 ? Math.hypot(m[0], m[1]) : 1;
      const scaleY = m && m.length === 16 ? Math.hypot(m[4], m[5]) : 1;
      const w = item.width * scaleX * EXPORT_SCALE;
      const h = item.height * scaleY * EXPORT_SCALE;
      const prev = targetSizes[item.resourceId];
      if (!prev || w * h > prev.width * prev.height) {
        targetSizes[item.resourceId] = { width: w, height: h };
      }
    }
  });
  // Piso fijo de 2.0 (no *EXPORT_SCALE): targetSizes ya incluye EXPORT_SCALE
  // en el tamaño pedido, multiplicar tambien el piso generaria canvases de
  // PDF gigantes e innecesarios sin ganar nitidez real.
  const images = await loadResourceImages(doc, 2.0, targetSizes);

  let { minX, minY, maxX, maxY } = plan;
  if (!plan.hasContent) {
    minX = 0; minY = 0; maxX = 200; maxY = 200;
  }

  const padding = 20;
  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const logicalWidth = Math.max(1, Math.round(maxX - minX));
  const logicalHeight = Math.max(1, Math.round(maxY - minY));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalWidth * EXPORT_SCALE);
  canvas.height = Math.round(logicalHeight * EXPORT_SCALE);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
  ctx.translate(-minX, -minY);
  drawItems(ctx, plan.items, images);
  ctx.restore();
  return { canvas, logicalWidth, logicalHeight };
}

export interface ExportEntry {
  name: string;
  canvas: HTMLCanvasElement;
  logicalWidth: number;
  logicalHeight: number;
}

/** Un grupo de entries; title=null cuando son archivos sueltos (sin
 * carpeta de origen), title="Nombre carpeta" cuando vinieron de descargar
 * una carpeta completa. */
export interface ExportSection {
  title: string | null;
  entries: ExportEntry[];
}

export interface ExportMetadata {
  userName: string;
  fecha: string;
  hora: string;
  ip: string;
}

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

  sections.forEach((section) => {
    if (showDividers && section.title) {
      startPage(PAGE_W, PAGE_H, "portrait");
      drawDividerPage(pdf, section.title);
    }
    section.entries.forEach(({ canvas, logicalWidth, logicalHeight }) => {
      const orientation = logicalWidth > logicalHeight ? "landscape" : "portrait";
      startPage(logicalWidth, logicalHeight, orientation);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      // El source (canvas) tiene mas pixeles que logicalWidth/Height
      // (EXPORT_SCALE, 150 DPI) — addImage lo encuadra al tamaño logico de
      // pagina, asi que el resultado sale nitido en vez de pixelado.
      pdf.addImage(dataUrl, "JPEG", 0, 0, logicalWidth, logicalHeight);
    });
  });

  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);

  pdf.setProperties({
    title: "ConceptSerializer - Exportacion",
    subject: `Exportado por ${metadata.userName} el ${metadata.fecha} ${metadata.hora}`,
    author: metadata.userName,
    keywords: `ip:${metadata.ip}, archivos:${totalFiles}`,
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
    section.entries.forEach(({ name, canvas }) => {
      let fileName = `${name}.jpg`;
      let n = 2;
      while (usedNames.has(fileName)) {
        fileName = `${name} (${n}).jpg`;
        n++;
      }
      usedNames.add(fileName);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      target.file(fileName, dataUrl.split(",")[1], { base64: true });
    });
  });

  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);
  const metaLines = [
    `Usuario: ${metadata.userName}`,
    `Fecha: ${metadata.fecha}`,
    `Hora: ${metadata.hora}`,
    `IP: ${metadata.ip}`,
    `Total de archivos: ${totalFiles}`,
    "",
    "Contenido:",
    ...sections.flatMap((s) => [
      s.title ? `${s.title}/` : "Archivos sueltos:",
      ...s.entries.map((e) => `  - ${e.name}`),
    ]),
  ];
  zip.file("metadata.txt", metaLines.join("\n"));

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `concepts-${totalFiles}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}
