import { useState, useRef, useEffect } from 'react';
import { openConceptsRemote, openConceptsLocal } from './parser';
import type { Document } from './parser';
import { Viewer } from './Viewer';
import type { LayerConfig, ViewerHandle } from './Viewer';
import { InteractivePreview } from './InteractivePreview';
import { logDescarga } from '../Gallery/analytics';
import { driveFileUrl, driveAuthHeaders } from '../Gallery/driveClient';
import type { FileSourceRef } from '../App';
import { Eye, EyeOff, Lock, Filter, Image as ImageIcon, X, Download } from 'lucide-react';
import './App.css';

interface ViewerProps {
  source: FileSourceRef;
  onClose: () => void;
}

export function ConceptViewer({ source, onClose }: ViewerProps) {
  const fileName = source.name;
  const fileId = source.kind === 'remote' ? source.fileId : null;
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ layers: number; strokes: number; images: number } | null>(null);
  // Vista previa que Concepts guarda dentro del archivo. Se muestra apenas
  // llega (~110 KB por rangos, menos de un segundo) mientras se decodifica el
  // documento: el usuario ve SU dibujo enseguida en vez de un lienzo vacio.
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  // Los trazos se ven enseguida; las fotos/PDFs embebidos tardan un poco mas
  // en rasterizarse. Se avisa en vez de dejar el lienzo a medio dibujar sin
  // explicacion.
  const [recursosListos, setRecursosListos] = useState(false);
  const [progresoRecursos, setProgresoRecursos] = useState<{ listos: number; total: number } | null>(null);

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
    setRecursosListos(false);
    setProgresoRecursos(null);
    setPlaceholder(null);
    setDoc(null);
    setStats(null);
    setError(null);
    let cancelado = false;
    let docCreado: Document | null = null;
    let urlPlaceholder: string | null = null;

    (async () => {
      // El archivo se abre UNA sola vez y de ahi salen las dos cosas: la
      // vista previa y el documento. Abrir dos lectores pagaba dos veces la
      // lectura del indice del zip, que a traves del proxy de Drive es una
      // ida y vuelta de ~1,7 s.
      let archivo: Awaited<ReturnType<typeof openConceptsRemote>>;
      try {
        archivo =
          source.kind === 'remote'
            ? await openConceptsRemote(driveFileUrl(source.fileId), driveAuthHeaders())
            : await openConceptsLocal(source.file);
      } catch (err: any) {
        if (!cancelado) setError(err?.message || 'No se pudo abrir el archivo');
        return;
      }
      if (cancelado) {
        archivo.close();
        return;
      }

      // 1) Vista previa embebida primero: son ~110 KB y da feedback inmediato
      //    incluso en el dibujo de 262 MB.
      try {
        const blob = await archivo.thumbnail();
        if (blob && !cancelado) {
          urlPlaceholder = URL.createObjectURL(blob);
          setPlaceholder(urlPlaceholder);
        }
      } catch {
        // Sin vista previa se sigue igual, solo que sin placeholder.
      }

      // 2) El documento (trazos y capas): solo tree.pack, ~1 MB.
      try {
        const parsedDoc = await archivo.parse();
        if (cancelado) {
          parsedDoc.close();
          return;
        }
        docCreado = parsedDoc;

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
        setDoc(parsedDoc);
      } catch (err: any) {
        if (!cancelado) setError(err.message || "Error al cargar el archivo");
      }
    })();

    return () => {
      cancelado = true;
      // Cerrar el documento suelta el archivo y las conexiones de rango. Sin
      // esto, abrir y cerrar dibujos pesados va dejando fuentes vivas.
      docCreado?.close();
      if (urlPlaceholder) URL.revokeObjectURL(urlPlaceholder);
    };
  }, [source]);

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
    // Mientras se decodifica el documento se muestra la vista previa que trae
    // el propio archivo: el usuario reconoce su dibujo de inmediato en vez de
    // mirar un spinner sobre fondo vacio.
    return (
      <div className="app-container">
        <div className="filename-display">{fileName.replace('.concepts', '')}</div>
        <button className="btn-close-viewer" onClick={onClose} title="Cerrar documento">
          <X size={20} />
        </button>
        <div className="viewer-placeholder">
          {placeholder && <img src={placeholder} alt="" className="viewer-placeholder-img" />}
          <div className="viewer-loading-badge">
            <span className="viewer-loading-dot" />
            Abriendo dibujo…
          </div>
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
            onClick={() => {
              const abriendo = !showImageMenu;
              setShowImageMenu(abriendo);
              setShowLayerMenu(false);
              // Las previews se generan recien aca: es un loop de toDataURL
              // en el hilo principal que en gama baja cuesta cientos de ms, y
              // la mayoria de los usuarios nunca abre este menu.
              if (abriendo) void (window as any).__conceptsPedirPreviews?.();
            }}
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
                {doc.resourceIds.length > 0 ? doc.resourceIds.map((id) => {
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
            fileId={fileId}
            layerConfigs={layerConfigs}
            isolatedLayer={isolatedLayer}
            onImagesLoaded={(urls) => setImageUrls(urls)}
            onResourcesReady={() => setRecursosListos(true)}
            onResourceProgress={(listos, total) => setProgresoRecursos({ listos, total })}
          />
          {/* La vista previa se mantiene hasta que aparece la PRIMERA imagen,
              no hasta que se decodifica el documento. En estos dibujos los
              trazos son anotaciones finas sobre los planos, asi que mostrar
              solo los trazos daba un lienzo practicamente vacio durante toda
              la carga de las fotos (medido: ~28 s en el dibujo de 262 MB).
              Con esto el usuario ve su dibujo completo todo el tiempo, y el
              lienzo real lo reemplaza cuando ya tiene contenido. */}
          {placeholder && doc.resourceIds.length > 0 && !recursosListos && !(progresoRecursos && progresoRecursos.listos > 0) && (
            <div className="viewer-placeholder viewer-placeholder-overlay">
              <img src={placeholder} alt="" className="viewer-placeholder-img" />
            </div>
          )}
          {!recursosListos && doc.resourceIds.length > 0 && (
            <div className="viewer-loading-badge">
              <span className="viewer-loading-dot" />
              {progresoRecursos
                ? `Cargando imágenes ${progresoRecursos.listos}/${doc.resourceIds.length}…`
                : `Cargando ${doc.resourceIds.length} imagen${doc.resourceIds.length === 1 ? "" : "es"}…`}
            </div>
          )}
        </div>

        {previewImage && (
          <InteractivePreview src={previewImage} fileName={fileName} onClose={() => setPreviewImage(null)} />
        )}
      </main>
    </div>
  );
}

export default ConceptViewer;
