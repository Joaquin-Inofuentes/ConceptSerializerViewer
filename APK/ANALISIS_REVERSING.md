# Ingeniería inversa de Concepts.apk

**App:** Concepts (TopHatch Inc.) — `com.tophatch.concepts`
**Versión analizada:** `2025.10.1` (versionCode `250833015`), build interno reportado por BuildConfig: `2025.07.2` / build `33015` / flavor `play` / release
**APK:** 310 MB — 9 archivos `classes.dex`, ~34.110 clases Java reconstruidas, 306 MB de recursos/libs nativas sin comprimir

## 1. Metodología

No había `apktool`/`jadx`/JRE instalados en el sistema, así que:

1. Descargué un JRE portable (Eclipse Temurin 17) y `jadx 1.5.1` (sin instalar nada a nivel de sistema, todo vive en `APK/_tools/`, no requiere admin).
2. `raw_unzip/` — el APK es un ZIP; lo descomprimí tal cual para tener acceso directo a `AndroidManifest.xml` (binario), `classes*.dex`, `resources.arsc`, `assets/`, `lib/<abi>/*.so`, `META-INF/`.
3. `decompiled/` — `jadx` decompiló los 9 `.dex` a Java legible (reconstruyendo desde bytecode Kotlin/Java, con nombres de variables/métodos originales porque la app **no está ofuscada** con R8/ProGuard de forma agresiva — los nombres de paquete, clase y campo son los reales del código fuente de TopHatch) y decodificó todos los recursos (XML binario → texto, `resources.arsc` → `res/`).
   - 34.110 clases, 71/70 con errores menores de reconstrucción (código con estructuras de control inusuales que jadx no pudo reconstruir 100 %, pero el bytecode fallback sigue legible).
4. Con el código fuente ya en texto, hice grep dirigido + lectura de archivos clave + 3 subagentes en paralelo para mapear los ~70 paquetes de la app bajo `com/tophatch/concepts/`.

**Todo el contenido extraído queda en disco, en `APK/`:**
- `APK/raw_unzip/` — el ZIP crudo (dex, assets, libs nativas, manifest binario)
- `APK/decompiled/sources/` — 34.110 archivos `.java` navegables
- `APK/decompiled/resources/` — recursos decodificados (`AndroidManifest.xml` legible, `res/`, `assets/`)
- `APK/_tools/` — jadx + JRE portables usados (podés borrarlos si no los necesitás más)

## 2. Arquitectura general: dos mundos separados

Este es el hallazgo más importante para el proyecto ConceptSerializer. La app tiene **dos capas completamente distintas**:

- **Capa Kotlin/Java (Android)** — toda la UI, navegación, ~2.900 clases de primer nivel bajo `com/tophatch/concepts/*`. Maneja: pantallas, gestos, integraciones de plataforma (Google Sign-In, Play Billing, Drive, cámara, portapapeles), y actúa como "pegamento" entre Android y el motor.
- **Motor nativo C++ (`lib/arm64-v8a/libCore.so`)** — el motor de dibujo real, **compartido entre iOS/Android/Windows** (por eso Concepts se ve/comporta igual en todas las plataformas). Acá vive **todo** lo que le importa a ConceptSerializer: el parser del formato `.concepts`, el árbol de documento (`tree.pack`), las layers, los strokes, el renderer, PDF (via `libpdfium.so`), reconocimiento de tinta digital (via `libdigitalink.so`), y la sincronización cloud (via gRPC, `libgrpc*.so` + `libprotobuf*.so`).

**Confirmé por grep exhaustivo que NINGUNA clase Java menciona literalmente `tree.pack`, `TreePack` o `manifest.json`** — el parsing real del formato interno del `.concepts` (más allá del ZIP contenedor) pasa 100% dentro de `libCore.so`, un binario ARM64 compilado sin símbolos de depuración expuestos. Para ir más allá de lo que este informe cubre (el formato exacto de `tree.pack`, la estructura binaria de strokes/layers) haría falta desensamblar ese `.so` con Ghidra/IDA — un trabajo de otro orden de magnitud, no cubierto acá.

