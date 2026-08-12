import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ConceptViewer } from './VisorConcept';
import { Gallery } from './Gallery/Gallery';
import { NamePrompt } from './Gallery/NamePrompt';
import { logCerrar } from './Gallery/analytics';
import { getUserName, setUserName } from './Gallery/userIdentity';
import './index.css';

interface FileData {
  buffer: ArrayBuffer;
  name: string;
  originRect: DOMRect | null;
  driveFileId: string | null;
}

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];

function App() {
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [userName, setUserNameState] = useState<string | null>(() => getUserName());
  const heroRef = useRef<HTMLDivElement>(null);

  const submitUserName = (name: string) => {
    setUserName(name);
    setUserNameState(name);
  };
  // AnimatePresence congela las props del elemento saliente mientras anima
  // el cierre, asi que un segundo click en "cerrar" durante ese fade puede
  // volver a disparar el mismo onClose (con el mismo fileData ya cerrado).
  // Este flag evita registrar el evento "cerrar" dos veces para el mismo
  // archivo abierto.
  const closedRef = useRef(false);

  const openFile = (
    buffer: ArrayBuffer,
    name: string,
    originRect: DOMRect | null = null,
    driveFileId: string | null = null
  ) => {
    closedRef.current = false;
    setFileData({ buffer, name, originRect, driveFileId });
  };

  const closeFile = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (fileData) logCerrar(fileData.driveFileId, fileData.name);
    setFileData(null);
  };

  // Arranca el "hero" del mismo tamaño/posicion que la tarjeta clickeada
  // (efecto de expansion tipo iOS); si no hay origen (ej. subida manual),
  // solo hace fade.
  let initialTransform: Record<string, number | string> = { opacity: 0 };
  if (fileData?.originRect) {
    const r = fileData.originRect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    initialTransform = {
      opacity: 0.5,
      x: r.left + r.width / 2 - vw / 2,
      y: r.top + r.height / 2 - vh / 2,
      scaleX: Math.max(r.width / vw, 0.05),
      scaleY: Math.max(r.height / vh, 0.05),
    };
  }

  return (
    <>
      <Gallery
        hidden={!!fileData}
        userName={userName}
        onOpen={openFile}
        onUpload={(buffer, name) => openFile(buffer, name, null)}
      />
      {!userName && <NamePrompt onSubmit={submitUserName} />}
      <AnimatePresence>
        {fileData && (
          <motion.div
            key="viewer-hero"
            ref={heroRef}
            className="viewer-hero"
            initial={initialTransform}
            animate={{ opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.4, ease: EASE_IOS } }}
            transition={{ duration: 0.9, ease: EASE_IOS }}
            onAnimationComplete={() => {
              // Una vez asentado, sacamos el transform inline: si queda un
              // transform (aunque sea identidad) en este contenedor, se
              // convierte en containing block de los descendientes
              // position:fixed (ej. el preview fullscreen de imagenes),
              // rompiendo su posicionamiento relativo a la ventana real.
              if (heroRef.current) heroRef.current.style.transform = '';
            }}
          >
            <ConceptViewer
              fileBuffer={fileData.buffer}
              fileName={fileData.name}
              onClose={closeFile}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default App;
