import { useState } from 'react';
import { parseConceptsFile } from './parser';
import type { Document } from './parser';
import { Viewer } from './Viewer';
import { Upload, X } from 'lucide-react';
import './App.css';

function App() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ layers: number; strokes: number; images: number } | null>(null);

  const loadExample = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/Dibujo12.concepts');
      if (!response.ok) throw new Error("Failed to fetch example file.");
      const buffer = await response.arrayBuffer();
      
      const parsedDoc = await parseConceptsFile(buffer);
      setDoc(parsedDoc);
      
      let strokesCount = 0;
      let imagesCount = 0;
      parsedDoc.layers.forEach(l => {
        strokesCount += l.strokes.length;
        imagesCount += l.images.length;
      });
      setStats({ layers: parsedDoc.layers.length, strokes: strokesCount, images: imagesCount });
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
      const parsedDoc = await parseConceptsFile(buffer);
      setDoc(parsedDoc);
      
      let strokesCount = 0;
      let imagesCount = 0;
      parsedDoc.layers.forEach(l => {
        strokesCount += l.strokes.length;
        imagesCount += l.images.length;
      });
      setStats({ layers: parsedDoc.layers.length, strokes: strokesCount, images: imagesCount });
    } catch (err: any) {
      setError(err.message || "Error al leer el archivo");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* 1 Solo Renglón Delgado */}
      <header className="toolbar-slim">
        <div className="toolbar-brand">
          ConceptSerializer <span className="badge">Viewer</span>
        </div>
        <div className="toolbar-subtitle">
          Visualizador 2D interactivo para archivos .concepts
        </div>
        
        {doc && stats && (
          <div className="stats">
            <span className="stat-pill">Capas: {stats.layers}</span>
            <span className="stat-pill">Trazos: {stats.strokes}</span>
            <span className="stat-pill">Imágenes: {stats.images}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginLeft: doc ? 'auto' : '0' }}>
          {!doc ? (
             <>
               <label className="btn">
                 <Upload size={14} /> Subir archivo
                 <input type="file" accept=".concepts" onChange={handleFileUpload} hidden />
               </label>
               <button className="btn btn-primary" onClick={loadExample} disabled={loading}>
                 {loading ? 'Cargando...' : 'Probar Ejemplo'}
               </button>
             </>
          ) : (
             <button className="btn" onClick={() => setDoc(null)}>
               <X size={14} /> Cerrar Visor
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
            <Viewer doc={doc} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
