import { useState, useRef, useEffect, useCallback } from 'react';
import { openConceptsRemote, openConceptsLocal } from './parser';
import type { Document } from './parser';
import { SeguidorProgreso, TEXTO_FASE, formatearRestante, formatearMB } from './progreso';
import type { EstadoProgreso } from './progreso';
import { Viewer } from './Viewer';
import type { LayerConfig, ViewerHandle } from './Viewer';
import { InteractivePreview } from './InteractivePreview';
import { logDescarga } from '../Gallery/analytics';
import { driveFileUrl, driveAuthHeaders } from '../Gallery/driveClient';
import type { FileSourceRef } from '../App';
import { Eye, EyeOff, Lock, Filter, Image as ImageIcon, X, Download, Maximize2 } from 'lucide-react';
import './App.css';

interface ViewerProps {
  source: FileSourceRef;
  onClose: () => void;
}

/**
 * Barra de carga con fase, porcentaje real y tiempo estimado.
 *
 * El porcentaje sale de los bytes que de verdad hay que traer (se conocen
 * apenas se lee el indice del zip). Mientras no se sepa, la barra va
 * indeterminada en vez de mostrar un numero inventado.
 */
function BarraCarga({ progreso }: { progreso: EstadoProgreso | null }) {
  if (!progreso || progreso.fase === 'listo') return null;
  const pct = progreso.porcentaje;
  const restante = formatearRestante(progreso.segundosRestantes);

  return (
    <div className="viewer-carga" role="status" aria-live="polite">
      <div className="viewer-carga-cabecera">
        <span className="viewer-loading-dot" />
        <span className="viewer-carga-fase">{TEXTO_FASE[progreso.fase]}</span>
        {progreso.detalle && <span className="viewer-carga-detalle">{progreso.detalle}</span>}
        {pct !== null && <span className="viewer-carga-pct">{Math.round(pct)}%</span>}
      </div>
      <div className={`viewer-carga-riel ${pct === null ? 'indeterminada' : ''}`}>
        <div className="viewer-carga-relleno" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="viewer-carga-pie">
        <span>
          {formatearMB(progreso.bytesRecibidos)}
          {progreso.bytesEsperados ? ` de ${formatearMB(progreso.bytesEsperados)}` : ''}
          {progreso.velocidadKBs ? ` · ${progreso.velocidadKBs} kB/s` : ''}
        </span>
        {restante && <span>faltan {restante}</span>}
      </div>
    </div>
  );
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
  const [progreso, setProgreso] = useState<EstadoProgreso | null>(null);
  /** Cuantos planos se estan afinando y cuantos hay que traer de la red. Se
   * distinguen porque para el usuario no es lo mismo esperar un instante que
   * esperar 30 s de 4G. */
  const [refinando, setRefinando] = useState({ afinar: 0, traer: 0 });
  /** El usuario ya toco el lienzo: se saca la vista previa de encima. */
  const [previaDescartada, setPreviaDescartada] = useState(false);
  /** Planos que no se pudieron traer. Se avisa en vez de decir "listo". */
  const [fallidos, setFallidos] = useState(0);
  const seguidorRef = useRef<SeguidorProgreso | null>(null);

  // Layer State
  const [layerConfigs, setLayerConfigs] = useState<Record<string, LayerConfig>>({});
  const [isolatedLayer, setIsolatedLayer] = useState<string | null>(null);
  /** Opacidad SOLO de las fotos/PDFs, independiente de la opacidad por capa
   * (esa mezcla trazos e imagenes de la misma capa). Vive aca y no por capa
   * porque el pedido es "las imagenes mas tenues", sin importar en que capa
   * este cada una. */
  const [imageOpacity, setImageOpacity] = useState(1);
  const [exportZoomAll, setExportZoomAll] = useState(true);
  
  // UI State
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [showImageMenu, setShowImageMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  
  // Image Thumbnails & Preview State
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // La miniatura de la galeria (`imageUrls[id]`) es una previsualizacion
  // chica (384px de lado, ver `pedirPreviews` en Viewer.tsx) sacada del
  // bitmap que en ESE momento tenga cacheado el lienzo principal — que
  // puede ser un RECORTE si el usuario hizo zoom sobre ese recurso. Abrir
  // la foto a pantalla completa mostrando eso directamente es el bug de
  // "sale recortada y nunca llega a full HD": no hay ningun pedido de mas
  // resolucion, la miniatura chica es lo unico que se muestra siempre.
  // Ahora se abre con esa miniatura al instante (no dejar la pantalla en
  // blanco) y en paralelo se pide la version completa sin recortar
  // (`obtenerImagenCompleta`, ver Viewer.tsx) para reemplazarla apenas
  // llega.
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewLoadingFull, setPreviewLoadingFull] = useState(false);
  // Se incrementa en cada apertura/cierre: si el pedido de full-res de una
  // foto vieja resuelve DESPUES de que el usuario ya cerro o abrio otra,
  // este token evita que ese resultado tardio pise la foto actual (o
  // reabra el visor de fotos ya cerrado).
  const previewTokenRef = useRef(0);

  const cerrarFoto = useCallback(() => {
    previewTokenRef.current++;
    setPreviewImage(null);
    setPreviewLoadingFull(false);
  }, []);

  const abrirFoto = useCallback((resourceId: string, thumbUrl: string) => {
    previewTokenRef.current++;
    const token = previewTokenRef.current;
    setPreviewImage(thumbUrl);
    setPreviewLoadingFull(true);
    void viewerRef.current
      ?.obtenerImagenCompleta(resourceId)
      .then((full) => {
        if (previewTokenRef.current !== token) return;
        if (full) setPreviewImage(full);
        setPreviewLoadingFull(false);
      })
      .catch(() => {
        if (previewTokenRef.current !== token) return;
        setPreviewLoadingFull(false);
      });
  }, []);

  const layerMenuRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  // Expuesto para benchmarks/diagnostico, mismo patron que
  // `__conceptsPedirPreviews` en Viewer.tsx: permite probar el flujo
  // miniatura -> full HD de la galeria de fotos sin instrumentar la UI.
  useEffect(() => {
    (window as any).__conceptsAbrirFoto = abrirFoto;
    (window as any).__conceptsPreviewState = () => ({ previewImage, previewLoadingFull });
    (window as any).__conceptsResourceIds = () => doc?.resourceIds ?? [];
    return () => {
      delete (window as any).__conceptsAbrirFoto;
      delete (window as any).__conceptsPreviewState;
      delete (window as any).__conceptsResourceIds;
    };
  }, [abrirFoto, previewImage, previewLoadingFull, doc]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowLayerMenu(false);
        setShowImageMenu(false);
        setShowExportMenu(false);
        cerrarFoto();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cerrarFoto]);

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
    setPreviaDescartada(false);
    setFallidos(0);
    setProgresoRecursos(null);
    setPlaceholder(null);
    setDoc(null);
    setStats(null);
    setError(null);
    let cancelado = false;
    faseDibujandoRef.current = false;
    let docCreado: Document | null = null;
    let urlPlaceholder: string | null = null;

    const seguidor = new SeguidorProgreso((e) => {
      if (!cancelado) setProgreso(e);
    });
    seguidorRef.current = seguidor;
    seguidor.cambiarFase('abriendo');

    (async () => {
      // El archivo se abre UNA sola vez y de ahi salen las dos cosas: la
      // vista previa y el documento. Abrir dos lectores pagaba dos veces la
      // lectura del indice del zip, que a traves del proxy de Drive es una
      // ida y vuelta de ~1,7 s.
      let archivo: Awaited<ReturnType<typeof openConceptsRemote>>;
      try {
        archivo =
          source.kind === 'remote'
            ? await openConceptsRemote(driveFileUrl(source.fileId), driveAuthHeaders(), {
                onBytes: (n) => seguidor.sumarBytes(n),
              })
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
      seguidor.cambiarFase('descargando', 'vista previa');
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
      seguidor.cambiarFase('procesando', 'trazos y capas');
      try {
        const parsedDoc = await archivo.parse();
        if (cancelado) {
          parsedDoc.close();
          return;
        }
        docCreado = parsedDoc;
        // Aca NO se fija el total: `bytesNecesarios` suma TODOS los recursos
        // colocados, y el visor solo baja los que entran en pantalla y son lo
        // bastante grandes. El total real lo informa el visor apenas decide
        // que va a traer (`onBytesPrevistos`); hasta entonces la barra va
        // indeterminada, que es honesto.

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
        seguidor.cambiarFase(
          parsedDoc.resourceIds.length > 0 ? 'descargando' : 'listo',
          parsedDoc.resourceIds.length > 0 ? `0 de ${parsedDoc.resourceIds.length} imágenes` : null
        );
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

  // Los callbacks que recibe el Viewer se declaran con identidad ESTABLE.
  //
  // Escritos como arrows inline, cada render de este componente le pasaba al
  // Viewer cuatro funciones nuevas. Y este componente re-renderiza mucho
  // durante la carga: el progreso de bytes avisa ~10 veces por segundo y cada
  // recurso que termina dispara otro. Con props nuevas, `React.memo` no sirve
  // de nada y el Viewer se re-renderiza entero cada vez — en el perfil de una
  // tanda de gestos, React era el 13% del hilo principal.
  const alCargarImagenes = useCallback((urls: Record<string, string>) => {
    setImageUrls(urls);
  }, []);

  const alTerminarRecursos = useCallback(() => {
    setRecursosListos(true);
    seguidorRef.current?.cambiarFase('listo');
  }, []);

  const faseDibujandoRef = useRef(false);
  const alAvanzarRecursos = useCallback((listos: number, total: number) => {
    setProgresoRecursos({ listos, total });
    // La fase se cambia UNA vez; el resto de los avisos van por `fijarDetalle`,
    // que respeta el limitador de 100 ms. `cambiarFase` fuerza el aviso, asi
    // que llamarlo por cada recurso provocaba un render extra cada vez aunque
    // la fase fuera la misma.
    if (!faseDibujandoRef.current) {
      faseDibujandoRef.current = true;
      seguidorRef.current?.cambiarFase('dibujando', `${listos} de ${total} imágenes`);
    } else {
      seguidorRef.current?.fijarDetalle(`${listos} de ${total} imágenes`);
    }
  }, []);

  const alRefinar = useCallback((activo: boolean, aAfinar: number, aTraer: number) => {
    setRefinando(activo ? { afinar: aAfinar, traer: aTraer } : { afinar: 0, traer: 0 });
  }, []);

  // El peso REAL de lo que se va a bajar. El documento declara el de todos los
  // recursos colocados —250 MB en el mas pesado— pero solo viajan los que se
  // ven: ~11 MB. Con el numero declarado, la barra mostraba 3% y "faltan 14
  // min" en una apertura de 50 s, y el usuario cerraba la app.
  const alPreverBytes = useCallback((bytes: number) => {
    seguidorRef.current?.fijarEsperados(bytes);
  }, []);

  const alPrimerGesto = useCallback(() => setPreviaDescartada(true), []);
  const alFallar = useCallback((cuantos: number) => setFallidos(cuantos), []);

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
          <BarraCarga progreso={progreso} />
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
        {/* Encuadrar todo: vuelve a la vista completa del dibujo despues de
            haberse acercado. Mismo estilo que el resto de las herramientas. */}
        <button
          className="btn-tool"
          onClick={() => viewerRef.current?.zoomAll()}
          title="Ver todo el dibujo"
          aria-label="Ver todo el dibujo"
        >
          <Maximize2 size={20} />
        </button>

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
              // la mayoria de los usuarios nunca abre este menu. Se piden en
              // CADA apertura (no una sola vez por documento): las fotos que
              // llegaron despues de la primera vez nunca aparecian.
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}>
                <ImageIcon size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={imageOpacity}
                  onChange={(e) => setImageOpacity(parseFloat(e.target.value))}
                  className="opacity-slider"
                  style={{ flex: 1 }}
                  title="Opacidad de las imágenes"
                  aria-label="Opacidad de las imágenes"
                />
                <span style={{ fontSize: '0.75rem', color: '#888', minWidth: '2.5em', textAlign: 'right' }}>
                  {Math.round(imageOpacity * 100)}%
                </span>
              </div>
              <div className="image-gallery">
                {/* Las que no tienen preview NO son un error: son fotos que
                    todavia no se bajaron porque a este zoom miden pocos
                    pixeles. Antes se les mostraba "..." girando en rojo, para
                    siempre — la grilla parecia una pantalla de errores cuando
                    en realidad es el comportamiento normal, y ademas no se
                    comunicaba en ningun lado que hay que acercarse. */}
                {doc.resourceIds.length > 0 ? doc.resourceIds.map((id) => {
                  const url = imageUrls[id];
                  return (
                    <div
                      key={id}
                      className={`gallery-item ${url ? '' : 'gallery-item-lejos'}`}
                      onClick={() => url && abrirFoto(id, url)}
                      title={url ? 'Ver la foto' : 'Acercate en el dibujo para traerla'}
                    >
                        {url ? (
                          <img src={url} alt="Recurso" />
                        ) : (
                          <span className="gallery-item-aviso">Acercate<br />para verla</span>
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
            imageOpacity={imageOpacity}
            onImagesLoaded={alCargarImagenes}
            onResourcesReady={alTerminarRecursos}
            onResourceProgress={alAvanzarRecursos}
            onRefinando={alRefinar}
            onBytesPrevistos={alPreverBytes}
            onPrimerGesto={alPrimerGesto}
            onFallidos={alFallar}
          />
          {/* Al acercarse, los planos se vuelven a rasterizar a mas resolucion.
              Mientras tanto se sigue viendo la version anterior, y sin avisar
              eso se lee como "quedo borroso" en vez de "esta afinando". */}
          {recursosListos && (refinando.afinar > 0 || refinando.traer > 0) && (
            <div className="viewer-refinando">
              <span className="viewer-loading-dot" />
              {refinando.traer > 0
                ? `Trayendo ${refinando.traer} plano${refinando.traer === 1 ? '' : 's'}…`
                : `Afinando ${refinando.afinar} plano${refinando.afinar === 1 ? '' : 's'}…`}
            </div>
          )}
          {/* La vista previa se mantiene hasta que aparece la PRIMERA imagen,
              no hasta que se decodifica el documento. En estos dibujos los
              trazos son anotaciones finas sobre los planos, asi que mostrar
              solo los trazos daba un lienzo practicamente vacio durante toda
              la carga de las fotos (medido: ~28 s en el dibujo de 262 MB).
              Con esto el usuario ve su dibujo completo todo el tiempo, y el
              lienzo real lo reemplaza cuando ya tiene contenido. */}
          {/* Un plano que no se pudo traer se dice, no se esconde: antes la
              app afirmaba "listo" con recuadros vacios y sin ninguna pista de
              que faltaba algo ni de por que. */}
          {fallidos > 0 && (
            <div className="viewer-fallidos" role="status">
              {fallidos} plano{fallidos === 1 ? '' : 's'} no se pudo cargar
            </div>
          )}
          {placeholder && doc.resourceIds.length > 0 && !recursosListos && !previaDescartada && !(progresoRecursos && progresoRecursos.listos > 0) && (
            <div className="viewer-placeholder viewer-placeholder-overlay">
              <img src={placeholder} alt="" className="viewer-placeholder-img" />
            </div>
          )}
          {!recursosListos && doc.resourceIds.length > 0 && <BarraCarga progreso={progreso} />}
        </div>

        {previewImage && (
          <InteractivePreview
            src={previewImage}
            fileName={fileName}
            loadingFull={previewLoadingFull}
            onClose={cerrarFoto}
          />
        )}
      </main>
    </div>
  );
}

export default ConceptViewer;
