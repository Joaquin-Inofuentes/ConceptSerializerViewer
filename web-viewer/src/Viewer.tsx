import React, { useEffect, useRef } from "react";
import type { Document } from "./parser";

interface ViewerProps {
  doc: Document | null;
}

export const Viewer: React.FC<ViewerProps> = ({ doc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const padding = 50; // padding around the drawing
    const { bbox } = doc;
    
    // Si no hay bbox valida
    if (bbox.minX === Infinity || bbox.maxX === -Infinity) {
      ctx.fillStyle = "#888";
      ctx.fillText("El documento no contiene trazos válidos.", 50, 50);
      return;
    }

    const docWidth = bbox.maxX - bbox.minX;
    const docHeight = bbox.maxY - bbox.minY;

    // Escalar para que quepa en el canvas
    const scaleX = (canvas.width - padding * 2) / (docWidth || 1);
    const scaleY = (canvas.height - padding * 2) / (docHeight || 1);
    const scale = Math.min(scaleX, scaleY);

    const offsetX = (canvas.width - docWidth * scale) / 2;
    const offsetY = (canvas.height - docHeight * scale) / 2;

    ctx.save();
    
    // Draw background (optional, maybe dark theme handled by CSS)
    
    // Draw elements
    // We sort layers by index just in case, but they usually come sorted
    const sortedLayers = [...doc.layers].sort((a, b) => a.index - b.index);

    for (const layer of sortedLayers) {
      // 1. Draw images first (usually below strokes)
      for (const img of layer.images) {
        if (img.resourceId && doc.resources[img.resourceId]) {
           const blob = doc.resources[img.resourceId];
           if (blob.type && (blob.type.startsWith("image/") || blob.type === "")) {
               // Fallback: draw placeholder for images right now due to async image loading complexity
               const cx = (0 - bbox.minX) * scale + offsetX;
               const cy = (0 - bbox.minY) * scale + offsetY;
               
               ctx.fillStyle = "rgba(100, 150, 250, 0.3)";
               ctx.fillRect(cx, cy, img.width * scale, img.height * scale);
               ctx.strokeStyle = "blue";
               ctx.strokeRect(cx, cy, img.width * scale, img.height * scale);
               ctx.fillStyle = "black";
               ctx.fillText(`Image: ${img.resourceId.substring(0,6)}`, cx + 5, cy + 15);
           }
        }
      }

      // 2. Draw strokes
      for (const stroke of layer.strokes) {
        if (stroke.points.length === 0) continue;
        
        ctx.beginPath();
        // Concept uses varying width per point (pressure), but for simple rendering we'll use a fixed stroke style or avg
        ctx.strokeStyle = stroke.color.hex;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        const startX = (stroke.points[0].x - bbox.minX) * scale + offsetX;
        const startY = (stroke.points[0].y - bbox.minY) * scale + offsetY;
        ctx.moveTo(startX, startY);

        // A basic rendering, no pressure simulation yet
        ctx.lineWidth = stroke.width * scale;

        for (let i = 1; i < stroke.points.length; i++) {
          const pt = stroke.points[i];
          const px = (pt.x - bbox.minX) * scale + offsetX;
          const py = (pt.y - bbox.minY) * scale + offsetY;
          ctx.lineTo(px, py);
        }
        
        // Some brushes might be fills, but we'll stroke everything
        if (stroke.color.a < 1.0) {
           ctx.globalAlpha = stroke.color.a;
        } else {
           ctx.globalAlpha = 1.0;
        }
        ctx.stroke();
      }
    }
    
    ctx.restore();

  }, [doc]);

  // Adjust canvas size to window or container
  useEffect(() => {
    const handleResize = () => {
      const parent = canvasRef.current?.parentElement;
      if (canvasRef.current && parent) {
        canvasRef.current.width = parent.clientWidth;
        canvasRef.current.height = parent.clientHeight;
        // Trigger re-render of canvas (since doc is in dep array, we might need state or just let the user resize)
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          backgroundColor: "#1e1e2e" // Dark premium background
        }}
      />
    </div>
  );
};
