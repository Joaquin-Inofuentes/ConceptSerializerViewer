import { useState, useRef, useEffect } from 'react';
import { parseConceptsFile } from './parser';
import type { Document } from './parser';
import { Viewer } from './Viewer';
import type { LayerConfig } from './Viewer';
import { Upload, Eye, EyeOff, Lock } from 'lucide-react';
import './App.css';

function App() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ layers: number; strokes: number; images: number } | null>(null);

  // Layer State
  const [layerConfigs, setLayerConfigs] = useState<Record<string, LayerConfig>>({});
  const [isolatedLayer, setIsolatedLayer] = useState<string | null>(null);
  
  // UI State
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [showImageMenu, setShowImageMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const layerMenuRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowLayerMenu(false);
        setShowImageMenu(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (layerMenuRef.current && !layerMenuRef.current.contains(e.target as Node)) {
        setShowLayerMenu(false);
      }
      if (imageMenuRef.current && !imageMenuRef.current.contains(e.target as Node)) {
        setShowImageMenu(false);
      }
    };
    if (showLayerMenu || showImageMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showLayerMenu, showImageMenu]);

  const initDoc = (parsedDoc: Document) => {
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
  };

  const loadExample = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/Dibujo12.concepts');
      if (!response.ok) throw new Error("Failed to fetch example file.");
      const buffer = await response.arrayBuffer();
      initDoc(await parseConceptsFile(buffer));
    } catch (err: any) {
      setError(err.message || "Error al cargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      initDoc(await parseConceptsFile(buffer));
    } catch (err: any) {
      setError(err.message || "Error al leer el archivo");
    } finally {
      setLoading(false);
    }
  };

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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!doc) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.name.endsWith('.concepts')) {
      setError("Solo se admiten archivos .concepts");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      initDoc(await parseConceptsFile(buffer));
    } catch (err: any) {
      setError(err.message || "Error al leer el archivo");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="app-container" 
      onDragOver={handleDragOver} 
      onDragLeave={handleDragLeave} 
      onDrop={handleDrop}
    >
      {isDragging && !doc && (
        <div className="drag-overlay">
          <h2>Suelta el archivo .concepts aquí</h2>
        </div>
      )}
      {/* Ultra Minimalist Topbar */}
      <header className="toolbar-slim">
        <div className="toolbar-brand">
          Visor de concepts
        </div>
        
        {doc && stats ? (
          <div className="stats">
            <div className="dropdown-container" ref={layerMenuRef}>
              <button 
                className={`btn btn-dropdown ${showLayerMenu ? 'active' : ''}`}
                onClick={() => setShowLayerMenu(!showLayerMenu)}
              >
                Capas : {stats.layers}
              </button>
              
              {showLayerMenu && (
                <div className="layer-menu dropdown-menu">
                  <div className="layer-menu-header">
                    <span>Ajustes de Capas</span>
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
            
            <div className="btn btn-dropdown" style={{cursor: 'default'}}>
              Trazos : {stats.strokes}
            </div>

            <div className="dropdown-container" ref={imageMenuRef}>
              <button 
                className={`btn btn-dropdown ${showImageMenu ? 'active' : ''}`}
                onClick={() => setShowImageMenu(!showImageMenu)}
              >
                Imágenes : {stats.images}
              </button>
              
              {showImageMenu && (
                <div className="image-menu dropdown-menu">
                  <div className="layer-menu-header">
                    <span>Galería ({stats.images})</span>
                    <span style={{fontSize:'0.7rem', color:'#888'}}>ESC para cerrar</span>
                  </div>
                  <div className="image-gallery">
                    {Object.entries(doc.resources).length > 0 ? Object.entries(doc.resources).map(([id, blob]) => {
                      const url = URL.createObjectURL(blob);
                      const isPDF = blob.type === 'application/pdf' || blob.type === ''; 
                      return (
                        <div key={id} className="gallery-item">
                           {isPDF ? (
                             <div className="pdf-thumbnail">PDF</div>
                           ) : (
                             <img src={url} alt="Recurso" />
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
        ) : <div className="stats-spacer"></div>}

        <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
          {!doc ? (
             <>
               <label className="btn">
                 <Upload size={14} /> Subir
                 <input type="file" accept=".concepts" onChange={handleFileUpload} hidden />
               </label>
               <button className="btn btn-primary" onClick={loadExample} disabled={loading}>
                 {loading ? 'Cargando...' : 'Probar Ejemplo'}
               </button>
             </>
          ) : (
             <button className="btn" onClick={() => setDoc(null)}>
               Cerrar
             </button>
          )}
        </div>

        {error && <div className="error-text">{error}</div>}
      </header>

      <main className="main-content">
        {!doc && (
          <div className="empty-state">
            <h3>Visor Vacío</h3>
            <p>Sube un archivo o usa el botón de "Probar Ejemplo" arriba a la derecha.</p>
          </div>
        )}

        {doc && (
          <div className="canvas-wrapper">
            <Viewer doc={doc} layerConfigs={layerConfigs} isolatedLayer={isolatedLayer} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