Java solo ve el `.concepts` como:
1. Un contenedor **ZIP plano** (`java.util.zip.ZipFile`, sin cifrado ni compresión especial a nivel de Java) — confirmado en `storage/ZipMetadataLoader.java` y `storage/DrawingFileStorage.java`.
2. Con al menos dos entradas conocidas por nombre en Java: **`thumb.jpg`** (miniatura JPEG) y **`metadata.json`** (JSON simple: `identifier`, `backgroundColor`, `creationTime`, `modificationTime` — ver `storage/model/JsonDrawingMetadata.java`).
3. Todo lo demás dentro del ZIP (incluido `tree.pack`, que ya conocíamos de trabajo previo en este proyecto) lo lee/escribe el motor nativo directamente sobre un `java.io.File` local — Java nunca lo toca.

## 3. El puente Java ↔ nativo para archivos (`core/document/FileSource`)

Esto es clave: **en Android, el motor nativo nunca hace streaming/range-read remoto.** Siempre recibe un `java.io.File` local completo:

```
core/document/FileSource   (interfaz que el motor nativo llama)
├── open(FileId) -> Deferred<FileHandle>      // pedir apertura de un archivo
├── status(FileId) -> Deferred<FileStatus>    // (nombre, FileFingerprint de 32 bytes)
└── scan(callback) -> FileScanner             // suscribirse a cambios

core/document/FileHandle
├── localFile(): File                         // SIEMPRE un File local materializado
└── originFile(): OriginFile?                 // null en Android (solo se usa en desktop)

document/AppDocumentFileSource  (implementación real, usa GalleryRepository)
document/AppFileHandle          (implementación real, wrappea un File, originFile() = null)
```

Dato curioso: `FileFingerprint` (32 bytes) **no es un hash criptográfico real**. `document/MappingsKt.java` construye ese "fingerprint" rellenando con padding el string de versión/fecha de modificación de `metadata.json` hasta 32 bytes — es un truco para cumplir el contrato de tipos que espera el motor nativo, no una huella de contenido. El motor nativo detecta cambios comparando ese string, no el contenido real del archivo.

## 4. Dónde vive cada `.concepts` en el dispositivo — 4 "fuentes" unificadas

`storage/ProjectSource.java` define 4 raíces de almacenamiento que el resto de la app trata de forma uniforme a través de `gallery/GalleryRepository.java` (la clase más grande de toda la app, ~12.700 líneas):

| ProjectSource | Ruta real | Implementación |
|---|---|---|
| `LocalPrivate` | `filesDir/projects` (almacenamiento privado de la app) | `storage/filesystem/LocalFileIndexer` sobre `java.io.File` |
| `LocalPublic` | `.../Documents/Concepts` (almacenamiento externo visible) | idem, con `RecursiveFileObserver` para detectar cambios hechos por un explorador de archivos externo |
| `GDrive` | Google Drive del usuario (vía API de Drive) | `googledrive/GoogleDriveIndexer.java` — llama directo a la API REST, no hay copia local persistente |
| `Trash` | `filesDir/trash` | igual que Local, con mapeo de nombres para poder restaurar |

Cada `.concepts` se direcciona por un `GalleryId` (UUID) estable, mapeado a un `(ProjectSource, FileSystemId)` concreto vía Room DB (`storage/db/GalleryIdMappingDb.java`) — así el motor nativo pide "abrime el archivo X" por UUID sin saber si vive en el teléfono o en Drive.

**Formato de archivo confirmado por código:**
- Ruta legacy on-disk: `{projectId}/{drawingId}.concepts` (ver `DrawingFileStorage.makeFilePathDrawing`)
- MIME type oficial: `application/vnd.tophatch.concepts` (`MimeTypes.MimeTypeConcepts`, usado también al subir a Drive)

## 5. Sincronización — hay DOS sistemas distintos, no confundirlos

