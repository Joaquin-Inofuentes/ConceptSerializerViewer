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

/** Arma un unico PDF con una pagina por seleccion. */
export async function exportSelectionAsPdf(entries: ExportEntry[]): Promise<void> {
  const { default: JsPDF } = await import("jspdf");
  let pdf: InstanceType<typeof JsPDF> | null = null;
  entries.forEach(({ canvas }, i) => {
    const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    if (i === 0) {
      pdf = new JsPDF({ orientation, unit: "px", format: [canvas.width, canvas.height] });
    } else {
      pdf!.addPage([canvas.width, canvas.height], orientation);
    }
    pdf!.addImage(dataUrl, "JPEG", 0, 0, canvas.width, canvas.height);
  });
  pdf!.save(`concepts-${entries.length}.pdf`);
}

/** Arma un zip simple (sin subcarpetas) con un JPG por seleccion. */
export async function exportSelectionAsZip(entries: ExportEntry[]): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const usedNames = new Set<string>();
  entries.forEach(({ name, canvas }) => {
    let fileName = `${name}.jpg`;
    let n = 2;
    while (usedNames.has(fileName)) {
      fileName = `${name} (${n}).jpg`;
      n++;
    }
    usedNames.add(fileName);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    zip.file(fileName, dataUrl.split(",")[1], { base64: true });
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "concepts.zip";
  link.click();
  URL.revokeObjectURL(url);
}
