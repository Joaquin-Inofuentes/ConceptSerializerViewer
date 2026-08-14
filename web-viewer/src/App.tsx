import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, m } from 'motion/react';
import { Gallery } from './Gallery/Gallery';
import { NamePrompt } from './Gallery/NamePrompt';
import { logCerrar } from './Gallery/analytics';
import { getUserName, setUserName } from './Gallery/userIdentity';
import { registrarAbierto } from './Gallery/recientes';
import { DEMO_FILE_ID, DEMO_FILE_NAME } from './config';
import { applyTierFromUrl } from './device';
import { temaGuardado, aplicarTema } from './theme';
import { construirRuta, leerRuta, irA, aSlug } from './rutas';
import './index.css';

// El visor (parser + zip + pdf.js + jspdf) se carga recien cuando se abre un
// dibujo: la galeria sola no lo necesita, y en 3G son ~200 KB que retrasaban
// la primera pantalla sin motivo.
const ConceptViewer = lazy(() =>
  import('./VisorConcept').then((m) => ({ default: m.ConceptViewer }))
);

/**
 * De donde salen los bytes del dibujo abierto.
 *
 * `remote` NO trae los bytes: solo el id. El visor los lee por rangos HTTP a
 * medida que los necesita. Antes aca vivia un ArrayBuffer con el archivo
 * entero — 262 MB retenidos todo el tiempo que el dibujo estuviera abierto,
 * que en un telefono de 1 GB es motivo suficiente para que Android mate la
 * pestaña.
 */
export type FileSourceRef =
  | { kind: 'remote'; fileId: string; name: string; originRect: DOMRect | null; ruta: string[] }
  | { kind: 'local'; file: File; name: string; originRect: DOMRect | null; ruta: string[] };

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];

applyTierFromUrl();
// El script inline de index.html ya puso data-theme antes de pintar; esto
// sincroniza el estado por si el HTML se sirvio cacheado sin el script.
aplicarTema(temaGuardado());

function App() {
  const [fileData, setFileData] = useState<FileSourceRef | null>(null);
  const [userName, setUserNameState] = useState<string | null>(() => getUserName());
  const heroRef = useRef<HTMLDivElement>(null);

  // Ruta con la que arranco la pagina: son los slugs de la URL. El ultimo
  // puede ser un archivo, y de eso se encarga la galeria al resolverla.
  const [rutaInicial] = useState<string[]>(() => leerRuta());
  const rutaCarpetaRef = useRef<string[]>([]);

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

  // Espejo sincrono de `fileData` para consultarlo desde callbacks sin
  // volverlos a crear. Hace falta de verdad: la galeria avisa su ruta cuando
  // termina de cargar una carpeta, que es DESPUES de que el dibujo se abrio,
  // y sin este guardia ese aviso pisaba la URL del dibujo dejandola en "/".
  const hayDibujoRef = useRef(false);

  const openRemote = useCallback(
    (fileId: string, name: string, originRect: DOMRect | null = null, ruta: string[] = []) => {
      closedRef.current = false;
      hayDibujoRef.current = true;
      setFileData({ kind: 'remote', fileId, name, originRect, ruta });
      // La URL pasa a apuntar al dibujo, asi el link se puede compartir.
      irA(construirRuta(ruta, name));
      void registrarAbierto({ id: fileId, nombre: name, ruta, slug: construirRuta(ruta, name) });
    },
    []
  );

  const openLocal = useCallback((file: File, name: string) => {
    closedRef.current = false;
    setFileData({ kind: 'local', file, name, originRect: null, ruta: [] });
  }, []);

  useEffect(() => {
    hayDibujoRef.current = !!fileData;
  }, [fileData]);

  const closeFile = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    hayDibujoRef.current = false;
    setFileData((actual) => {
      if (actual) logCerrar(actual.kind === 'remote' ? actual.fileId : null, actual.name);
      return null;
    });
    // Al cerrar se vuelve a la carpeta donde estaba la galeria.
    irA(construirRuta(rutaCarpetaRef.current));
  }, []);

  const alCambiarRutaCarpeta = useCallback((ruta: string[]) => {
    rutaCarpetaRef.current = ruta;
    // Con un dibujo abierto manda la ruta del dibujo, no la de la carpeta.
    if (!hayDibujoRef.current) irA(construirRuta(ruta), true);
  }, []);

  // Atajos para abrir un dibujo puntual sin navegar la galeria:
  //   ?demo          -> el dibujo mas pesado de la carpeta (peor caso)
  //   ?file=<id>     -> cualquier archivo de Drive por id
  const autoOpenRef = useRef(false);
  useEffect(() => {
    if (autoOpenRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.has('demo') ? DEMO_FILE_ID : params.get('file');
    if (!id) return;
    autoOpenRef.current = true;
    const nombre = params.has('demo') ? DEMO_FILE_NAME : `${id}.concepts`;
    openRemote(id, nombre, null, []);
  }, [openRemote]);

  // Boton "atras" del navegador: si la URL vuelve a una carpeta, se cierra el
  // dibujo. Sin esto, atras cambiaba la URL pero dejaba el visor abierto.
  useEffect(() => {
    const alVolver = () => {
      const partes = leerRuta();
      setFileData((actual) => {
        if (!actual) return actual;
        const sigueEnElDibujo = partes[partes.length - 1] === aSlug(actual.name);
        return sigueEnElDibujo ? actual : null;
      });
    };
    window.addEventListener('popstate', alVolver);
    return () => window.removeEventListener('popstate', alVolver);
  }, []);

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
    // LazyMotion + `m` en vez de `motion`: el componente `motion` arrastra
    // TODAS las features de animacion (drag, layout, gestos, scroll) aunque
    // aca solo se usen fades y springs simples. Con domAnimation el bundle
    // baja ~20 KB gzip, que en 3G es tiempo de arranque real.
    <LazyMotion features={domAnimation} strict>
      <Gallery
        hidden={!!fileData}
        userName={userName}
        onOpen={openRemote}
        onUpload={openLocal}
        rutaInicial={rutaInicial}
        onRutaCambio={alCambiarRutaCarpeta}
      />
      {!userName && <NamePrompt onSubmit={submitUserName} />}
      <AnimatePresence>
        {fileData && (
          <m.div
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
            <Suspense
              fallback={
                <div className="app-container">
                  <div className="empty-state">
                    <div className="spin-slow">Cargando visor…</div>
                  </div>
                </div>
              }
            >
              <ConceptViewer source={fileData} onClose={closeFile} />
            </Suspense>
          </m.div>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}

export default App;