1. **Backup a Google Drive** (`backup/` + `googledrive/GoogleDrive.java`) — exportación unidireccional: sube cada `.concepts` completo a una carpeta `concepts_backup/<nombre del dispositivo>/...` en el Drive del usuario, con scope OAuth `drive.file` (solo archivos creados por la app). Dedup vía `BackupLog` (Room) comparando el mismo "fingerprint" de texto. Corre en background con WorkManager (`gallery/backup/BackupWorker.java`).
2. **"GDrive as ProjectSource"** — un modo distinto donde Drive actúa como una carpeta más, navegable en vivo (no hay copia local persistente, se lee directo de la API cada vez).
3. **Sistema de cuentas/licencias** (`core/Cloud/`, `accounts/`) — esto es lo que corre por gRPC contra **`carbon.tophatch.com`** (host configurado en `BuildConfig.ACCOUNTS_URL`, pasado al motor nativo en `di/EngineModule.java`). **Confirmé por grep exhaustivo que esto es exclusivamente autenticación/suscripciones/recibos de compra (`CloudAccountController`, `CloudReceiptController`, `CloudCouponController`) — no hay ningún servicio propio de sincronización de documentos entre dispositivos.** El certificado TLS para ese canal gRPC viene embebido como recurso raw (`R.raw.roots`, un bundle PEM). Analytics usa un endpoint HTTP aparte: `https://tranquility.tophatch.com/`.

## 6. Formatos de exportación soportados por el motor (`core/export/Format.java`)

El enum nativo-espejado lista: **JPEG, PNG, PSD, DXF, SVG, Concepts, RasterPDF, VectorPDF** — confirma que el motor C++ sabe serializar directamente a Photoshop (PSD) y AutoCAD (DXF) además de PDF/SVG/raster e imagen propia.

## 7. Librerías nativas (`lib/arm64-v8a/*.so`) y su rol

| Librería | Rol |
|---|---|
| `libCore.so` | El motor de dibujo/documento en sí — todo lo relevante a `.concepts` |
| `libpdfium.so` | Renderizado de PDF (import de páginas PDF al canvas) |
| `libdigitalink.so`, `libdigitalinksegmentation.so` | Google ML Kit — reconocimiento de trazos/formas a mano alzada, segmentación de strokes |
| `libgrpc*.so`, `libprotobuf*.so`, `libupb.so`, `libaddress_sorting.so`, `libgpr.so` | Cliente gRPC — usado por el sistema de cuentas/licencias (`carbon.tophatch.com`) |
| `libcblite.so` | Couchbase Lite — probablemente la base local usada por el motor para el estado de cuenta/sincronización (no confirmado en detalle, vive dentro de `libCore.so`) |
| `libcrypto.so`, `libssl.so` | OpenSSL — TLS para gRPC/HTTPS |
| `libre2.so` | Regex (RE2, de Google) |
| `libbugsnag-*.so` | Crash reporting nativo (Bugsnag), espejado en Kotlin por `analytics/BugsnagXKt.java` |
| `libabsl_*.so` (~40 archivos) | Abseil — utilidades C++ de Google, dependencia de gRPC |
| `libandroidx.graphics.path.so`, `libandroidx.xr.runtime.openxr.so` | Soporte de Android XR (Quest/Vision Pro), feature flageada (`FEATURE_XR`) |
| `libc++_shared.so` | Runtime de C++ estándar compartido |

## 8. Inventario completo de paquetes Kotlin/Java

### Paquetes centrales para el formato de archivo / almacenamiento / sync

**`storage/`** (152 archivos) — Motor de almacenamiento local "legacy": árbol de carpetas/dibujos en disco (`DrawingFileSystem`, `LocalFileIndexer`, `TreeNodeThreadSafe`), Room DBs de preferencias de UI (orden, agrupación, papelera, panel lateral), y `ZipMetadataLoader`/`DrawingFileStorage` que leen `thumb.jpg`/`metadata.json` de un `.concepts` sin motor nativo (para listar la galería rápido). `ProjectSource` (enum) es la pieza que unifica Local/Público/Drive/Papelera.

**`document/`** (8 archivos) — Capa fina que implementa `FileSource`/`FileHandle`/`FileScanner` (contrato nativo) delegando en `GalleryRepository`. `MappingsKt` hace la conversión `GalleryId` ↔ `FileId` y arma el `FileFingerprint` falso descrito arriba.

**`backup/`** (8 archivos) — Contrato de backup a Drive (`BackupService`, `BackupLog`, `BackupFileVersion`, `BackupFolders`, `BackupDeviceInfo`) + `NoBackup` (no-op).

**`googledrive/`** (21 archivos) — Implementación real de backup y de "Drive como ProjectSource" contra la API REST de Google Drive (`GoogleDrive`, `DriveXKt`, `GoogleDriveIndexer`, `GoogleDriveFileSystemAuth`, `GoogleDriveSignIn`).

