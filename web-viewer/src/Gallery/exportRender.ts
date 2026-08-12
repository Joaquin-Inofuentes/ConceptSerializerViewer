import type { Document } from "../VisorConcept/parser";
import { loadResourceImages, buildRenderPlan, drawItems } from "./renderCore";

/** Renderiza el documento completo (todas las capas) a un canvas encuadrado al contenido. */
export async function renderDocumentCanvas(doc: Document): Promise<HTMLCanvasElement> {
  const images = await loadResourceImages(doc);
  const plan = buildRenderPlan(doc);

  let { minX, minY, maxX, maxY } = plan;
  if (!plan.hasContent) {
    minX = 0; minY = 0; maxX = 200; maxY = 200;
  }

  const padding = 20;
  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const width = Math.max(1, Math.round(maxX - minX));
  const height = Math.max(1, Math.round(maxY - minY));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(-minX, -minY);
  drawItems(ctx, plan.items, images);
  ctx.restore();
  return canvas;
}

export interface ExportEntry {
  name: string;
  canvas: HTMLCanvasElement;
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

function drawMetadataPage(pdf: any, metadata: ExportMetadata, sections: ExportSection[]) {
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(22);
  pdf.setTextColor(20, 20, 20);
  pdf.text("Informacion de la exportacion", 50, 70);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(13);
  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);
  const lines = [
    `Usuario: ${metadata.userName}`,
    `Fecha: ${metadata.fecha}`,
    `Hora: ${metadata.hora}`,
    `IP: ${metadata.ip}`,
    `Total de archivos: ${totalFiles}`,
  ];
  let y = 110;
  lines.forEach((line) => {
    pdf.text(line, 50, y);
    y += 24;
  });

  y += 16;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  pdf.text("Contenido", 50, y);
  y += 24;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(11);
  sections.forEach((section) => {
    if (y > PAGE_H - 60) return;
    if (section.title) {
      pdf.setFont("helvetica", "bold");
      pdf.text(section.title, 50, y);
      pdf.setFont("helvetica", "normal");
      y += 18;
    }
    section.entries.forEach((entry) => {
      if (y > PAGE_H - 60) return;
      pdf.text(`- ${entry.name}`, section.title ? 66 : 50, y);
      y += 16;
    });
  });
}

/** Arma un unico PDF con una pagina por dibujo. Si hay mas de una seccion
 * (o una seccion con nombre, ej. una carpeta descargada entera), antepone
 * una pagina divisoria por seccion a modo de titulo markdown "# Carpeta".
 * Siempre cierra con una pagina de metadata (usuario/fecha/hora/IP). */
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
    section.entries.forEach(({ canvas }) => {
      const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
      startPage(canvas.width, canvas.height, orientation);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      pdf.addImage(dataUrl, "JPEG", 0, 0, canvas.width, canvas.height);
    });
  });

  startPage(PAGE_W, PAGE_H, "portrait");
  drawMetadataPage(pdf, metadata, sections);

  pdf.setProperties({
    title: "ConceptSerializer - Exportacion",
    subject: `Exportado por ${metadata.userName}`,
    author: metadata.userName,
    keywords: `ip:${metadata.ip}`,
    creator: "ConceptSerializer",
  });

  const totalFiles = sections.reduce((n, s) => n + s.entries.length, 0);
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
