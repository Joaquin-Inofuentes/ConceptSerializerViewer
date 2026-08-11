import { useState } from 'react';
import { ConceptViewer } from './VisorConcept';
import { Upload } from 'lucide-react';
import './index.css';

function App() {
  const [fileData, setFileData] = useState<{ buffer: ArrayBuffer; name: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      setFileData({ buffer, name: file.name });
    } catch (err: any) {
      setError(err.message || "Error al leer el archivo");
    } finally {
      setLoading(false);
    }
  };

  const loadExample = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/Dibujo12.concepts');
      if (!response.ok) throw new Error("Failed to fetch example file.");
      const buffer = await response.arrayBuffer();
      setFileData({ buffer, name: 'Dibujo12.concepts' });
    } catch (err: any) {
      setError(err.message || "Error al cargar el archivo de ejemplo");
    } finally {
      setLoading(false);
    }
  };

  if (fileData) {
    return (
      <ConceptViewer 
        fileBuffer={fileData.buffer} 
        fileName={fileData.name} 
        onClose={() => setFileData(null)} 
      />
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '20px',
      fontFamily: 'sans-serif', backgroundColor: '#f8f9fa'
    }}>
      <h1 style={{color: '#333'}}>ConceptSerializer Viewer</h1>
      
      <div style={{ display: 'flex', gap: '15px' }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
          padding: '10px 20px', background: '#fff', border: '1px solid #dee2e6', borderRadius: '8px',
          boxShadow: '0 2px 5px rgba(0,0,0,0.05)', fontWeight: 500, color: '#333'
        }}>
          <Upload size={18} /> Subir archivo .concepts
          <input type="file" accept=".concepts" onChange={handleFileUpload} hidden />
        </label>
        
        <button 
          onClick={loadExample} 
          disabled={loading}
          style={{
            padding: '10px 20px', background: '#0d6efd', color: '#fff', border: 'none', borderRadius: '8px',
            cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 500, opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? 'Cargando...' : 'Probar Ejemplo'}
        </button>
      </div>

      {error && <div style={{color: 'red', marginTop: '10px'}}>{error}</div>}
    </div>
  );
}

export default App;
