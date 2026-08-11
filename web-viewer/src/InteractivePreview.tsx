import React, { useRef, useState, useEffect } from 'react';

interface InteractivePreviewProps {
  src: string;
  onClose: () => void;
}

export const InteractivePreview: React.FC<InteractivePreviewProps> = ({ src, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isRightDragging, setIsRightDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setLastMousePos({ x: e.clientX, y: e.clientY });
    } else if (e.button === 0) {
       // Only start dragging if we clicked the container, or we want to allow dragging everywhere
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
       const mouseX = lastMousePos.x - rect.left;
       const mouseY = lastMousePos.y - rect.top;

       const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom);
       const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom);

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
      className="fullscreen-preview"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
         cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab")
      }}
    >
      <div 
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isDragging || isRightDragging ? 'none' : 'transform 0.1s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <img 
           src={src} 
           alt="Preview" 
           style={{ pointerEvents: 'none', userSelect: 'none' }}
           draggable={false}
        />
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
    </div>
  );
};
