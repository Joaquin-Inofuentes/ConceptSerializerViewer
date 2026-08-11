import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
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

export interface ViewerHandle {
  exportDrawing: (format: 'png' | 'jpg' | 'pdf') => Promise<void>;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({ doc, layerConfigs, isolatedLayer, onImagesLoaded }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [images, setImages] = useState<Record<string, CanvasImageSource>>({});

  useImperativeHandle(ref, () => ({
    exportDrawing: async (format: 'png' | 'jpg' | 'pdf') => {
      if (!doc) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      doc.layers.forEach(layer => {
        const config = layerConfigs[layer.id];
        if (config && !config.visible) return;
        if (isolatedLayer && isolatedLayer !== layer.id) return;
        
        layer.strokes.forEach(stroke => {
          stroke.points.forEach(pt => {
             if (pt.x < minX) minX = pt.x;
             if (pt.y < minY) minY = pt.y;
             if (pt.x > maxX) maxX = pt.x;
             if (pt.y > maxY) maxY = pt.y;
          });
        });
        layer.images.forEach(img => {
            const tx = img.transform[12];
            const ty = img.transform[13];
            const w = img.width || 500;
            const h = img.height || 500;
            if (tx < minX) minX = tx;
            if (ty < minY) minY = ty;
            if (tx + w > maxX) maxX = tx + w;
            if (ty + h > maxY) maxY = ty + h;
        });
      });

      if (minX === Infinity) {
        alert("El lienzo está vacío u oculto.");
        return;
      }

      const padding = 20;
      minX -= padding;
      minY -= padding;
      maxX += padding;
      maxY += padding;

      const width = maxX - minX;
      const height = maxY - minY;

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = width;
      exportCanvas.height = height;
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) return;

      if (format === 'jpg' || format === 'pdf') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }

      ctx.save();
      ctx.translate(-minX, -minY);

      const sortedLayers = [...doc.layers].sort((a, b) => a.index - b.index);

      for (const layer of sortedLayers) {
        if (isolatedLayer && isolatedLayer !== layer.id) continue;
        const config = layerConfigs[layer.id];
        if (config && !config.visible) continue;
        
        const layerOpacity = config ? config.opacity : 1.0;

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

      const dataUrl = exportCanvas.toDataURL(`image/${format === 'jpg' ? 'jpeg' : 'png'}`, 1.0);

      if (format === 'pdf') {
        const jsPDF = (await import('jspdf')).default;
        const pdf = new jsPDF({
          orientation: width > height ? 'landscape' : 'portrait',
          unit: 'px',
          format: [width, height]
        });
        pdf.addImage(dataUrl, 'JPEG', 0, 0, width, height);
        pdf.save('export.pdf');
      } else {
        const link = document.createElement('a');
        link.download = `export.${format}`;
        link.href = dataUrl;
        link.click();
      }
    }
  }));

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
    const currentContainer = containerRef.current;
    window.addEventListener("resize", updateSize);
    return () => {
      if (!currentContainer) return;
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const fitToBounds = () => {
    if (!doc || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    doc.layers.forEach(layer => {
      layer.strokes.forEach(stroke => {
        stroke.points.forEach(pt => {
           if (pt.x < minX) minX = pt.x;
           if (pt.y < minY) minY = pt.y;
           if (pt.x > maxX) maxX = pt.x;
           if (pt.y > maxY) maxY = pt.y;
        });
      });
      layer.images.forEach(img => {
          const tx = img.transform[12];
          const ty = img.transform[13];
          if (tx < minX) minX = tx;
          if (ty < minY) minY = ty;
          if (tx > maxX) maxX = tx;
          if (ty > maxY) maxY = ty;
      });
    });

    if (minX === Infinity) return; // Empty doc

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    
    const pad = 40;
    const availWidth = rect.width - pad * 2;
    const availHeight = rect.height - pad * 2;

    if (contentWidth > 0 && contentHeight > 0) {
        let newZoom = Math.min(availWidth / contentWidth, availHeight / contentHeight);
        newZoom = Math.max(0.1, Math.min(newZoom, 5)); // Bound zoom

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        setZoom(newZoom);
        setPan({ x: rect.width / 2 - cx * newZoom, y: rect.height / 2 - cy * newZoom });
    }
  };

  // Zoom to fit bounds on load
  useEffect(() => {
    fitToBounds();
  }, [doc, size]);

  useEffect(() => {
    if (!doc) return;
    
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
    const gridSize = 50;
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1 / zoom;
    
    const offsetX = (pan.x) % (gridSize * zoom);
    const offsetY = (pan.y) % (gridSize * zoom);

    ctx.beginPath();
    for (let x = offsetX - gridSize * zoom; x < size.width; x += gridSize * zoom) {
      ctx.moveTo(x / zoom - pan.x / zoom, 0 / zoom - pan.y / zoom);
      ctx.lineTo(x / zoom - pan.x / zoom, size.height / zoom - pan.y / zoom);
    }
    for (let y = offsetY - gridSize * zoom; y < size.height; y += gridSize * zoom) {
      ctx.moveTo(0 / zoom - pan.x / zoom, y / zoom - pan.y / zoom);
      ctx.lineTo(size.width / zoom - pan.x / zoom, y / zoom - pan.y / zoom);
    }
    ctx.stroke();

    ctx.restore();

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    const sortedLayers = [...doc.layers].sort((a, b) => a.index - b.index);

    for (const layer of sortedLayers) {
      if (isolatedLayer && isolatedLayer !== layer.id) continue;
      
      const config = layerConfigs[layer.id];
      if (config && !config.visible) continue;
      
      const layerOpacity = config ? config.opacity : 1.0;

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

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const [isRightDragging, setIsRightDragging] = useState(false);
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const [dragStartZoom, setDragStartZoom] = useState(1);
  const [dragStartPan, setDragStartPan] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       setDragStartZoom(zoom);
       setDragStartPan(pan);
    } else if (e.button === 0) {
       setIsDragging(true);
       setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightDragging) {
       const totalDx = e.clientX - rightDragStartPos.x;
       const totalDy = e.clientY - rightDragStartPos.y;
       
       const distance = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
       const sign = (totalDx - totalDy) >= 0 ? 1 : -1;
       const zoomDelta = sign * distance; 
       const zoomFactor = Math.exp(zoomDelta * 0.015);
       let newZoom = dragStartZoom * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       const screenX = rightDragStartPos.x - rect.left;
       const screenY = rightDragStartPos.y - rect.top;

       const centerX = screenX;
       const centerY = screenY;

       const newPanX = centerX - (centerX - dragStartPan.x) * (newZoom / dragStartZoom);
       const newPanY = centerY - (centerY - dragStartPan.y) * (newZoom / dragStartZoom);

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
    
    const centerX = screenX;
    const centerY = screenY;
    
    let newZoom = zoom * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - pan.x) * (newZoom / zoom);
    const newPanY = centerY - (centerY - pan.y) * (newZoom / zoom);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const [touchDistStart, setTouchDistStart] = useState<number | null>(null);
  const [lastTap, setLastTap] = useState(0);
  const [tapCount, setTapCount] = useState(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        const newCount = tapCount + 1;
        setTapCount(newCount);
        if (newCount >= 3) {
           fitToBounds();
           setTapCount(0);
        }
      } else {
        setTapCount(1);
      }
      setLastTap(now);

      setIsDragging(true);
      setDragStart({ x: e.touches[0].clientX - pan.x, y: e.touches[0].clientY - pan.y });
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      setTouchDistStart(Math.sqrt(dx * dx + dy * dy));
      setDragStartZoom(zoom);
      setDragStartPan(pan);
      
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setRightDragStartPos({ x: cx, y: cy });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging) {
      setPan({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y,
      });
    } else if (e.touches.length === 2 && touchDistStart !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      
      const zoomFactor = currentDist / touchDistStart;
      let newZoom = dragStartZoom * zoomFactor;
      newZoom = Math.max(0.01, Math.min(newZoom, 100));

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const screenX = rightDragStartPos.x - rect.left;
      const screenY = rightDragStartPos.y - rect.top;

      const centerX = screenX;
      const centerY = screenY;

      const newPanX = centerX - (centerX - dragStartPan.x) * (newZoom / dragStartZoom);
      const newPanY = centerY - (centerY - dragStartPan.y) * (newZoom / dragStartZoom);

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    setTouchDistStart(null);
  };

  return (
    <div 
      ref={containerRef}
      style={{ 
        width: "100%", 
        height: "100%", 
        overflow: "hidden",
        position: "relative", 
        cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
        touchAction: "none"
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
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
});
