import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, m } from "motion/react";
import {
  Upload, RefreshCw, AlertTriangle, CheckCircle2, Circle, Download, X,
  FileText, Image as ImageIcon, FolderOpen, Folder, Home, ChevronLeft, ChevronRight,
  Sun, Moon, Trash2, Clock,
} from "lucide-react";
import { listDriveFolder, driveFileUrl, driveAuthHeaders } from "./driveClient";
import type { DriveFolderRef, DriveListing } from "./driveClient";
import { fetchCachedThumbnails, upsertThumbnail, fetchAllFolderCache, upsertFolderCache } from "./supabaseClient";
import type { FolderCacheRow } from "./supabaseClient";
import { thumbnailDeArchivo } from "./thumbnail";
import { renderDocumentEntry, exportSectionsAsPdf, exportSectionsAsZip } from "./exportRender";
import type { ExportSection } from "./exportRender";
import { gatherExportMetadata } from "./exportMetadata";
import { logAbrir, logDescarga } from "./analytics";
import { openConceptsRemote, parseConceptsRemote } from "../VisorConcept/parser";
import { DRIVE_FOLDER_ID } from "../config";
import { aSlug } from "../rutas";
import { alternarTema, temaGuardado } from "../theme";
import type { Tema } from "../theme";
import { listarRecientes, vaciarRecientes } from "./recientes";
import type { Reciente } from "./recientes";
import { vaciarCache } from "./rasterCache";
import "./Gallery.css";

type ItemStatus = "queued" | "processing" | "ready" | "error";

interface GalleryItem {
  id: string;
  name: string;
  thumbnail: string | null;
  status: ItemStatus;
  fromCache: boolean;
  modifiedAt: string | null;
  hasTime: boolean;
  error?: string;
}

interface FolderCrumb {
  id: string;
  name: string;
}

interface SelectedRef {
  kind: "file" | "folder";
  id: string;
  name: string;
}

interface GalleryProps {
  hidden: boolean;
  userName: string | null;
  /** `ruta` son los nombres de las carpetas contenedoras (sin la raiz): sirve
   * para armar la URL compartible y la lista de recientes. */
  onOpen: (fileId: string, name: string, originRect: DOMRect | null, ruta: string[]) => void;
  onUpload: (file: File, name: string) => void;
  /** Carpetas (por slug) a las que hay que navegar al arrancar, tomadas de la
   * URL. La galeria las resuelve contra el arbol de Drive. */
  rutaInicial?: string[];
  /** Avisa la ruta actual para que App actualice la URL. */
  onRutaCambio?: (ruta: string[]) => void;
}

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];
const ROOT_CRUMB: FolderCrumb = { id: DRIVE_FOLDER_ID, name: "Inicio" };

function cleanName(name: string) {
  return name.replace(/\s+/g, " ").trim().replace(/\.concepts$/i, "");
}

