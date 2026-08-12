import { useState, useRef, useEffect } from 'react';
import { parseConceptsFile } from './parser';
import type { Document } from './parser';
import { Viewer } from './Viewer';
import type { LayerConfig, ViewerHandle } from './Viewer';
import { InteractivePreview } from './InteractivePreview';
import { logDescarga } from '../Gallery/analytics';
import { Eye, EyeOff, Lock, Filter, Image as ImageIcon, X, Download } from 'lucide-react';
import './App.css';

interface ViewerProps {
  fileBuffer: ArrayBuffer;
  fileName: string;
  onClose: () => void;
}

export function ConceptViewer({ fileBuffer, fileName, onClose }: ViewerProps) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ layers: number; strokes: number; images: number } | null>(null);

  // Layer State
  const [layerConfigs, setLayerConfigs] = useState<Record<string, LayerConfig>>({});
  const [isolatedLayer, setIsolatedLayer] = useState<string | null>(null);
  const [exportZoomAll, setExportZoomAll] = useState(true);
  
  // UI State
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [showImageMenu, setShowImageMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  
  // Image Thumbnails & Preview State
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const layerMenuRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowLayerMenu(false);
        setShowImageMenu(false);
        setShowExportMenu(false);
        setPreviewImage(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (previewImage) return; // Prevent closing dropdowns when interacting with preview
      
      if (layerMenuRef.current && !layerMenuRef.current.contains(e.target as Node)) {
        setShowLayerMenu(false);
      }
      if (imageMenuRef.current && !imageMenuRef.current.contains(e.target as Node)) {
        setShowImageMenu(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    if (showLayerMenu || showImageMenu || showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside, true);
      document.addEventListener('touchstart', handleClickOutside, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('touchstart', handleClickOutside, true);
    };
  }, [showLayerMenu, showImageMenu, showExportMenu, previewImage]);

  useEffect(() => {
    const load = async () => {
      try {
        const parsedDoc = await parseConceptsFile(fileBuffer);
        setDoc(parsedDoc);
        let strokesCount = 0;
        let imagesCount = 0;
        const initialConfigs: Record<string, LayerConfig> = {};
        
        parsedDoc.layers.forEach(l => {
          strokesCount += l.strokes.length;
          imagesCount += l.images.length;
          initialConfigs[l.id] = { visible: true, opacity: 1.0 };
        });
        
        setLayerConfigs(initialConfigs);
        setIsolatedLayer(null);
        setStats({ layers: parsedDoc.layers.length, strokes: strokesCount, images: imagesCount });
      } catch (err: any) {
        setError(err.message || "Error al cargar el archivo");
      }
    };
    load();
  }, [fileBuffer]);

  const toggleLayerVisibility = (id: string) => {
    setLayerConfigs(prev => ({
      ...prev,
      [id]: { ...prev[id], visible: !prev[id]?.visible }
    }));
  };

  const setLayerOpacity = (id: string, opacity: number) => {
    setLayerConfigs(prev => ({
      ...prev,
      [id]: { ...prev[id], opacity }
    }));
  };

  const toggleIsolate = (id: string) => {
    setIsolatedLayer(prev => prev === id ? null : id);
  };

  if (error) {
    return (
      <div className="app-container">
        <div className="error-state">
          <h3>Error</h3>
          <p>{error}</p>
          <button className="btn" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    );
  }

  if (!doc || !stats) {
    return (
      <div className="app-container">
        <div className="empty-state">
          <div className="spin-slow">Cargando...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="filename-display">
        {fileName.replace('.concepts', '')}
      </div>

      {/* Top Right: Close Button */}
      <button className="btn-close-viewer" onClick={onClose} title="Cerrar documento">
        <X size={20} />
      </button>

      {/* Bottom Right: Tools */}
      <div className="floating-tools">
        <div className="dropdown-container" ref={exportMenuRef}>
          <button 
            className={`btn-tool ${showExportMenu ? 'active-glow' : ''}`}
            onClick={() => { setShowExportMenu(!showExportMenu); setShowLayerMenu(false); setShowImageMenu(false); }}
            title="Exportar"
          >
            <Download size={20} />
          </button>
          
          {showExportMenu && (
            <div className="dropdown-menu" style={{ minWidth: '150px' }}>
              <div className="layer-menu-header">
                <span>Exportar</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', marginBottom: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={exportZoomAll} onChange={(e) => setExportZoomAll(e.target.checked)} />
                  Completo
                </label>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => { viewerRef.current?.exportDrawing('pdf', exportZoomAll); logDescarga('lienzo', 'pdf', [], fileName); }}>📄 PDF</button>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => { viewerRef.current?.exportDrawing('jpg', exportZoomAll); logDescarga('lienzo', 'jpg', [], fileName); }}>🖼 JPG</button>
                <button className="btn btn-tiny" style={{ padding: '8px' }} onClick={() => { viewerRef.current?.exportDrawing('png', exportZoomAll); logDescarga('lienzo', 'png', [], fileName); }}>💠 PNG</button>
              </div>
            </div>
          )}
        </div>

        <div className="dropdown-container" ref={layerMenuRef}>
          <button 
            className={`btn-tool ${showLayerMenu ? 'active-glow' : ''}`}
            onClick={() => { setShowLayerMenu(!showLayerMenu); setShowImageMenu(false); }}
            title={`Capas: ${stats.layers}`}
          >
            <Filter size={20} />
          </button>
          
          {showLayerMenu && (
            <div className="layer-menu dropdown-menu">
              <div className="layer-menu-header">
                <span>Capas</span>
                <div style={{display:'flex', gap:'4px'}}>
                  <button className="btn btn-tiny" onClick={() => {
                    const newConfigs = {...layerConfigs};
                    Object.keys(newConfigs).forEach(k => {
                      newConfigs[k].visible = true;
                      newConfigs[k].opacity = 1.0;
                    });
                    setLayerConfigs(newConfigs);
                    setIsolatedLayer(null);
                  }}>Restablecer</button>
                  <button className="btn btn-tiny" onClick={() => {
                      const newConfigs = {...layerConfigs};
                      let allVisible = Object.values(newConfigs).every(c => c.visible);
                      Object.keys(newConfigs).forEach(k => newConfigs[k].visible = !allVisible);
                      setLayerConfigs(newConfigs);
                  }}>Alternar</button>
                </div>
              </div>
              <div className="layer-list">
                {doc.layers.map((l, i) => (
                  <div key={l.id} className={`layer-item ${isolatedLayer === l.id ? 'isolated' : ''}`}>
                    <div className="layer-info">
                        <span className="layer-name">Capa {i+1}</span>
                        <span style={{ fontSize: '0.75rem', color: '#888' }}>
                          ({l.strokes.length + l.images.length} elem)
                        </span>
                    </div>
                    <div className="layer-actions">
                        <input 
                          type="range" 
                          min="0" max="1" step="0.05"
                          value={layerConfigs[l.id]?.opacity ?? 1}
                          onChange={(e) => setLayerOpacity(l.id, parseFloat(e.target.value))}
                          className="opacity-slider"
                          title="Opacidad"
                        />
                        <button 
                          className="icon-btn" 
                          onClick={() => toggleLayerVisibility(l.id)}
                          title="Mostrar/Ocultar"
                        >
                          {layerConfigs[l.id]?.visible ? <Eye size={16}/> : <EyeOff size={16} color="#aaa"/>}
                        </button>
                        <button 
                          className={`icon-btn ${isolatedLayer === l.id ? 'active-icon' : ''}`} 
                          onClick={() => toggleIsolate(l.id)}
                          title="Aislar capa"
                        >
                          <Lock size={16} />
                        </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="dropdown-container" ref={imageMenuRef}>
          <button 
            className={`btn-tool ${showImageMenu ? 'active-glow' : ''}`}
            onClick={() => { setShowImageMenu(!showImageMenu); setShowLayerMenu(false); }}
            title={`Imágenes: ${stats.images}`}
          >
            <ImageIcon size={20} />
          </button>
          
          {showImageMenu && (
            <div className="image-menu dropdown-menu">
              <div className="layer-menu-header">
                <span>Galería</span>
                <span style={{fontSize:'0.7rem', color:'#888'}}>ESC para cerrar</span>
              </div>
              <div className="image-gallery">
                {Object.entries(doc.resources).length > 0 ? Object.entries(doc.resources).map(([id]) => {
                  const url = imageUrls[id];
                  return (
                    <div key={id} className="gallery-item" onClick={() => url && setPreviewImage(url)}>
                        {url ? (
                          <img src={url} alt="Recurso" />
                        ) : (
                          <div className="pdf-thumbnail spin-slow">...</div>
                        )}
                    </div>
                  );
                }) : (
                  <div style={{padding:'1rem', textAlign:'center', color:'#888'}}>No hay recursos embebidos.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <main className="main-content">
        <div className="canvas-wrapper">
          <Viewer 
            ref={viewerRef}
            doc={doc} 
            layerConfigs={layerConfigs} 
            isolatedLayer={isolatedLayer} 
            onImagesLoaded={(urls) => setImageUrls(urls)}
          />
        </div>

        {previewImage && (
          <InteractivePreview src={previewImage} fileName={fileName} onClose={() => setPreviewImage(null)} />
        )}
      </main>
    </div>
  );
}

export default ConceptViewer;
