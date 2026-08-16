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
        dibujarRecurso(ctx, recurso, item.width, item.height, item.isPhoto);
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
  /** JPEG ya codificado. NO se guarda el canvas: en una descarga de 20
   * dibujos, retener 20 canvases de export (decenas de MB cada uno) es
   * cientos de MB vivos a la vez y en un telefono mata la pestaña. El JPEG
   * de la misma pagina pesa ~1 MB. */
  dataUrl: string;
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
  const dataUrl = canvas.toDataURL("image/jpeg", calidad);
  canvas.width = 0;
  canvas.height = 0;
  return { name, dataUrl, logicalWidth, logicalHeight };
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
    section.entries.forEach(({ dataUrl, logicalWidth, logicalHeight }) => {
      const orientation = logicalWidth > logicalHeight ? "landscape" : "portrait";
      startPage(logicalWidth, logicalHeight, orientation);
      // El JPEG tiene mas pixeles que logicalWidth/Height (EXPORT_SCALE) —
      // addImage lo encuadra al tamaño logico de pagina, asi que el resultado
      // sale nitido en vez de pixelado.
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
    section.entries.forEach(({ name, dataUrl }) => {
      let fileName = `${name}.jpg`;
      let n = 2;
      while (usedNames.has(fileName)) {
        fileName = `${name} (${n}).jpg`;
        n++;
      }
      usedNames.add(fileName);
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