**`importsupport/`** (48 archivos) — Importar imágenes/PDFs/archivos externos **hacia adentro** de un dibujo abierto (portapapeles, drag&drop, URLs HTTP, MediaStore, Pexels) — no confundir con importar un `.concepts` completo. `MediaImportController` es el orquestador.

**`gallery/`** (228 archivos) — La pantalla de galería y su repositorio (`GalleryRepository`, ~12.700 líneas, el "God object" de la app): crear/mover/duplicar/borrar/renombrar dibujos y carpetas, papelera, búsqueda, thumbnails, y el flow de cambios que consume `document/AppDocumentFileScanner`. Incluye `gallery/backup/` (worker + view model de backup) y `gallery/migration/` (migraciones de esquemas de carpetas viejos).

**`pdf/`** (14 archivos) — Selector de página PDF para insertar en el canvas (delega el render real a `libpdfium.so` vía `core/PDFHandle`).

### El "espejo" del motor nativo en Kotlin

**`core/`** (383 archivos) — Interfaces/modelos que reflejan 1:1 la API pública de `libCore.so`: `Engine`, `Canvas`, `CanvasController` (con 14 subcontroladores: background, command, debug, document, export, input, interface, picker, renderer, resources, selection, test, undo, workspace), `CanvasDocumentController` (el ciclo de vida de un `.concepts`: `create/open/load/save/saveAs/rename`), tipos de herramienta, PDF, stylus, analytics, hardware info. Subpaquetes:
- `core/Cloud/` (20) — cuentas/licencias/recibos (gRPC, `carbon.tophatch.com`)
- `core/document/` (6) — el contrato de archivos ya descrito
- `core/export/` (12) — formatos y opciones de exportación
- `core/ml/` (15) — reconocimiento de tinta digital
- `core/ui/` (103) — "elementos" nativos expuestos como objetos observables (toolbar, layers, precisión/reglas, status bar, feeds de galería, librería de objetos)

**`di/`** (209 archivos, mayoría boilerplate generado por Dagger/Hilt) — acá están cableadas las rutas/URLs reales: `EngineModule` (arranca el motor nativo con `ACCOUNTS_URL=carbon.tophatch.com`, `filesDir` como `databasePath`/`attachmentsLocalPath`, `cacheDir` como cache de adjuntos), `StorageModule`/`LocalModule` (raíces de almacenamiento local), `GalleryModule`/`BackupModule`, `CanvasModule`, `MLModule`, `QualityModule` (Bugsnag), `AccountsModule`/`GoogleAuthModule`/`GooglePlayStoreModule`.

**`objects/`** (214 archivos) — Librería/marketplace de imágenes-objeto ("stickers") para arrastrar al canvas: `ObjectsViewModel`, `ObjectsRepository` (envuelve `core/ui/CanvasLibraryElement`), APIs de stock photos (Pexels, Unsplash).

### Capa de UI/features (resumen — sin relevancia directa al formato de archivo)

| Paquete | Archivos | Qué es |
|---|---|---|
| `view/` | 184 | Vistas custom genéricas (diálogos de export, banners, animaciones) |
| `controls/` | 106 | Layout/posicionamiento de overlays flotantes (toolbar, toolwheel, panel de layers) |
| `toolwheel/` | 86 | La rueda radial de herramientas (marca registrada de la UI de Concepts) + selector de color estilo Copic |
| `viewmodel/` | 83 | ViewModels MVVM (`GalleryViewModel`, `CanvasViewModel`, etc.) |
| `dialog/` | 82 | Framework de diálogos/overlays |
| `store/` | 120 | Tienda in-app (suscripción Pro, brush packs, object packs, Google Play Billing) |
| `accounts/` | 116 | Autenticación de usuario (`AccountRepository`, Google/Apple sign-in) |
| `databinding/` | 99 | Boilerplate generado por Android Data Binding |
| `common/` | 63 | Utilidades compartidas |
| `utility/` | 56 | Funciones de extensión Kotlin |
| `controller/` | 40 | Controladores intermedios que unen ViewModels con el motor |
| `brushes/` | 38 | Carga de brush packs desde `assets/brushpacks/<uuid>/` (JSON de definición + assets) |
| `ml/` | 43 | API Kotlin de alto nivel para reconocimiento de trazos (sobre `core/ml`) |
| `analytics/` | 32 | Telemetría y crash reporting (Bugsnag, Helpshift) |
| `layers/` | 29 | UI del panel de capas |
| `help/` | 28 | Onboarding y soporte (Helpshift) |
| `extensions/` | 22 | Extensiones Kotlin sobre tipos estándar/Android |
| `keyboard/` + `keyboardshortcuts/` | 18 | Atajos de teclado externo |
| `drawable/` | 10 | `Drawable` custom para chrome de UI |
| `stylus/` | 6 | Manejo de lápiz/stylus (config por fabricante) |
| `prefs/` | 7 | Preferencias de usuario (incluye SharedPreferences cifradas) |
| `precision/` | 7 | UI de reglas/guías de precisión |
| `model/` | 7 | Modelos legacy de galería (`LegacyGalleryDrawing`, etc.) |

