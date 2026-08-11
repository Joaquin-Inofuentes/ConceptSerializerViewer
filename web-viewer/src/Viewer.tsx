import React, { useEffect, useRef, useState } from "react";
import type { Document } from "./parser";

export interface LayerConfig {
  visible: boolean;
  opacity: number;
}

interface ViewerProps {
  doc: Document | null;
  layerConfigs: Record<string, LayerConfig>;
  isolatedLayer: string | null;
  onImagesLoaded?: (images: Record<string, string>) => void;
}

export const Viewer: React.FC<ViewerProps> = ({ doc, layerConfigs, isolatedLayer, onImagesLoaded }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [images, setImages] = useState<Record<string, CanvasImageSource>>({});

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    if (!doc) return;
    
    const padding = 50;
    const { bbox } = doc;
    const docWidth = bbox.maxX - bbox.minX;
    const docHeight = bbox.maxY - bbox.minY;
    
    if (docWidth > 0 && docHeight > 0 && size.width > 0) {
      const scaleX = (size.width - padding * 2) / docWidth;
      const scaleY = (size.height - padding * 2) / docHeight;
      const initialZoom = Math.min(scaleX, scaleY);
      setZoom(initialZoom);
      
      const docCenterX = bbox.minX + docWidth / 2;
      const docCenterY = bbox.minY + docHeight / 2;
      
      setPan({
        x: size.width / 2 - docCenterX * initialZoom,
        y: size.height / 2 - docCenterY * initialZoom,
      });
    }

    const loadedImgs: Record<string, CanvasImageSource> = {};
    let pending = 0;
    
    doc.layers.forEach(layer => {
      layer.images.forEach(img => {
        if (img.resourceId && doc.resources[img.resourceId]) {
          const blob = doc.resources[img.resourceId];
          pending++;
          
          const processBlob = async () => {
            try {
              const header = await blob.slice(0, 5).text();
              if (header === "%PDF-") {
                 const pdfjsLib = await import('pdfjs-dist');
                 pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
                 const url = URL.createObjectURL(blob);
                 const pdf = await pdfjsLib.getDocument({ url }).promise;
                 const page = await pdf.getPage(1);
                 const viewport = page.getViewport({ scale: 2.0 });
                 const canvas = document.createElement("canvas");
                 const context = canvas.getContext("2d");
                 if (context) {
                   canvas.height = viewport.height;
                   canvas.width = viewport.width;
                   await page.render({ canvasContext: context, viewport } as any).promise;
                   loadedImgs[img.resourceId] = canvas;
                 }
                 URL.revokeObjectURL(url);
              } else {
                 const url = URL.createObjectURL(blob);
                 const imageObj = new Image();
                 await new Promise((resolve, reject) => {
                    imageObj.onload = () => resolve(true);
                    imageObj.onerror = reject;
                    imageObj.src = url;
                 });
                 loadedImgs[img.resourceId] = imageObj;
              }
            } catch (e) {
              console.error("Error loading resource", img.resourceId, e);
            } finally {
              pending--;
              if (pending === 0) {
                setImages({ ...loadedImgs });
                if (onImagesLoaded) {
                   const urls: Record<string, string> = {};
                   Object.keys(loadedImgs).forEach(k => {
                     const imgOrCanvas = loadedImgs[k];
                     if (imgOrCanvas instanceof HTMLCanvasElement) {
                       urls[k] = imgOrCanvas.toDataURL();
                     } else if (imgOrCanvas instanceof HTMLImageElement) {
                       urls[k] = imgOrCanvas.src;
                     }
                   });
                   onImagesLoaded(urls);
                }
              }
            }
          };
          
          processBlob();
        }
      });
    });
    
  }, [doc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = size.width;
    canvas.height = size.height;
    ctx.clearRect(0, 0, size.width, size.height);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw dynamic background grid
    ctx.save();
    // Invert transform to find visible bounds in world coordinates
    const startX = -pan.x / zoom;
    const startY = -pan.y / zoom;
    const endX = (size.width - pan.x) / zoom;
    const endY = (size.height - pan.y) / zoom;
    
    // Grid settings
    const gridSize = 40; 
    ctx.strokeStyle = "#e5e7eb"; // subtle gray grid
    ctx.lineWidth = 1 / zoom; // keep line 1px thick regardless of zoom
    
    ctx.beginPath();
    // Vertical lines
    for (let x = Math.floor(startX / gridSize) * gridSize; x < endX; x += gridSize) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    // Horizontal lines
    for (let y = Math.floor(startY / gridSize) * gridSize; y < endY; y += gridSize) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
    ctx.restore();

    const sortedLayers = [...doc.layers].sort((a, b) => a.index - b.index);

    for (const layer of sortedLayers) {
      // Check isolation and visibility
      if (isolatedLayer && isolatedLayer !== layer.id) continue;
      
      const config = layerConfigs[layer.id];
      if (config && !config.visible) continue;
      
      const layerOpacity = config ? config.opacity : 1.0;

      // Draw Images
      for (const img of layer.images) {
        ctx.save();
        ctx.globalAlpha = layerOpacity;
        
        const m = img.transform;
        if (m && m.length === 16) {
           ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
        }

        const imageObj = images[img.resourceId];
        if (imageObj) {
           if (img.width && img.height) {
             ctx.drawImage(imageObj, 0, 0, img.width, img.height);
           } else {
             ctx.drawImage(imageObj, 0, 0);
           }
        }
        ctx.restore();
      }

      // Draw Strokes
      for (const stroke of layer.strokes) {
        if (stroke.points.length === 0) continue;
        
        ctx.beginPath();
        ctx.strokeStyle = stroke.color.hex;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = stroke.width || 1.5;
        
        ctx.globalAlpha = stroke.color.a * layerOpacity;

        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();

  }, [doc, pan, zoom, size, images, layerConfigs, isolatedLayer]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(zoomFactor, direction);
    
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    let newZoom = zoom * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom);
    const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  return (
    <div 
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative", cursor: isDragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          touchAction: "none"
        }}
      />
    </div>
  );
};