function formatModified(modifiedAt: string | null, hasTime: boolean): string {
  if (!modifiedAt) return "";
  const d = new Date(modifiedAt);
  // Las fechas sin hora se guardan como medianoche UTC (el dia exacto que
  // informa Drive); leer los componentes en UTC evita que se corra un dia
  // hacia atras para usuarios en UTC negativo. Los timestamps con hora real
  // si son un instante concreto y deben mostrarse en la zona del usuario.
  const day = String(hasTime ? d.getDate() : d.getUTCDate()).padStart(2, "0");
  const month = String((hasTime ? d.getMonth() : d.getUTCMonth()) + 1).padStart(2, "0");
  const datePart = `${day}/${month}`;
  if (!hasTime) return datePart;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${datePart} ${hours}:${minutes}hs`;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let idx = 0;
  async function next(): Promise<void> {
    const current = idx++;
    if (current >= items.length) return;
    await worker(items[current]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

export function Gallery({ hidden, userName, onOpen, onUpload, rutaInicial, onRutaCambio }: GalleryProps) {
  const [tema, setTema] = useState<Tema>(() => temaGuardado());
  const [recientes, setRecientes] = useState<Reciente[]>([]);
  const [confirmarReset, setConfirmarReset] = useState(false);
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([ROOT_CRUMB]);
  const [folders, setFolders] = useState<DriveFolderRef[]>([]);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Ya no hay estado de "abriendo": la apertura es inmediata (no se baja
  // nada aca) y el progreso real de carga lo muestra el visor, que es donde
  // ocurre.
  const [toast, setToast] = useState<string | null>(null);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedRef>>(new Map());
  const [showFormatPicker, setShowFormatPicker] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);

  const currentFolder = folderStack[folderStack.length - 1];

  // Ya no hay cache de buffers: los archivos NO se bajan enteros. Tanto la
  // miniatura como la apertura leen por rangos HTTP solo lo que necesitan
  // (110 KB y ~1 MB respectivamente, contra 262 MB del archivo mas pesado),
  // asi que no hay nada grande que valga la pena retener en memoria.
  const itemsRef = useRef<GalleryItem[]>([]);
  const foldersRef = useRef<DriveFolderRef[]>([]);
  const loadedOnceRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  // Arbol de carpetas ya visitadas/crawleadas (solo ids/nombres), traido
  // entero de Supabase una vez al montar. Mientras una carpeta este aca,
  // entrar/salir de ella es instantaneo: no hace falta pegarle a Drive.
  const folderTreeCacheRef = useRef<Map<string, FolderCacheRow>>(new Map());
  const folderTreeLoadedRef = useRef(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  const processItem = useCallback(async (file: { id: string; name: string }) => {
    setItems((prev) =>
      prev.map((it) => (it.id === file.id ? { ...it, status: "processing", error: undefined } : it))
    );
    try {
      // Camino rapido: usar la vista previa que Concepts ya dejo adentro del
      // archivo, leida POR RANGOS. Redibujar el documento desde cero cuesta
      // segundos (cada PDF embebido tarda ~1,5 s en pdf.js aunque la salida
      // sea de 32 px) y ademas obligaba a bajar el archivo entero: 262 MB
      // para producir una imagen de 192 px. Ahora son ~110 KB.
      const archivo = await openConceptsRemote(driveFileUrl(file.id), driveAuthHeaders());
      let thumbnail: string;
      let bytesFuente: number;
      try {
        ({ dataUrl: thumbnail, bytesFuente } = await thumbnailDeArchivo(archivo));
      } finally {
        archivo.close();
      }
      setItems((prev) =>
        prev.map((it) =>
          it.id === file.id ? { ...it, thumbnail, status: "ready", fromCache: false } : it
        )
      );
      await upsertThumbnail({
        drive_file_id: file.id,
        file_name: file.name,
        thumbnail_base64: thumbnail,
        source_size_bytes: bytesFuente,
      });
    } catch (err: any) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === file.id
            ? { ...it, status: "error", error: err?.message || "Error al procesar" }
            : it
        )
      );
    }
  }, []);

  // Carga (o refresca) el listado de una carpeta puntual: subcarpetas +
  // archivos, cruzando con el cache de Supabase para mostrar miniaturas ya
  // generadas al instante y solo procesar las que faltan. En un refresh no
  // se limpia la grilla antes de tener la respuesta nueva, para no hacer
  // parpadear lo que ya estaba mostrandose; si el listado nuevo es
  // identico al anterior (mismos ids de carpetas y archivos) se avisa con
  // un cartelito en vez de re-renderizar todo en silencio.
  //
  // El listado en si (subcarpetas + archivos, solo nombres) primero se
  // busca en el arbol cacheado de Supabase: si ya esta ahi, se muestra al
  // instante sin pegarle a Drive. Solo se pega a Drive en vivo si la
  // carpeta nunca se cacheo, o si es un refresh explicito — y en ese caso
  // el resultado se vuelve a cachear para la proxima.
  const loadFolder = useCallback(
    async (folderId: string, folderName: string, opts: { isRefresh?: boolean } = {}) => {
      const isRefresh = !!opts.isRefresh;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setListLoading(true);
        setItems([]);
        setFolders([]);
      }
      setListError(null);
      try {
        const cached = !isRefresh ? folderTreeCacheRef.current.get(folderId) : undefined;
        let listing: DriveListing;
        if (cached) {
          listing = { folders: cached.subfolders, files: cached.files };
        } else {
          listing = await listDriveFolder(folderId);
          folderTreeCacheRef.current.set(folderId, {
            folder_id: folderId,
            name: folderName,
            subfolders: listing.folders,
            files: listing.files,
            updated_at: new Date().toISOString(),
          });
          void upsertFolderCache(folderId, folderName, listing.folders, listing.files);
        }

        if (isRefresh) {
          const prevFolderIds = new Set(foldersRef.current.map((f) => f.id));
          const newFolderIds = new Set(listing.folders.map((f) => f.id));
          const prevFileIds = new Set(itemsRef.current.map((it) => it.id));
          const newFileIds = new Set(listing.files.map((f) => f.id));
          const sameFolders =
            prevFolderIds.size === newFolderIds.size && [...prevFolderIds].every((id) => newFolderIds.has(id));
          const sameFiles =
            prevFileIds.size === newFileIds.size && [...prevFileIds].every((id) => newFileIds.has(id));
          if (sameFolders && sameFiles) {
            showToast("No se encontraron cambios");
          }
        }

        setFolders(listing.folders);

        const cache = await fetchCachedThumbnails(listing.files.map((f) => f.id));
        const prevById = new Map(itemsRef.current.map((it) => [it.id, it]));

        const nextItems: GalleryItem[] = listing.files.map((f) => {
          const cached = cache.get(f.id);
          if (cached) {
            return {
              id: f.id,
              name: cleanName(f.name),
              thumbnail: cached.thumbnail_base64,
              status: "ready",
              fromCache: true,
              modifiedAt: f.modifiedAt,
              hasTime: f.hasTime,
            };
          }
          const existing = prevById.get(f.id);
          if (existing && existing.status === "ready" && existing.thumbnail) {
            return { ...existing, name: cleanName(f.name), modifiedAt: f.modifiedAt, hasTime: f.hasTime };
          }
          return {
            id: f.id,
            name: cleanName(f.name),
            thumbnail: null,
            status: "queued" as ItemStatus,
            fromCache: false,
            modifiedAt: f.modifiedAt,
            hasTime: f.hasTime,
          };
        });

        setItems(nextItems);
        if (!isRefresh) setListLoading(false);

        const pending = listing.files.filter((f) => nextItems.find((it) => it.id === f.id)?.status === "queued");
        if (pending.length > 0) {
          await runPool(pending, 3, processItem);
        }
      } catch (err: any) {
        setListError(err?.message || "No se pudo cargar la carpeta de Drive");
        if (!isRefresh) setListLoading(false);
      } finally {
        setRefreshing(false);
      }
    },
    [processItem]
  );

  useEffect(() => {
    if (loadedOnceRef.current) return;
    loadedOnceRef.current = true;
    (async () => {
      if (!folderTreeLoadedRef.current) {
        folderTreeCacheRef.current = await fetchAllFolderCache();
        folderTreeLoadedRef.current = true;
      }

      // Si la URL trae una ruta (/guada-y-flor-re/concepts), se resuelve
      // contra el arbol ya cacheado: comparar slugs es instantaneo y no hace
      // falta pegarle a Drive por cada nivel.
      const pila: FolderCrumb[] = [ROOT_CRUMB];
      for (const slug of rutaInicial || []) {
        const actual = folderTreeCacheRef.current.get(pila[pila.length - 1].id);
        const hija = actual?.subfolders.find((f) => aSlug(f.name) === slug);
        if (!hija) break; // el resto de la ruta puede ser el archivo
        pila.push({ id: hija.id, name: hija.name });
      }
      if (pila.length > 1) setFolderStack(pila);
      const destino = pila[pila.length - 1];
      loadFolder(destino.id, destino.name);
    })();
  }, [loadFolder, rutaInicial]);

  // Cada vez que cambia la carpeta, se avisa para que la URL la refleje.
  useEffect(() => {
    onRutaCambio?.(folderStack.slice(1).map((c) => c.name));
  }, [folderStack, onRutaCambio]);

  // La seleccion (archivos y/o carpetas enteras) se mantiene a proposito al
  // navegar entre carpetas, para poder juntar cosas de varios lugares y
  // descargarlas juntas.
  const goToStack = (nextStack: FolderCrumb[]) => {
    setFolderStack(nextStack);
    const target = nextStack[nextStack.length - 1];
    loadFolder(target.id, target.name);
  };

  const navigateInto = (folder: DriveFolderRef) => {
    goToStack([...folderStack, { id: folder.id, name: folder.name }]);
  };

  const navigateToCrumb = (index: number) => {
    goToStack(folderStack.slice(0, index + 1));
  };

  const navigateBack = () => {
    if (folderStack.length > 1) navigateToCrumb(folderStack.length - 2);
  };

  const handleRefresh = () => {
    if (refreshing || listLoading) return;
    loadFolder(currentFolder.id, currentFolder.name, { isRefresh: true });
  };

  // Abrir es inmediato: no se baja nada aca. El visor lee por rangos lo que
  // necesita (vista previa al instante, despues tree.pack, despues los
  // recursos visibles). Antes esto bajaba el archivo entero — hasta 262 MB —
  // antes de mostrar absolutamente nada.
  const handleOpen = (item: GalleryItem, originRect: DOMRect | null) => {
    if (item.status === "processing") return;
    logAbrir(item.id, item.name, currentFolder.id);
    // La ruta sin la raiz: es lo que va en la URL compartible.
    onOpen(item.id, item.name, originRect, folderStack.slice(1).map((c) => c.name));
  };

  // --- Tema, recientes y restablecer ------------------------------------
  const cambiarTema = () => setTema(alternarTema());

  useEffect(() => {
    void listarRecientes(6).then(setRecientes);
  }, [hidden]);

  const restablecerTodo = async () => {
    // Borra TODO lo local: rasterizados, recientes, nombre de usuario y tema.
    // No toca Drive ni Supabase — solo lo que esta guardado en este telefono.
    try {
      await vaciarCache();
      await vaciarRecientes();
      localStorage.clear();
      if (typeof caches !== "undefined") {
        const nombres = await caches.keys();
        await Promise.all(nombres.map((n) => caches.delete(n)));
      }
    } catch {
      /* si algo no se pudo borrar, igual se recarga */
    }
    window.location.href = "/";
  };

  const toggleSelected = (ref: SelectedRef) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(ref.id)) next.delete(ref.id);
      else next.set(ref.id, ref);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  };

  const handleCheckboxClick = (e: React.MouseEvent, ref: SelectedRef) => {
    e.stopPropagation();
    if (!selectionMode) setSelectionMode(true);
    toggleSelected(ref);
  };

  const handleCardActivate = (item: GalleryItem, el: HTMLElement) => {
    if (selectionMode) {
      toggleSelected({ kind: "file", id: item.id, name: item.name });
    } else {
      handleOpen(item, el.getBoundingClientRect());
    }
  };

  // A diferencia de un archivo (que en modo seleccion no tiene otra accion
  // util al hacer click), una carpeta siempre tiene sentido abrirla — asi
  // que el click del cuerpo SIEMPRE navega, este o no activo el modo
  // seleccion; el checkbox (con su propio stopPropagation) es la unica
  // forma de marcarla para descarga. Si no fuera asi, no habria manera de
  // entrar a una carpeta nueva mientras se esta seleccionando en otra.
  const handleFolderActivate = (folder: DriveFolderRef) => {
    navigateInto(folder);
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelected(new Map());
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // Se pasa el File, no sus bytes: File.slice() es perezoso, asi que un
    // .concepts de 262 MB elegido a mano tampoco entra entero a memoria.
    onUpload(file, file.name);
  };

  // Baja recursivamente todos los archivos de una carpeta (y sus
  // subcarpetas, sin limite de profundidad) para armar una seccion de
  // descarga a partir de una carpeta seleccionada entera.
  const collectFolderFiles = async (folderId: string): Promise<{ id: string; name: string }[]> => {
    const listing = await listDriveFolder(folderId);
    const direct = listing.files.map((f) => ({ id: f.id, name: cleanName(f.name) }));
    const nested = await Promise.all(listing.folders.map((sub) => collectFolderFiles(sub.id)));
    return direct.concat(nested.flat());
  };

  const handleDownload = async (format: "pdf" | "jpg") => {
    setShowFormatPicker(false);
    if (selected.size === 0) return;

    const refs = Array.from(selected.values());
    const fileRefs = refs.filter((r) => r.kind === "file");
    const folderRefs = refs.filter((r) => r.kind === "folder");

    try {
      const plan: { title: string | null; files: { id: string; name: string }[] }[] = [];
      if (fileRefs.length > 0) {
        plan.push({
          title: folderRefs.length > 0 ? "Archivos seleccionados" : null,
          files: fileRefs.map((r) => ({ id: r.id, name: r.name })),
        });
      }
      for (const folderRef of folderRefs) {
        const files = await collectFolderFiles(folderRef.id);
        plan.push({ title: folderRef.name, files });
      }

      const totalFiles = plan.reduce((n, s) => n + s.files.length, 0);
      if (totalFiles === 0) {
        setListError("La seleccion no tiene archivos para descargar.");
        return;
      }

      setExportProgress({ done: 0, total: totalFiles });

      const metadata = await gatherExportMetadata();

      const sections: ExportSection[] = [];
      for (const group of plan) {
        const entries: ExportSection["entries"] = [];
        for (const f of group.files) {
          // Secuencial y codificando a JPEG apenas se renderiza: mantener
          // varios canvases de export vivos a la vez son cientos de MB.
          // renderDocumentEntry libera el canvas antes de seguir.
          const doc = await parseConceptsRemote(driveFileUrl(f.id), driveAuthHeaders());
          try {
            entries.push(await renderDocumentEntry(doc, f.name));
          } finally {
            doc.close();
          }
          setExportProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
        }
        sections.push({ title: group.title, entries });
      }

      if (format === "pdf") {
        await exportSectionsAsPdf(sections, metadata);
      } else {
        await exportSectionsAsZip(sections, metadata);
      }

      const allIds = plan.flatMap((s) => s.files.map((f) => f.id));
      logDescarga(
        "galeria",
        format,
        allIds,
        allIds.length === 1 ? plan[0].files[0].name : undefined,
        currentFolder.id
      );
      // La seleccion se mantiene activa a proposito: asi se puede volver a
      // descargar la misma seleccion en el otro formato sin re-marcar todo.
    } catch (err: any) {
      setListError(err?.message || "No se pudo generar la descarga");
    } finally {
      setExportProgress(null);
    }
  };

  const pendingCount = items.filter((it) => it.status === "queued" || it.status === "processing").length;
  const cachedCount = items.filter((it) => it.fromCache).length;
  const driveFolderUrl = `https://drive.google.com/drive/folders/${currentFolder.id}`;
  const isEmpty = !listLoading && folders.length === 0 && items.length === 0 && !listError;
  const selectedCount = selected.size;

  return (
    <div className="gallery-page" style={hidden ? { display: "none" } : undefined}>
      <header className="gallery-header">
        <div>
          <h1>ConceptSerializer</h1>
          <p className="gallery-subtitle">
            {userName ? `Bienvenido ${userName}. Selecciona tu lienzo o carpeta.` : "Dibujos disponibles en Drive"}
          </p>
        </div>
        <div className="gallery-header-actions">
          <a
            className="gallery-drive-btn"
            href={driveFolderUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FolderOpen size={16} /> Ver carpeta de Drive
          </a>
          <label className="gallery-upload-btn">
            <Upload size={16} /> Subir .concepts
            <input type="file" accept=".concepts" onChange={handleUpload} hidden />
          </label>
          <button
            className="gallery-icon-btn gallery-tema-btn"
            onClick={cambiarTema}
            title={tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
            aria-label={tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          >
            {tema === "oscuro" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {/* Accion destructiva: borra todo lo guardado en este dispositivo.
              Pide confirmacion porque no se puede deshacer. */}
          <button
            className="gallery-icon-btn gallery-reset-btn"
            onClick={() => setConfirmarReset(true)}
            title="Restablecer: borra el cache y los datos locales"
            aria-label="Restablecer datos locales"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <div className="gallery-breadcrumb">
        <button
          className="gallery-icon-btn"
          onClick={() => navigateToCrumb(0)}
          disabled={folderStack.length === 1}
          title="Ir al inicio"
        >
          <Home size={15} />
        </button>
        <button
          className="gallery-icon-btn"
          onClick={navigateBack}
          disabled={folderStack.length === 1}
          title="Volver"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="gallery-breadcrumb-trail">
          {folderStack.map((crumb, i) => (
            <span key={crumb.id} className="gallery-breadcrumb-crumb">
              {i > 0 && <ChevronRight size={12} className="gallery-breadcrumb-sep" />}
              <button
                className={`gallery-breadcrumb-item ${i === folderStack.length - 1 ? "current" : ""}`}
                onClick={() => navigateToCrumb(i)}
                disabled={i === folderStack.length - 1}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <button
          className="gallery-icon-btn"
          onClick={handleRefresh}
          disabled={refreshing || listLoading}
          title="Actualizar"
        >
          <RefreshCw size={15} className={refreshing ? "spin-slow" : ""} />
        </button>
      </div>

      {pendingCount > 0 && (
        <div className="gallery-status">
          <RefreshCw size={13} className="spin-slow" />
          Generando miniaturas: {items.length - pendingCount} de {items.length}
          {cachedCount > 0 ? ` (${cachedCount} desde cache)` : ""}
        </div>
      )}

      {listError && (
        <div className="gallery-error">
          <AlertTriangle size={16} /> {listError}
        </div>
      )}

      {/* Ultimos abiertos: solo en la raiz, para no tapar el contenido de la
          carpeta en la que estas. Guarda unicamente rutas (ver recientes.ts),
          asi que mostrarlos no cuesta ni red ni memoria. */}
      {folderStack.length === 1 && recientes.length > 0 && (
        <section className="gallery-recientes">
          <h2>
            <Clock size={14} /> Ultimos abiertos
          </h2>
          <div className="gallery-recientes-lista">
            {recientes.map((r) => (
              <button
                key={r.id}
                className="gallery-reciente"
                onClick={() => onOpen(r.id, r.nombre, null, r.ruta)}
                title={[...r.ruta, r.nombre].join(" / ")}
              >
                <span className="gallery-reciente-nombre">{r.nombre}</span>
                {r.ruta.length > 0 && <span className="gallery-reciente-ruta">{r.ruta.join(" / ")}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {isEmpty && <div className="gallery-empty">Esta carpeta esta vacia.</div>}

      {listLoading ? (
        <div className="gallery-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="gallery-card skeleton" key={i}>
              <div className="gallery-thumb skeleton-shimmer" />
              <div className="gallery-name skeleton-line" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {folders.length > 0 && (
            <div className="gallery-grid gallery-folders-grid">
              {folders.map((folder, idx) => {
                const checked = selected.has(folder.id);
                return (
                  <div
                    key={folder.id}
                    className={`gallery-card folder-card ${checked ? "selected" : ""}`}
                    style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleFolderActivate(folder)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleFolderActivate(folder);
                      }
                    }}
                    title={folder.name}
                  >
                    <button
                      type="button"
                      className={`gallery-checkbox ${checked ? "checked" : ""}`}
                      onClick={(e) => handleCheckboxClick(e, { kind: "folder", id: folder.id, name: folder.name })}
                      aria-label={checked ? "Deseleccionar carpeta" : "Seleccionar carpeta"}
                    >
                      {checked ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                    </button>
                    <div className="gallery-thumb folder-thumb">
                      <Folder size={30} />
                    </div>
                    <div className="gallery-name">{folder.name}</div>
                  </div>
                );
              })}
            </div>
          )}

          {items.length > 0 && (
            <div className="gallery-grid">
              {items.map((item, idx) => {
                const checked = selected.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={`gallery-card ${checked ? "selected" : ""}`}
                    style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleCardActivate(item, e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleCardActivate(item, e.currentTarget);
                      }
                    }}
                    title={item.name}
                  >
                    <button
                      type="button"
                      className={`gallery-checkbox ${checked ? "checked" : ""}`}
                      onClick={(e) => handleCheckboxClick(e, { kind: "file", id: item.id, name: item.name })}
                      aria-label={checked ? "Deseleccionar" : "Seleccionar"}
                    >
                      {checked ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                    </button>

                    <div className="gallery-thumb">
                      {item.status === "ready" && item.thumbnail ? (
                        <img src={item.thumbnail} alt={item.name} />
                      ) : item.status === "error" ? (
                        <div className="gallery-thumb-error">
                          <AlertTriangle size={18} />
                        </div>
                      ) : (
                        <div className="skeleton-shimmer" />
                      )}
                      {item.status === "processing" && (
                        <div className="gallery-thumb-overlay">
                          <RefreshCw size={16} className="spin-slow" />
                        </div>
                      )}
                    </div>
                    <div className="gallery-name">{item.name}</div>
                    {item.modifiedAt && (
                      <div className="gallery-date">{formatModified(item.modifiedAt, item.hasTime)}</div>
                    )}
                    {item.status === "error" && <div className="gallery-card-error">{item.error}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {toast && (
          <m.div
            className="gallery-toast"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            {toast}
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectionMode && (
          <m.div
            className="gallery-toolbar"
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
          >
            <span>{selectedCount} seleccionado{selectedCount === 1 ? "" : "s"}</span>
            <div className="gallery-toolbar-actions">
              <button className="gallery-toolbar-btn primary" onClick={() => setShowFormatPicker(true)}>
                <Download size={15} /> Descargar
              </button>
              <button className="gallery-toolbar-btn" onClick={cancelSelection} title="Cancelar seleccion">
                <X size={16} />
              </button>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showFormatPicker && (
          <m.div
            className="gallery-modal-overlay"
            onClick={() => setShowFormatPicker(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <h3>Descargar {selectedCount} elemento{selectedCount === 1 ? "" : "s"}</h3>
              <p>Elegi el formato de descarga.</p>
              <div className="gallery-modal-options">
                <button className="gallery-modal-option" onClick={() => handleDownload("pdf")}>
                  <FileText size={20} />
                  <span>PDF</span>
                  <small>Un solo PDF con metadata y secciones por carpeta</small>
                </button>
                <button className="gallery-modal-option" onClick={() => handleDownload("jpg")}>
                  <ImageIcon size={20} />
                  <span>JPG</span>
                  <small>Un .zip con un JPG por dibujo (y subcarpetas)</small>
                </button>
              </div>
              <button className="gallery-modal-cancel" onClick={() => setShowFormatPicker(false)}>
                Cancelar
              </button>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmarReset && (
          <m.div
            className="gallery-modal-overlay"
            onClick={() => setConfirmarReset(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <h3>Restablecer</h3>
              <p>
                Se borra todo lo guardado en <strong>este dispositivo</strong>: el cache de dibujos ya
                abiertos, la lista de recientes, tu nombre y el tema. No se borra nada de Drive ni de
                los dibujos.
              </p>
              <p>La proxima apertura vuelve a bajar y rasterizar todo, asi que sera mas lenta.</p>
              <div className="gallery-modal-options">
                <button className="gallery-modal-option peligro" onClick={restablecerTodo}>
                  <Trash2 size={20} />
                  <span>Borrar y recargar</span>
                  <small>No se puede deshacer</small>
                </button>
              </div>
              <button className="gallery-modal-cancel" onClick={() => setConfirmarReset(false)}>
                Cancelar
              </button>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {exportProgress && (
          <m.div
            className="gallery-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <RefreshCw size={20} className="spin-slow" />
              <p>Preparando descarga: {exportProgress.done} de {exportProgress.total}</p>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default Gallery;
