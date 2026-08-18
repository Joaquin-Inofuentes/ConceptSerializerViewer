import React, { useRef, useState, useEffect } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { logDescarga } from '../Gallery/analytics';
import { safeExportScale } from '../Gallery/renderCore';

interface InteractivePreviewProps {
  src: string;
  fileName?: string;
  onClose: () => void;
  /** true mientras se pide la version completa sin recortar (ver
   * `abrirFoto` en App.tsx): `src` todavia es la miniatura chica de la
   * galeria. Se muestra un cartel chico en vez de dejar que el usuario crea
   * que la carga se colgo. */
  loadingFull?: boolean;
}

export const InteractivePreview: React.FC<InteractivePreviewProps> = ({ src, fileName, onClose, loadingFull }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isRightDragging, setIsRightDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const [dragStartZoom, setDragStartZoom] = useState(1);
  const [dragStartPan, setDragStartPan] = useState({ x: 0, y: 0 });
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportZoomAll, setExportZoomAll] = useState(true);
  // Rotacion manual de la foto en pantalla (0/90/180/270), a pedido del
  // usuario: algunas fotos vienen embebidas de costado o cabeza abajo (la
  // rotacion viene del propio archivo .concepts) y no hay forma de arreglarlo
  // desde ahi. Se resetea al abrir una foto distinta.
  const [rotacion, setRotacion] = useState(0);
  useEffect(() => {
    setRotacion(0);
  }, [src]);

  const exportDrawing = async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
    const img = new Image();
    img.src = src;
    await new Promise((resolve) => {
      img.onload = resolve;
      if (img.complete) resolve(true);
    });

    let exportWidth, exportHeight;
    let translateX, translateY, exportZoom;

    if (zoomAll) {
      // Girada un cuarto de vuelta (90/270), la caja del export se planta
      // con los lados intercambiados: si no, una foto rotada a apaisada se
      // exporta recortada dentro de un lienzo vertical. `% 180` en vez de
      // comparar contra 90/270 a mano: sigue valiendo si el control de
      // rotacion deja de moverse en pasos fijos de 90°.
      const girada90 = ((rotacion % 180) + 180) % 180 !== 0;
      exportWidth = girada90 ? img.naturalHeight : img.naturalWidth;
      exportHeight = girada90 ? img.naturalWidth : img.naturalHeight;
      translateX = exportWidth / 2;
      translateY = exportHeight / 2;
      exportZoom = 1;
    } else {
      const rect = containerRef.current?.getBoundingClientRect();
      exportWidth = rect ? rect.width : window.innerWidth;
      exportHeight = rect ? rect.height : window.innerHeight;
      translateX = exportWidth / 2 + pan.x;
      translateY = exportHeight / 2 + pan.y;
      exportZoom = zoom;
    }

    // safeExportScale (no EXPORT_SCALE crudo): una foto grande, mas si esta
    // rotada 90/270, puede pasarse del limite duro de canvas del navegador
    // (queda en blanco, sin error) o del presupuesto de RAM del dispositivo.
    // Es el mismo criterio que ya usan el export del visor y el de la
    // galeria — este era el unico camino de export que no lo aplicaba.
    const scale = safeExportScale(exportWidth, exportHeight);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.round(exportWidth * scale);
    exportCanvas.height = Math.round(exportHeight * scale);
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (format === 'jpg' || format === 'pdf') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    }

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(translateX, translateY);
    ctx.scale(exportZoom, exportZoom);
    if (rotacion) ctx.rotate((rotacion * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
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
    logDescarga('foto', format, [], fileName);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Mismo patron que Viewer.tsx: un listener nativo no pasivo solo para
  // bloquear el scroll de la pagina detras del visor mientras se hace zoom
  // con la rueda. Sin esto, la pagina se corria hacia abajo/arriba de fondo
  // mientras la foto zoomeaba, un bug que ya estaba arreglado en el visor
  // principal pero no en esta vista.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bloquear = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', bloquear, { passive: false });
    return () => el.removeEventListener('wheel', bloquear);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       setDragStartZoom(zoom);
       setDragStartPan(pan);
    } else if (e.button === 0) {
       // Only start dragging if we clicked the container, or we want to allow dragging everywhere
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

       const centerX = screenX - rect.width / 2;
       const centerY = screenY - rect.height / 2;

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

  // React adjunta onWheel como pasivo: el e.preventDefault() de aca abajo no
  // alcanza a frenar el scroll, asi que ademas se registra un listener nativo
  // no pasivo mas abajo (mismo patron que Viewer.tsx) solo para bloquearlo.
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

  const [touchDistStart, setTouchDistStart] = useState<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
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

      const centerX = screenX - rect.width / 2;
      const centerY = screenY - rect.height / 2;

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
      className="fullscreen-preview"
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
      onClick={(e) => {
         if (e.target === e.currentTarget) {
            onClose();
         }
      }}
      style={{
         cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
         display: 'block',
         padding: 0,
         overflow: 'hidden',
         touchAction: "none"
      }}
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom}) rotate(${rotacion}deg)`,
          transformOrigin: 'center center',
          transition: isDragging || isRightDragging ? 'none' : 'transform 0.1s ease',
        }}
      >
        <img 
           src={src} 
           alt="Preview" 
           style={{ pointerEvents: 'none', userSelect: 'none', display: 'block' }}
           draggable={false}
        />
      </div>
      
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

      {/* Floating Tools exactly like Viewer */}
      <div className="floating-tools" style={{ zIndex: 10002 }}>
        <button
          className="btn-tool"
          onClick={(e) => { e.stopPropagation(); setRotacion((r) => (r + 90) % 360); }}
          title="Rotar 90° a la derecha"
        >
          <RotateCw size={20} />
        </button>
        <div className="dropdown-container">
          <button
            className={`btn-tool ${showExportMenu ? 'active-glow' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowExportMenu(!showExportMenu); }}
            title="Exportar"
          >
            <Download size={20} />
          </button>
          
          {showExportMenu && (
            <div className="dropdown-menu" style={{ minWidth: '150px' }} onClick={(e) => e.stopPropagation()}>
              <div className="layer-menu-header">
                <span>Exportar</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', marginBottom: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={exportZoomAll} onChange={(e) => setExportZoomAll(e.target.checked)} />
                  Completo
                </label>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => exportDrawing('pdf', exportZoomAll)}>📄 PDF</button>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => exportDrawing('jpg', exportZoomAll)}>🖼 JPG</button>
                <button className="btn btn-tiny" style={{ padding: '8px' }} onClick={() => exportDrawing('png', exportZoomAll)}>💠 PNG</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: '20px', right: '20px',
          zIndex: 10001, background: 'rgba(255,255,255,0.2)',
          border: 'none', color: 'white', padding: '8px 16px',
          borderRadius: '4px', cursor: 'pointer'
        }}
      >
        Cerrar (ESC)
      </button>

      {loadingFull && (
        <div
          style={{
            position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10001, display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'rgba(0,0,0,0.55)', color: 'white', padding: '0.4rem 0.9rem',
            borderRadius: '999px', fontSize: '0.8rem', pointerEvents: 'none',
          }}
        >
          <span
            style={{
              width: '8px', height: '8px', borderRadius: '50%', background: '#fff',
              animation: 'pulseDot 1s ease-in-out infinite',
            }}
          />
          Cargando full HD…
        </div>
      )}
    </div>
  );
};
