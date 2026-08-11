import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo } from "react";
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
  exportDrawing: (format: 'png' | 'jpg' | 'pdf', zoomAll?: boolean) => Promise<void>;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({ doc, layerConfigs, isolatedLayer, onImagesLoaded }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Core state moved to refs for high performance
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const sizeRef = useRef({ width: 0, height: 0 });
  
  // Cache refs
  const imagesRef = useRef<Record<string, CanvasImageSource>>({});
  const layerConfigsRef = useRef<Record<string, LayerConfig>>(layerConfigs);
  const isolatedLayerRef = useRef<string | null>(isolatedLayer);
  const isDirtyRef = useRef(true);

  const requestRedraw = () => {
    isDirtyRef.current = true;
  };

  // Sync props to refs
  useEffect(() => {
    layerConfigsRef.current = layerConfigs;
    isolatedLayerRef.current = isolatedLayer;
    requestRedraw();
  }, [layerConfigs, isolatedLayer]);

  // Pre-calculate Path2D and Bounding Boxes (Frustum Culling)
  const docCache = useMemo(() => {
    if (!doc) return null;
    const strokesCache: any[] = [];
    const imagesCache: any[] = [];

    doc.layers.forEach(layer => {
      layer.strokes.forEach(stroke => {
        if (stroke.points.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const path = new Path2D();
        path.moveTo(stroke.points[0].x, stroke.points[0].y);
        stroke.points.forEach(pt => {
           if (pt.x < minX) minX = pt.x;
           if (pt.y < minY) minY = pt.y;
           if (pt.x > maxX) maxX = pt.x;
           if (pt.y > maxY) maxY = pt.y;
           path.lineTo(pt.x, pt.y);
        });
        strokesCache.push({
           path, minX, minY, maxX, maxY,
           color: stroke.color.hex,
           globalAlpha: stroke.color.a,
           width: stroke.width || 1.5,
           layerId: layer.id,
           layerIndex: layer.index
        });
      });
      
      layer.images.forEach(img => {
          const tx = img.transform[12];
          const ty = img.transform[13];
          const w = img.width || 500;
          const h = img.height || 500;
          imagesCache.push({
             resourceId: img.resourceId,
             transform: img.transform,
             minX: tx, minY: ty, maxX: tx + w, maxY: ty + h,
             width: img.width, height: img.height,
             layerId: layer.id,
             layerIndex: layer.index
          });
      });
    });
    
    requestRedraw();
    return { strokes: strokesCache, images: imagesCache };
  }, [doc]);

  useImperativeHandle(ref, () => ({
    exportDrawing: async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
      if (!doc || !docCache) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      let hasStrokes = false;
      
      if (zoomAll) {
        docCache.strokes.forEach(stroke => {
          const config = layerConfigsRef.current[stroke.layerId];
          if (config && !config.visible) return;
          if (isolatedLayerRef.current && isolatedLayerRef.current !== stroke.layerId) return;
          
          hasStrokes = true;
          if (stroke.minX < minX) minX = stroke.minX;
          if (stroke.minY < minY) minY = stroke.minY;
          if (stroke.maxX > maxX) maxX = stroke.maxX;
          if (stroke.maxY > maxY) maxY = stroke.maxY;
        });

        if (!hasStrokes) {
          docCache.images.forEach(img => {
            const config = layerConfigsRef.current[img.layerId];
            if (config && !config.visible) return;
            if (isolatedLayerRef.current && isolatedLayerRef.current !== img.layerId) return;
            
            if (img.minX < minX) minX = img.minX;
            if (img.minY < minY) minY = img.minY;
            if (img.maxX > maxX) maxX = img.maxX;
            if (img.maxY > maxY) maxY = img.maxY;
          });
        }
      }

      if (zoomAll && minX === Infinity) {
        alert("El lienzo está vacío u oculto.");
        return;
      }

      let exportWidth, exportHeight;
      let translateX, translateY;
      let exportZoom = 1;

      if (zoomAll) {
        const padding = 20;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;
        exportWidth = maxX - minX;
        exportHeight = maxY - minY;
        translateX = -minX;
        translateY = -minY;
      } else {
        exportWidth = sizeRef.current.width;
        exportHeight = sizeRef.current.height;
        translateX = panRef.current.x;
        translateY = panRef.current.y;
        exportZoom = zoomRef.current;
      }

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = exportWidth;
      exportCanvas.height = exportHeight;
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) return;

      if (format === 'jpg' || format === 'pdf') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, exportWidth, exportHeight);
      }

      ctx.save();
      ctx.translate(translateX, translateY);
      ctx.scale(exportZoom, exportZoom);

      // We need to draw layers in index order
      const allItems = [...docCache.images, ...docCache.strokes].sort((a, b) => a.layerIndex - b.layerIndex);

      for (const item of allItems) {
        if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) continue;
        const config = layerConfigsRef.current[item.layerId];
        if (config && !config.visible) continue;
        
        const layerOpacity = config ? config.opacity : 1.0;

        if (item.resourceId) { // It's an image
          ctx.save();
          ctx.globalAlpha = layerOpacity;
          const m = item.transform;
          if (m && m.length === 16) {
             ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
          }
          const imageObj = imagesRef.current[item.resourceId];
          if (imageObj) {
             if (item.width && item.height) {
               ctx.drawImage(imageObj, 0, 0, item.width, item.height);
             } else {
               ctx.drawImage(imageObj, 0, 0);
             }
          }
          ctx.restore();
        } else { // It's a stroke
          ctx.strokeStyle = item.color;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.lineWidth = item.width;
          ctx.globalAlpha = item.globalAlpha * layerOpacity;
          ctx.stroke(item.path);
        }
      }
      ctx.restore();

      const dataUrl = exportCanvas.toDataURL(`image/${format === 'jpg' ? 'jpeg' : 'png'}`, 1.0);

      if (format === 'pdf') {
        const jsPDF = (await import('jspdf')).default;
        const pdf = new jsPDF({
          orientation: exportWidth > exportHeight ? 'landscape' : 'portrait',
          unit: 'px',
          format: [exportWidth, exportHeight]
        });
        pdf.addImage(dataUrl, 'JPEG', 0, 0, exportWidth, exportHeight);
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
        sizeRef.current = {
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        };
        requestRedraw();
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => {
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const fitToBounds = () => {
    if (!docCache || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    docCache.strokes.forEach(stroke => {
      if (stroke.minX < minX) minX = stroke.minX;
      if (stroke.minY < minY) minY = stroke.minY;
      if (stroke.maxX > maxX) maxX = stroke.maxX;
      if (stroke.maxY > maxY) maxY = stroke.maxY;
    });
    docCache.images.forEach(img => {
      if (img.minX < minX) minX = img.minX;
      if (img.minY < minY) minY = img.minY;
      if (img.maxX > maxX) maxX = img.maxX;
      if (img.maxY > maxY) maxY = img.maxY;
    });

    if (minX === Infinity) return;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    
    const pad = 40;
    const availWidth = rect.width - pad * 2;
    const availHeight = rect.height - pad * 2;

    if (contentWidth > 0 && contentHeight > 0) {
        let newZoom = Math.min(availWidth / contentWidth, availHeight / contentHeight);
        newZoom = Math.max(0.1, Math.min(newZoom, 5));

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        zoomRef.current = newZoom;
        panRef.current = { x: rect.width / 2 - cx * newZoom, y: rect.height / 2 - cy * newZoom };
        requestRedraw();
    }
  };

  useEffect(() => {
    fitToBounds();
  }, [docCache]);

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
                imagesRef.current = { ...imagesRef.current, ...loadedImgs };
                requestRedraw();
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

  // HIGH PERFORMANCE RENDER LOOP
  useEffect(() => {
    let animationFrameId: number;

    const render = () => {
      if (isDirtyRef.current && canvasRef.current && docCache) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const pan = panRef.current;
        const zoom = zoomRef.current;
        const size = sizeRef.current;

        if (ctx && size.width > 0 && size.height > 0) {
          canvas.width = size.width;
          canvas.height = size.height;
          ctx.clearRect(0, 0, size.width, size.height);

          // Draw Grid
          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(zoom, zoom);
          
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

          // Calculate View Frustum
          const viewMinX = -pan.x / zoom;
          const viewMinY = -pan.y / zoom;
          const viewMaxX = (size.width - pan.x) / zoom;
          const viewMaxY = (size.height - pan.y) / zoom;

          const allItems = [...docCache.images, ...docCache.strokes].sort((a, b) => a.layerIndex - b.layerIndex);

          for (const item of allItems) {
            if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) continue;
            const config = layerConfigsRef.current[item.layerId];
            if (config && !config.visible) continue;
            
            // Frustum Culling
            if (item.maxX < viewMinX || item.minX > viewMaxX || item.maxY < viewMinY || item.minY > viewMaxY) {
               continue;
            }

            const layerOpacity = config ? config.opacity : 1.0;

            if (item.resourceId) { // Image
              ctx.save();
              ctx.globalAlpha = layerOpacity;
              const m = item.transform;
              if (m && m.length === 16) {
                 ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
              }
              const imageObj = imagesRef.current[item.resourceId];
              if (imageObj) {
                 if (item.width && item.height) {
                   ctx.drawImage(imageObj, 0, 0, item.width, item.height);
                 } else {
                   ctx.drawImage(imageObj, 0, 0);
                 }
              }
              ctx.restore();
            } else { // Stroke
              ctx.strokeStyle = item.color;
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.lineWidth = item.width;
              ctx.globalAlpha = item.globalAlpha * layerOpacity;
              ctx.stroke(item.path);
            }
          }
          ctx.restore();
        }
        isDirtyRef.current = false;
      }
      animationFrameId = requestAnimationFrame(render);
    };
    
    render();
    
    return () => cancelAnimationFrame(animationFrameId);
  }, [docCache]);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const [isRightDragging, setIsRightDragging] = useState(false);
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const dragStartZoomRef = useRef(1);
  const dragStartPanRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       dragStartZoomRef.current = zoomRef.current;
       dragStartPanRef.current = { ...panRef.current };
    } else if (e.button === 0) {
       setIsDragging(true);
       dragStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
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
       let newZoom = dragStartZoomRef.current * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       const screenX = rightDragStartPos.x - rect.left;
       const screenY = rightDragStartPos.y - rect.top;

       const centerX = screenX;
       const centerY = screenY;

       const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
       const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

       zoomRef.current = newZoom;
       panRef.current = { x: newPanX, y: newPanY };
       requestRedraw();

    } else if (isDragging) {
      panRef.current = {
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      };
      requestRedraw();
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
    
    let newZoom = zoomRef.current * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - panRef.current.x) * (newZoom / zoomRef.current);
    const newPanY = centerY - (centerY - panRef.current.y) * (newZoom / zoomRef.current);

    zoomRef.current = newZoom;
    panRef.current = { x: newPanX, y: newPanY };
    requestRedraw();
  };

  const touchDistStartRef = useRef<number | null>(null);
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
      dragStartRef.current = { x: e.touches[0].clientX - panRef.current.x, y: e.touches[0].clientY - panRef.current.y };
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistStartRef.current = Math.sqrt(dx * dx + dy * dy);
      dragStartZoomRef.current = zoomRef.current;
      dragStartPanRef.current = { ...panRef.current };
      
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setRightDragStartPos({ x: cx, y: cy });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging) {
      panRef.current = {
        x: e.touches[0].clientX - dragStartRef.current.x,
        y: e.touches[0].clientY - dragStartRef.current.y,
      };
      requestRedraw();
    } else if (e.touches.length === 2 && touchDistStartRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      
      const zoomFactor = currentDist / touchDistStartRef.current;
      let newZoom = dragStartZoomRef.current * zoomFactor;
      newZoom = Math.max(0.01, Math.min(newZoom, 100));

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const screenX = rightDragStartPos.x - rect.left;
      const screenY = rightDragStartPos.y - rect.top;

      const centerX = screenX;
      const centerY = screenY;

      const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
      const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

      zoomRef.current = newZoom;
      panRef.current = { x: newPanX, y: newPanY };
      requestRedraw();
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    touchDistStartRef.current = null;
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
