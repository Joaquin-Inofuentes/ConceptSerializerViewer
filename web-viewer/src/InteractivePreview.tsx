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
       const screenX = lastMousePos.x - rect.left;
       const screenY = lastMousePos.y - rect.top;

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
      className="fullscreen-preview"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
         cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
         display: 'block',
         padding: 0,
         overflow: 'hidden'
      }}
    >
      <div 
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
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
