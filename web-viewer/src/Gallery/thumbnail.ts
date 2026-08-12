import type { Document } from "../VisorConcept/parser";
import { loadResourceImages, buildRenderPlan, drawItems } from "./renderCore";

/**
 * Renderiza trazos E imagenes/fotos embebidas del documento a una miniatura
 * JPEG cuadrada (antes solo dibujaba trazos, por eso las fotos no se veian).
 * Dibuja primero en un canvas grande (mejor anti-aliasing) y despues lo
 * reduce a `finalSize` con el downscale del navegador.
 */
export async function renderThumbnailDataUrl(
  doc: Document,
  finalSize = 32,
  superSample = 256
): Promise<string> {
  const images = await loadResourceImages(doc);
  const plan = buildRenderPlan(doc);

  const big = document.createElement("canvas");
  big.width = superSample;
  big.height = superSample;
  const ctx = big.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, superSample, superSample);

  if (plan.hasContent) {
    let { minX, minY, maxX, maxY } = plan;
    const w = maxX - minX;
    const h = maxY - minY;
    const pad = Math.max(w, h, 1) * 0.08;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const cw = maxX - minX;
    const ch = maxY - minY;
    const scale = Math.min(superSample / cw, superSample / ch);
    const offsetX = (superSample - cw * scale) / 2;
    const offsetY = (superSample - ch * scale) / 2;

    ctx.save();
    ctx.translate(offsetX - minX * scale, offsetY - minY * scale);
    ctx.scale(scale, scale);
    drawItems(ctx, plan.items, images);
    ctx.restore();
  }

  const small = document.createElement("canvas");
  small.width = finalSize;
  small.height = finalSize;
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(big, 0, 0, superSample, superSample, 0, 0, finalSize, finalSize);

  return small.toDataURL("image/jpeg", 0.85);
}
