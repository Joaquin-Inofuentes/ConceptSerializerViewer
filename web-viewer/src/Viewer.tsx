import React, { useEffect, useRef, useState } from "react";
import type { Document } from "./parser";

interface ViewerProps {
  doc: Document | null;
}

export const Viewer: React.FC<ViewerProps> = ({ doc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Viewport State
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  // Canvas size State
  const [size, setSize] = useState({ width: 800, height: 600 });
  
  // Loaded Images State
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});

  // 1. Handle Resize
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

  // 2. Initial Auto-Fit & Load Images when doc changes
  useEffect(() => {
    if (!doc) return;
    
    // Fit to view
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

    // Load Images
    const loadedImgs: Record<string, HTMLImageElement> = {};
    let pending = 0;
    
    doc.layers.forEach(layer => {
      layer.images.forEach(img => {
        if (img.resourceId && doc.resources[img.resourceId]) {
          const blob = doc.resources[img.resourceId];
          // Concept images might not have mime type set correctly, let's force it if it's empty
          const blobUrl = URL.createObjectURL(blob);
          const imageObj = new Image();
          pending++;
          imageObj.onload = () => {
            loadedImgs[img.resourceId] = imageObj;
            pending--;
            if (pending === 0) {
              setImages({ ...loadedImgs });
            }
          };
          imageObj.onerror = () => { pending--; };
          imageObj.src = blobUrl;
        }
      });
    });
    
  }, [doc]); // We intentionally do not include `size` to only auto-fit on initial doc load.

  // 3. Render Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Setting dimensions clears the canvas
    canvas.width = size.width;
    canvas.height = size.height;

    ctx.clearRect(0, 0, size.width, size.height);

    ctx.save();
    // Apply pan and zoom
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw elements
    const sortedLayers = [...doc.layers].sort((a, b) => a.index - b.index);

    for (const layer of sortedLayers) {
      // 1. Draw Images
      for (const img of layer.images) {
        ctx.save();
        
        // Matrix transform from msgpack is a 4x4 matrix (16 floats)
        // A 2D canvas transform takes: a (m11), b (m12), c (m21), d (m22), e (dx), f (dy)
        // m[0]=scaleX, m[1]=skewY?, m[4]=skewX?, m[5]=scaleY, m[12]=translateX, m[13]=translateY
        const m = img.transform;
        if (m && m.length === 16) {
           // We map the 4x4 into 2D transform (assuming 2D operations)
           ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
        }

        const imageObj = images[img.resourceId];
        if (imageObj) {
           // Si el size viene dado
           if (img.width && img.height) {
             // Algunas imágenes se centran en 0,0 por la matriz, o la matriz las desplaza
             // dibujamos desde -w/2, -h/2 asumiendo ancla central, o 0,0 si es top-left
             ctx.drawImage(imageObj, 0, 0, img.width, img.height);
           } else {
             ctx.drawImage(imageObj, 0, 0);
           }
        } else {
           // Placeholder for unloaded images
           ctx.fillStyle = "rgba(100, 150, 250, 0.3)";
           ctx.fillRect(0, 0, img.width || 100, img.height || 100);
           ctx.strokeStyle = "blue";
           ctx.strokeRect(0, 0, img.width || 100, img.height || 100);
        }
        ctx.restore();
      }

      // 2. Draw Strokes
      for (const stroke of layer.strokes) {
        if (stroke.points.length === 0) continue;
        
        ctx.beginPath();
        // Concept uses varying width per point (pressure).
        // For accurate rendering, one would draw a polygon or multiple segments.
        // Here we draw a simple path with an average or fixed stroke width for preview.
        ctx.strokeStyle = stroke.color.hex;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = stroke.width || 1.5;

        // Apply alpha
        ctx.globalAlpha = stroke.color.a;

        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();

  }, [doc, pan, zoom, size, images]);

  // 4. Input Handlers (Pan & Zoom)
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
    
    // Zoom around cursor position
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Calculate new zoom
    let newZoom = zoom * factor;
    // Limit zoom to prevent disappearing
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    // Calculate new pan to keep mouse point fixed
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
          touchAction: "none" // Prevent browser scrolling on touch devices
        }}
      />
    </div>
  );
};
