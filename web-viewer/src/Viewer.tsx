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
    // --- DRAW BACKGROUND GRID IN SCREEN SPACE ---
    const gridSize = 50 * zoom;
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    
    const offsetX = (size.width / 2 + pan.x) % gridSize;
    const offsetY = (size.height / 2 + pan.y) % gridSize;

    ctx.beginPath();
    for (let x = offsetX - gridSize; x < size.width + gridSize; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
    }
    for (let y = offsetY - gridSize; y < size.height + gridSize; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
    }
    ctx.stroke();

    // --- APPLY WORLD TRANSFORM ---
    ctx.save();
    ctx.translate(size.width / 2 + pan.x, size.height / 2 + pan.y);
    ctx.scale(zoom, zoom);

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

  const [isRightDragging, setIsRightDragging] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setLastMousePos({ x: e.clientX, y: e.clientY });
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
    } else if (e.button === 0) {
       setIsDragging(true);
       setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightDragging) {
       const dx = e.clientX - lastMousePos.x;
       const dy = e.clientY - lastMousePos.y;
       setLastMousePos({ x: e.clientX, y: e.clientY });
       
       const zoomDelta = dx - dy; 
       const zoomFactor = 1 + (zoomDelta * 0.01);
       let newZoom = zoom * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       // ALWAYS use the initial click position as the zoom anchor
       const screenX = rightDragStartPos.x - rect.left;
       const screenY = rightDragStartPos.y - rect.top;

       const centerX = screenX - rect.width / 2;
       const centerY = screenY - rect.height / 2;

       const newPanX = centerX - (centerX - pan.x) * (newZoom / zoom);
       const newPanY = centerY - (centerY - pan.y) * (newZoom / zoom);

       setZoom(newZoom);
       setPan({ x: newPanX, y: newPanY });

    } else if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (e.button === 2) setIsRightDragging(false);
    if (e.button === 0) setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(zoomFactor, direction);
    
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    const centerX = screenX - rect.width / 2;
    const centerY = screenY - rect.height / 2;
    
    let newZoom = zoom * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - pan.x) * (newZoom / zoom);
    const newPanY = centerY - (centerY - pan.y) * (newZoom / zoom);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  return (
    <div 
      ref={containerRef}
      style={{ 
        width: "100%", 
        height: "100%", 
        overflow: "hidden",
        position: "relative", 
        cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab") 
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          touchAction: "none"
        }}
      />
      {/* Zoom Reference Indicator */}
      {isRightDragging && (
        <div style={{
          position: 'absolute',
          left: rightDragStartPos.x - (containerRef.current?.getBoundingClientRect().left || 0),
          top: rightDragStartPos.y - (containerRef.current?.getBoundingClientRect().top || 0),
          width: '16px',
          height: '16px',
          marginLeft: '-8px',
          marginTop: '-8px',
          border: '2px solid red',
          borderRadius: '50%',
          pointerEvents: 'none',
          boxShadow: '0 0 4px rgba(0,0,0,0.5)',
          zIndex: 100
        }}>
          <div style={{ width: '4px', height: '4px', background: 'red', borderRadius: '50%', margin: '4px' }} />
        </div>
      )}
    </div>
  );
};
