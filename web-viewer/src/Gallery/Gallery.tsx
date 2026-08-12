import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Upload, RefreshCw, AlertTriangle, CheckCircle2, Circle, Download, X,
  FileText, Image as ImageIcon, FolderOpen, Folder, Home, ChevronLeft, ChevronRight,
} from "lucide-react";
import { listDriveFolder, downloadDriveFile } from "./driveClient";
import type { DriveFolderRef } from "./driveClient";
import { fetchCachedThumbnails, upsertThumbnail } from "./supabaseClient";
import { renderThumbnailDataUrl } from "./thumbnail";
import { renderDocumentCanvas, exportSelectionAsPdf, exportSelectionAsZip } from "./exportRender";
import { logAbrir, logDescarga } from "./analytics";
import { parseConceptsFile } from "../VisorConcept/parser";
import { DRIVE_FOLDER_ID } from "../config";
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

interface GalleryProps {
  hidden: boolean;
  onOpen: (buffer: ArrayBuffer, name: string, originRect: DOMRect | null, driveFileId: string) => void;
  onUpload: (buffer: ArrayBuffer, name: string) => void;
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
  // informa Drive); formatear en la zona local correria el dia hacia atras
  // para usuarios en UTC negativo. Los timestamps con hora real si son un
  // instante concreto y deben mostrarse en la zona del usuario.
  const dateOpts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
  if (!hasTime) dateOpts.timeZone = "UTC";
  const datePart = d.toLocaleDateString("es-AR", dateOpts);
  if (!hasTime) return datePart;
  const timePart = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
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

export function Gallery({ hidden, onOpen, onUpload }: GalleryProps) {
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([ROOT_CRUMB]);
  const [folders, setFolders] = useState<DriveFolderRef[]>([]);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showFormatPicker, setShowFormatPicker] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);

  const currentFolder = folderStack[folderStack.length - 1];

  // Cachea en memoria los bytes ya descargados (evita re-bajar al abrir un
  // dibujo cuya miniatura se acaba de generar en esta misma sesion).
  const bufferCacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const itemsRef = useRef<GalleryItem[]>([]);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const processItem = useCallback(async (file: { id: string; name: string }) => {
    setItems((prev) =>
      prev.map((it) => (it.id === file.id ? { ...it, status: "processing", error: undefined } : it))
    );
    try {
      let buffer = bufferCacheRef.current.get(file.id);
      if (!buffer) {
        buffer = await downloadDriveFile(file.id);
        bufferCacheRef.current.set(file.id, buffer);
      }
      const doc = await parseConceptsFile(buffer);
      const thumbnail = await renderThumbnailDataUrl(doc);
      setItems((prev) =>
        prev.map((it) =>
          it.id === file.id ? { ...it, thumbnail, status: "ready", fromCache: false } : it
        )
      );
      await upsertThumbnail({
        drive_file_id: file.id,
        file_name: file.name,
        thumbnail_base64: thumbnail,
        source_size_bytes: buffer.byteLength,
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
  // parpadear lo que ya estaba mostrandose.
  const loadFolder = useCallback(
    async (folderId: string, opts: { isRefresh?: boolean } = {}) => {
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
        const listing = await listDriveFolder(folderId);
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
    loadFolder(ROOT_CRUMB.id);
  }, [loadFolder]);

  const goToStack = (nextStack: FolderCrumb[]) => {
    setFolderStack(nextStack);
    setSelectionMode(false);
    setSelectedIds(new Set());
    loadFolder(nextStack[nextStack.length - 1].id);
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
    loadFolder(currentFolder.id, { isRefresh: true });
  };

  const ensureBuffer = async (id: string): Promise<ArrayBuffer> => {
    let buffer = bufferCacheRef.current.get(id);
    if (!buffer) {
      buffer = await downloadDriveFile(id);
      bufferCacheRef.current.set(id, buffer);
    }
    return buffer;
  };

  const handleOpen = async (item: GalleryItem, originRect: DOMRect | null) => {
    if (openingId || item.status === "processing") return;
    setOpeningId(item.id);
    try {
      const buffer = await ensureBuffer(item.id);
      logAbrir(item.id, item.name, currentFolder.id);
      onOpen(buffer, item.name, originRect, item.id);
    } catch (err: any) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id ? { ...it, status: "error", error: err?.message || "No se pudo abrir" } : it
        )
      );
    } finally {
      setOpeningId(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  };

  const handleCheckboxClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!selectionMode) setSelectionMode(true);
    toggleSelected(id);
  };

  const handleCardActivate = (item: GalleryItem, el: HTMLElement) => {
    if (selectionMode) {
      toggleSelected(item.id);
    } else {
      handleOpen(item, el.getBoundingClientRect());
    }
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const buffer = await file.arrayBuffer();
    onUpload(buffer, file.name);
  };

  const handleDownload = async (format: "pdf" | "jpg") => {
    setShowFormatPicker(false);
    const selected = items.filter((it) => selectedIds.has(it.id));
    if (selected.length === 0) return;

    setExportProgress({ done: 0, total: selected.length });
    try {
      const entries: { name: string; canvas: HTMLCanvasElement }[] = [];
      for (const item of selected) {
        const buffer = await ensureBuffer(item.id);
        const doc = await parseConceptsFile(buffer);
        const canvas = await renderDocumentCanvas(doc);
        entries.push({ name: item.name, canvas });
        setExportProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
      if (format === "pdf") {
        await exportSelectionAsPdf(entries);
      } else {
        await exportSelectionAsZip(entries);
      }
      logDescarga(
        "galeria",
        format,
        selected.map((s) => s.id),
        selected.length === 1 ? selected[0].name : undefined
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

  return (
    <div className="gallery-page" style={hidden ? { display: "none" } : undefined}>
      <header className="gallery-header">
        <div>
          <h1>ConceptSerializer</h1>
          <p className="gallery-subtitle">Dibujos disponibles en Drive</p>
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
              {folders.map((folder, idx) => (
                <button
                  key={folder.id}
                  className="gallery-card folder-card"
                  style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
                  onClick={() => navigateInto(folder)}
                  title={folder.name}
                >
                  <div className="gallery-thumb folder-thumb">
                    <Folder size={30} />
                  </div>
                  <div className="gallery-name">{folder.name}</div>
                </button>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="gallery-grid">
              {items.map((item, idx) => {
                const checked = selectedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={`gallery-card ${openingId === item.id ? "opening" : ""} ${checked ? "selected" : ""}`}
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
                    aria-disabled={!!openingId}
                    title={item.name}
                  >
                    <button
                      type="button"
                      className={`gallery-checkbox ${checked ? "checked" : ""}`}
                      onClick={(e) => handleCheckboxClick(e, item.id)}
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
                      {(item.status === "processing" || openingId === item.id) && (
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
        {selectionMode && (
          <motion.div
            className="gallery-toolbar"
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
          >
            <span>{selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}</span>
            <div className="gallery-toolbar-actions">
              <button className="gallery-toolbar-btn primary" onClick={() => setShowFormatPicker(true)}>
                <Download size={15} /> Descargar
              </button>
              <button className="gallery-toolbar-btn" onClick={cancelSelection} title="Cancelar seleccion">
                <X size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showFormatPicker && (
          <motion.div
            className="gallery-modal-overlay"
            onClick={() => setShowFormatPicker(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <motion.div
              className="gallery-modal"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <h3>Descargar {selectedIds.size} dibujo{selectedIds.size === 1 ? "" : "s"}</h3>
              <p>Elegi el formato de descarga.</p>
              <div className="gallery-modal-options">
                <button className="gallery-modal-option" onClick={() => handleDownload("pdf")}>
                  <FileText size={20} />
                  <span>PDF</span>
                  <small>Un solo PDF con todas las selecciones</small>
                </button>
                <button className="gallery-modal-option" onClick={() => handleDownload("jpg")}>
                  <ImageIcon size={20} />
                  <span>JPG</span>
                  <small>Un .zip con un JPG por dibujo</small>
                </button>
              </div>
              <button className="gallery-modal-cancel" onClick={() => setShowFormatPicker(false)}>
                Cancelar
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {exportProgress && (
          <motion.div
            className="gallery-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <motion.div
              className="gallery-modal"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <RefreshCw size={20} className="spin-slow" />
              <p>Preparando descarga: {exportProgress.done} de {exportProgress.total}</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default Gallery;
