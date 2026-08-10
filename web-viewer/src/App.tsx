import { useState } from 'react';
import { parseConceptsFile } from './parser';
import type { Document } from './parser';
import { Viewer } from './Viewer';
import { Play, UploadCloud, AlertCircle, Loader2 } from 'lucide-react';
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
      setError(err.message || "Error al cargar el archivo .concepts");
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
      setError(err.message || "Error al leer el archivo .concepts (Asegurate que sea válido)");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="glass-header">
        <div className="header-content">
          <h1>ConceptSerializer <span className="badge">Viewer</span></h1>
          <p className="subtitle">Visualizador 2D interactivo para archivos .concepts</p>
        </div>
      </header>

      <main className="main-content">
        {!doc && (
          <div className="upload-section">
            <div className="upload-card">
              <UploadCloud className="upload-icon" size={64} />
              <h2>Sube tu archivo .concepts</h2>
              <p>O utiliza el ejemplo integrado para testear el renderizado.</p>
              
              <div className="actions">
                <label className="btn btn-primary">
                  <span>Seleccionar Archivo</span>
                  <input type="file" accept=".concepts" onChange={handleFileUpload} hidden />
                </label>
                <button className="btn btn-secondary" onClick={loadExample} disabled={loading}>
                  {loading ? <Loader2 className="spin" /> : <Play />}
                  <span>Probar Dibujo12.concepts</span>
                </button>
              </div>

              {error && (
                <div className="error-alert">
                  <AlertCircle size={20} />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {doc && (
          <div className="viewer-container">
            <div className="toolbar">
              <div className="stats">
                <span className="stat-pill">Capas: {stats?.layers}</span>
                <span className="stat-pill">Trazos: {stats?.strokes}</span>
                <span className="stat-pill">Imágenes: {stats?.images}</span>
              </div>
              <button className="btn btn-small" onClick={() => setDoc(null)}>Cerrar Visor</button>
            </div>
            <div className="canvas-wrapper">
              <Viewer doc={doc} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