**Paquetes menores (uno por línea):** `interstitial` (promo de suscripción), `reminder` (recordatorio de suscripción), `whatsnew` (changelog), `google`/`googleauth` (Google Sign-In), `support` (Helpshift + links), `settings` (opciones de export/UI), `features` (feature flags con fallback no-op), `haptics` (feedback háptico del stylus), `dragndrop` (drag&drop de dibujos), `data` (`ImportExport`, helpers de disco), `presenter` (selección MVP), `images` (loader de imágenes + créditos Pexels), `fragment` (base de DialogFragment), `sensors` (acelerómetro), `compose` (helpers Compose compartidos), `xr` (Android XR/espacial), `adapter` (adaptadores Flow↔engine), `util` (cola de listeners), `privacy` (link a política de privacidad), `layout` (interfaz `Overlay`), `artboards` (IDs de artboard), `account` (diálogos de alerta de cuenta), `window` (adaptación a pantallas plegables), `style` (colores de la tienda), `partner` (ajustes específicos OEM, Oppo), `measurement` (popup de regla/medición), `hack` (workaround de rendimiento en dispositivos débiles), `effects` (helpers visuales), `device` (detección de modo ahorro de batería), `colors` (modelo de paleta), `brushoptions` (modelo de parámetros de pincel), `apple` (contrato Apple Sign-In), `animator` (interpolador de resorte custom).

## 9. Hallazgos concretos con valor para ConceptSerializer

1. **Confirma lo que ya sabíamos:** el `.concepts` es un ZIP plano, con `thumb.jpg` y `metadata.json` en la raíz, más `tree.pack` (y todo lo demás) que solo entiende el motor nativo.
2. **`metadata.json` tiene exactamente 4 campos conocidos por Java:** `identifier`, `backgroundColor`, `creationTime`, `modificationTime` (ambas fechas ISO8601, nullable).
3. **MIME type oficial:** `application/vnd.tophatch.concepts` — útil si alguna vez querés registrar el tipo en algún backend/servidor propio.
4. **La app oficial nunca hace range-read remoto** — siempre baja/copia el archivo completo a local antes de que el motor lo abra. El enfoque de range-read que ya implementó `web-viewer` (ver memoria `project-optimizacion-gama-baja`) es una optimización propia, no algo que TopHatch haga — coherente con que ellos sí pueden permitirse bajar el archivo completo (tienen su propio backend/cuenta, nosotros leemos de Drive público).
5. **El motor exporta a PSD y DXF además de PDF/SVG/raster** — si en algún momento se quiere exportar desde el visor web a un formato más "profesional" que PDF/JPG, esos son los formatos que la app real ofrece como opciones nativas (aunque el export en sí seguiría necesitando reimplementarse, ya que vive en C++).
6. **No hay sync de documentos propio de TopHatch** — la única sincronización entre dispositivos que ofrece la app es Google Drive (backup unidireccional o "Drive como carpeta"). El sistema gRPC propio (`carbon.tophatch.com`) es solo cuentas/licencias.
7. Para llegar más profundo en el formato interno (estructura exacta de `tree.pack`, cómo se serializan strokes/layers a bytes) hace falta desensamblar `libCore.so` — no cubierto en esta pasada, es un trabajo de RE binario con Ghidra/IDA, no de lectura de código Java.
