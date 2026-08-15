# MAPA_IA_WEB — web-viewer

> Documento maestro para agentes IA. Leer este archivo primero: contiene el mapa
> completo del proyecto web (entrypoints, módulos, funciones, relaciones, APIs).

- Generado: 2026-08-15 10:18
- Archivos propios analizados: 102 (18835 líneas)
- Archivos vendor/excluidos: 0
- package.json: web-viewer v0.0.0
- Cómo correr (scripts npm):
  - `npm run dev` → `vite`
  - `npm run build` → `tsc -b && vite build`
  - `npm run lint` → `oxlint`
  - `npm run preview` → `vite preview`

## 1. Entrypoints

- **index.html**
  - Carga scripts en orden:
    1. `/src/main.tsx`

## 2. Árbol resumido (solo código propio)

```
debug.ts
index.html
scratch/test_export.cjs
scratch/test_local.cjs
scratch/test_ui.cjs
scratch/update_css.cjs
screenshot.js
scripts/audit-colocacion.mjs
scripts/audit-estructura.mjs
scripts/audit-geometria.mjs
scripts/audit-imagenes.mjs
scripts/bench-arranque.mjs
scripts/bench-lowend.mjs
scripts/bench-pesado.mjs
scripts/bench-reapertura.mjs
scripts/bench-viewer.mjs
scripts/browser/audit-colocacion-payload.ts
scripts/browser/audit-estructura-payload.ts
scripts/browser/audit-imagen-payload.ts
scripts/browser/audit-payload.ts
scripts/browser/bench-payload.ts
scripts/browser/centro-payload.ts
scripts/browser/comparar-thumb-payload.ts
scripts/browser/dump-item8-payload.ts
scripts/browser/lowend-payload.ts
scripts/browser/profile-payload.ts
scripts/browser/sentido-texto-payload.ts
scripts/browser/stats-payload.ts
scripts/browser/test-matrices-payload.ts
scripts/browser/thumb-probe.ts
scripts/cap-centro.mjs
scripts/cap-desface.mjs
scripts/cap-detalle.mjs
scripts/cap-galeria-menu.mjs
scripts/cap-gesto.mjs
scripts/cap-rotar-export.mjs
scripts/cap-rotar.mjs
scripts/cap-ruta.mjs
scripts/cap-trazo.mjs
scripts/cap-zoomall.mjs
scripts/captura-visual.mjs
scripts/comparar-thumb.mjs
scripts/crawl-drive.mjs
scripts/diag-cache-237.mjs
scripts/diag-cache.mjs
scripts/diag-workers.mjs
scripts/dump-item8.mjs
scripts/e2e-descarga-galeria.mjs
scripts/e2e-export.mjs
scripts/e2e-funciones.mjs
scripts/e2e-galeria.mjs
scripts/e2e-gama-baja.mjs
scripts/e2e-nombres-rutas.mjs
scripts/e2e-perdida-imagenes.mjs
scripts/e2e-viewer.mjs
scripts/e2e-zoom-cache.mjs
scripts/gen-thumbnails.mjs
scripts/perfil-gestos.mjs
scripts/peso-recursos.mjs
scripts/profile-heavy.mjs
scripts/recorrido.mjs
scripts/resolve-url.mjs
scripts/run-suite.mjs
scripts/sentido-texto.mjs
scripts/servir-corpus.mjs
scripts/stats-corpus.mjs
scripts/test-matrices.mjs
src/App.tsx
src/config.ts
src/device.ts
src/fonts.css
src/Gallery/analytics.ts
src/Gallery/driveClient.ts
src/Gallery/driveCrawler.ts
src/Gallery/exportMetadata.ts
src/Gallery/exportRender.ts
src/Gallery/Gallery.css
src/Gallery/Gallery.tsx
src/Gallery/NamePrompt.tsx
src/Gallery/raster.worker.ts
src/Gallery/rasterCache.ts
src/Gallery/recientes.ts
src/Gallery/renderCore.ts
src/Gallery/supabaseClient.ts
src/Gallery/thumbnail.ts
src/Gallery/userIdentity.ts
src/index.css
src/main.tsx
src/rutas.ts
src/theme.ts
src/VisorConcept/App.css
src/VisorConcept/App.tsx
src/VisorConcept/index.tsx
src/VisorConcept/InteractivePreview.tsx
src/VisorConcept/parser.ts
src/VisorConcept/progreso.ts
src/VisorConcept/Viewer.tsx
src/VisorConcept/zip.ts
supabase/functions/concepts-drive/index.ts
test-msgpack.ts
test-zip.ts
vite.config.ts
```

## 3. Módulos

| Archivo | Líneas | Exporta | Descripción |
|---|---|---|---|
| `debug.ts` | 28 | - | - |
| `index.html` | 97 | - | - |
| `scratch/test_export.cjs` | 114 | - | - |
| `scratch/test_local.cjs` | 96 | - | - |
| `scratch/test_ui.cjs` | 73 | - | - |
| `scratch/update_css.cjs` | 63 | - | - |
| `screenshot.js` | 46 | - | - |
| `scripts/audit-colocacion.mjs` | 88 | - | ¿Las imagenes estan colocadas donde corresponde, o hay dibujos "flotan… |
| `scripts/audit-estructura.mjs` | 72 | - | ¿Por que un .concepts con recursos pesados no muestra ninguna imagen? |
| `scripts/audit-geometria.mjs` | 56 | - | Audita la geometria de los .concepts mas pesados: ¿las imagenes estan |
| `scripts/audit-imagenes.mjs` | 90 | - | ¿Los planos se ven estirados? Compara el tamaño que el parser cree que |
| `scripts/bench-arranque.mjs` | 177 | - | Mide el ARRANQUE del build de produccion (dist/) como en un telefono d… |
| `scripts/bench-lowend.mjs` | 114 | - | Benchmark "gama baja": corre el pipeline real del visor con CPU thrott… |
| `scripts/bench-pesado.mjs` | 379 | - | Banco de pruebas del PEOR CASO: el dibujo mas pesado, en un telefono d… |
| `scripts/bench-reapertura.mjs` | 83 | - | Mide cuanto se gana al REABRIR un dibujo ya visto (cache persistente d… |
| `scripts/bench-viewer.mjs` | 101 | - | Benchmark del visor sobre uno o varios .concepts locales, usando el co… |
| `scripts/browser/audit-colocacion-payload.ts` | 138 | - | ¿Las imagenes que el parser dice que hay estan DE VERDAD colocadas en … |
| `scripts/browser/audit-estructura-payload.ts` | 124 | - | Vuelca la ESTRUCTURA del arbol de un .concepts: que tipos de item hay … |
| `scripts/browser/audit-imagen-payload.ts` | 122 | - | Audita, recurso por recurso, si el tamaño que el parser cree que tiene… |
| `scripts/browser/audit-payload.ts` | 81 | - | Audita la geometria de un .concepts: matrices de transform de cada ima… |
| `scripts/browser/bench-payload.ts` | 126 | - | Mide el pipeline REAL del visor, end to end, con el codigo que corre e… |
| `scripts/browser/centro-payload.ts` | 169 | - | Prueba DECISIVA y no circular: agarra un trazo que HOY queda flotando |
| `scripts/browser/comparar-thumb-payload.ts` | 261 | - | ¿Nuestro lienzo se parece a lo que dibuja la propia app Concepts? |
| `scripts/browser/dump-item8-payload.ts` | 96 | - | Vuelca, ya decodificado con el ExtensionCodec real (UUIDs como string, |
| `scripts/browser/lowend-payload.ts` | 183 | - | Mide el pipeline REAL del visor como si corriera en un telefono de gam… |
| `scripts/browser/profile-payload.ts` | 127 | - | Corre DENTRO del navegador (lo sirve Vite en dev). Vive en un modulo r… |
| `scripts/browser/sentido-texto-payload.ts` | 116 | - | ¿El visor dibuja el documento cabeza abajo? |
| `scripts/browser/stats-payload.ts` | 45 | - | Corre dentro del navegador: parsea un .concepts y devuelve solo metric… |
| `scripts/browser/test-matrices-payload.ts` | 291 | - | Prueba, para cada imagen colocada, tres candidatas de matriz de posici… |
| `scripts/browser/thumb-probe.ts` | 63 | - | Mide, recurso por recurso, cuanto cuesta generar la miniatura de un |
| `scripts/cap-centro.mjs` | 60 | - | Prueba decisiva: agarra un trazo que HOY (esquina superior-izquierda) … |
| `scripts/cap-desface.mjs` | 74 | - | Captura el plano completo y un detalle de la zona limite entre trazos … |
| `scripts/cap-detalle.mjs` | 64 | - | Captura un plano MUY de cerca, para leer a ojo si el texto sale bien |
| `scripts/cap-galeria-menu.mjs` | 26 | - | - |
| `scripts/cap-gesto.mjs` | 119 | - | Captura el lienzo EN MEDIO de un paneo y de un pinch. |
| `scripts/cap-rotar-export.mjs` | 58 | - | - |
| `scripts/cap-rotar.mjs` | 68 | - | Prueba a mano el boton nuevo de "rotar 90 a la derecha" en la vista de |
| `scripts/cap-ruta.mjs` | 33 | - | - |
| `scripts/cap-trazo.mjs` | 112 | - | Zoom MUY cerrado sobre un trazo puntual que cae dentro de una imagen, … |
| `scripts/cap-zoomall.mjs` | 73 | - | Prueba "zoom all" de verdad: abre el dibujo, hace click en el boton re… |
| `scripts/captura-visual.mjs` | 89 | - | Captura pantallas del visor real para comprobar A OJO que las imagenes |
| `scripts/comparar-thumb.mjs` | 86 | - | ¿Nuestro render coincide con el que hace la propia app Concepts? |
| `scripts/crawl-drive.mjs` | 137 | - | Recorre TODO el arbol de la carpeta publica de Drive (via el edge func… |
| `scripts/diag-cache-237.mjs` | 88 | - | Por que el cache del dibujo de 237 MB acierta 4 de 6: compara las clav… |
| `scripts/diag-cache.mjs` | 114 | - | Diagnostico puntual del cache persistente de rasterizados: ¿se usa el |
| `scripts/diag-workers.mjs` | 61 | - | ¿De verdad se esta rasterizando fuera del hilo principal? |
| `scripts/dump-item8.mjs` | 23 | - | - |
| `scripts/e2e-descarga-galeria.mjs` | 105 | - | Prueba la descarga multiple desde la galeria (varios dibujos seleccion… |
| `scripts/e2e-export.mjs` | 132 | - | Verifica que exportar siga funcionando despues de separar la resolucio… |
| `scripts/e2e-funciones.mjs` | 338 | - | Verifica, una por una, las funciones nuevas sobre el dibujo MAS PESADO… |
| `scripts/e2e-galeria.mjs` | 97 | - | Navega la galeria como un usuario: entra a una carpeta con dibujos, es… |
| `scripts/e2e-gama-baja.mjs` | 323 | - | Test end-to-end del visor REAL (la app, no el pipeline suelto) emuland… |
| `scripts/e2e-nombres-rutas.mjs` | 172 | - | Comprueba lo pedido en la ultima ronda: |
| `scripts/e2e-perdida-imagenes.mjs` | 234 | - | ¿Se pierden imagenes al hacer zoom o al panear? |
| `scripts/e2e-viewer.mjs` | 147 | - | Test end to end de la app real: abre la galeria, sube un .concepts por… |
| `scripts/e2e-zoom-cache.mjs` | 163 | - | Dos comprobaciones puntuales que el test general no cubria bien: |
| `scripts/gen-thumbnails.mjs` | 208 | - | Genera las miniaturas de todos los .concepts bajados por crawl-drive.m… |
| `scripts/perfil-gestos.mjs` | 144 | - | ¿QUE bloquea el hilo principal mientras se panea y se hace zoom? |
| `scripts/peso-recursos.mjs` | 128 | - | ¿Cuanto pesa cada recurso y cuanto espacio ocupa en el dibujo? |
| `scripts/profile-heavy.mjs` | 61 | - | Perfila EN DETALLE un .concepts pesado, reproduciendo lo que hace el v… |
| `scripts/recorrido.mjs` | 480 | - | RECORRIDO COMPLETO: es el instrumento con el que se compara una iterac… |
| `scripts/resolve-url.mjs` | 11 | - | - |
| `scripts/run-suite.mjs` | 165 | - | Corre toda la bateria de tests contra una URL (por defecto produccion)… |
| `scripts/sentido-texto.mjs` | 32 | - | ¿Cuantos dibujos de la carpeta se estan viendo cabeza abajo? |
| `scripts/servir-corpus.mjs` | 95 | - | Sirve los .concepts del corpus local por HTTP con soporte de Range. |
| `scripts/stats-corpus.mjs` | 73 | - | Mide TODO el corpus local de .concepts: tiempo de parseo, trazos, punt… |
| `scripts/test-matrices.mjs` | 50 | - | - |
| `src/App.tsx` | 234 | - | - |
| `src/config.ts` | 23 | - | Config publica del viewer. La anon key de Supabase esta pensada para |
| `src/device.ts` | 146 | - | Deteccion de gama del dispositivo y presupuestos derivados.     Todo e… |
| `src/fonts.css` | 25 | - | Inter, self-hosted, SOLO el subset latin.     Antes la fuente venia de… |
| `src/Gallery/analytics.ts` | 38 | - | - |
| `src/Gallery/driveClient.ts` | 134 | - | - |
| `src/Gallery/driveCrawler.ts` | 75 | - | - |
| `src/Gallery/exportMetadata.ts` | 31 | - | - |
| `src/Gallery/exportRender.ts` | 254 | - | - |
| `src/Gallery/Gallery.css` | 651 | - | - |
| `src/Gallery/Gallery.tsx` | 914 | - | - |
| `src/Gallery/NamePrompt.tsx` | 57 | - | - |
| `src/Gallery/raster.worker.ts` | 364 | - | Rasteriza PDFs y fotos FUERA del hilo principal.       Es la diferenci… |
| `src/Gallery/rasterCache.ts` | 313 | - | Cache persistente (IndexedDB) de recursos ya rasterizados.     Rasteri… |
| `src/Gallery/recientes.ts` | 98 | - | Ultimos dibujos abiertos.     Guarda SOLO la ruta y el id (unos ciento… |
| `src/Gallery/renderCore.ts` | 1053 | - | - |
| `src/Gallery/supabaseClient.ts` | 189 | - | Acceso a Supabase por REST directo (PostgREST), sin el SDK.     El SDK… |
| `src/Gallery/thumbnail.ts` | 222 | - | - |
| `src/Gallery/userIdentity.ts` | 18 | - | - |
| `src/index.css` | 102 | - | Tokens del tema, para TODA la app.     Viven aca y no en VisorConcept/… |
| `src/main.tsx` | 12 | - | - |
| `src/rutas.ts` | 65 | - | Rutas compartibles: la URL refleja donde estas.       /               … |
| `src/theme.ts` | 69 | - | Tema claro/oscuro, con oscuro por defecto.     El tema se aplica como … |
| `src/VisorConcept/App.css` | 560 | - | La fuente se define en src/fonts.css (self-hosted, subset latin). Ante… |
| `src/VisorConcept/App.tsx` | 572 | - | - |
| `src/VisorConcept/index.tsx` | 49 | - | - |
| `src/VisorConcept/InteractivePreview.tsx` | 389 | - | - |
| `src/VisorConcept/parser.ts` | 754 | - | - |
| `src/VisorConcept/progreso.ts` | 142 | - | Progreso REAL de apertura de un dibujo, con fase y tiempo estimado.   … |
| `src/VisorConcept/Viewer.tsx` | 2107 | - | - |
| `src/VisorConcept/zip.ts` | 684 | - | Lector de ZIP minimo, pensado para archivos .concepts.     Reemplaza a… |
| `supabase/functions/concepts-drive/index.ts` | 368 | - | Proxy publico (sin API key) para leer una carpeta publica de Google Dr… |
| `test-msgpack.ts` | 31 | - | - |
| `test-zip.ts` | 10 | - | - |
| `vite.config.ts` | 20 | - | - |

## 4. Funciones y clases

### screenshot.js
- async run() @línea 9

### scripts/bench-reapertura.mjs
- async abrir(browser, f, etiqueta) @línea 25

### scripts/crawl-drive.mjs
- async withRetry(fn, label, attempts=…) @línea 29
- async listFolder(folderId) @línea 45
- async downloadFile(fileId) @línea 58
- async crawl(folderId, folderName, breadcrumb) @línea 76

### scripts/diag-cache-237.mjs
- async abrir(etiqueta) @línea 45

### scripts/diag-cache.mjs
- async abrir(etiqueta) @línea 28

### scripts/e2e-export.mjs
- async esperarDescarga(nombre, timeoutMs=…) @línea 67
- async exportar(etiqueta, textoBoton, nombreArchivo) @línea 87

### scripts/e2e-funciones.mjs
- async cerrarPromptNombre(p) @línea 52

### scripts/e2e-gama-baja.mjs
- mb(bytes) @línea 32

### scripts/e2e-viewer.mjs
- async medirFrames(accion, etiqueta) @línea 85

### scripts/peso-recursos.mjs
- leerIndice(buf) @línea 21

### scripts/recorrido.mjs
- ejecutar(comando) @línea 28

### scripts/run-suite.mjs
- correr(t) @línea 83
- destacados(r) @línea 127

## 5. Grafo de relaciones

- `debug.ts` → **importa** → `fs`
- `debug.ts` → **importa** → `./src/parser.ts`
- `index.html` → **carga** → `src/main.tsx`
- `scratch/test_export.cjs` → **importa** → `puppeteer-core`
- `scratch/test_export.cjs` → **importa** → `path`
- `scratch/test_export.cjs` → **importa** → `fs`
- `scratch/test_export.cjs` → **importa** → `os`
- `scratch/test_local.cjs` → **importa** → `puppeteer`
- `scratch/test_ui.cjs` → **importa** → `puppeteer`
- `scratch/update_css.cjs` → **importa** → `fs`
- `scratch/update_css.cjs` → **importa** → `path`
- `screenshot.js` → **importa** → `puppeteer`
- `screenshot.js` → **importa** → `child_process`
- `screenshot.js` → **importa** → `path`
- `screenshot.js` → **importa** → `url`
- `scripts/audit-colocacion.mjs` → **importa** → `node:fs/promises`
- `scripts/audit-colocacion.mjs` → **importa** → `node:path`
- `scripts/audit-colocacion.mjs` → **importa** → `puppeteer`
- `scripts/audit-estructura.mjs` → **importa** → `node:fs/promises`
- `scripts/audit-estructura.mjs` → **importa** → `node:path`
- `scripts/audit-estructura.mjs` → **importa** → `puppeteer`
- `scripts/audit-geometria.mjs` → **importa** → `node:fs/promises`
- `scripts/audit-geometria.mjs` → **importa** → `node:path`
- `scripts/audit-geometria.mjs` → **importa** → `puppeteer`
- `scripts/audit-imagenes.mjs` → **importa** → `node:fs/promises`
- `scripts/audit-imagenes.mjs` → **importa** → `node:path`
- `scripts/audit-imagenes.mjs` → **importa** → `puppeteer`
- `scripts/bench-arranque.mjs` → **importa** → `node:fs/promises`
- `scripts/bench-arranque.mjs` → **importa** → `node:http`
- `scripts/bench-arranque.mjs` → **importa** → `node:zlib`
- `scripts/bench-arranque.mjs` → **importa** → `node:path`
- `scripts/bench-arranque.mjs` → **importa** → `puppeteer`
- `scripts/bench-arranque.mjs` → **manipula** → `.folder-card`
- `scripts/bench-arranque.mjs` → **manipula** → `.gallery-card:not(.folder-card)`
- `scripts/bench-arranque.mjs` → **manipula** → `.gallery-thumb img`
- `scripts/bench-lowend.mjs` → **importa** → `node:fs/promises`
- `scripts/bench-lowend.mjs` → **importa** → `node:http`
- `scripts/bench-lowend.mjs` → **importa** → `node:path`
- `scripts/bench-lowend.mjs` → **importa** → `puppeteer`
- `scripts/bench-pesado.mjs` → **importa** → `node:fs/promises`
- `scripts/bench-pesado.mjs` → **importa** → `node:path`
- `scripts/bench-pesado.mjs` → **importa** → `puppeteer`
- `scripts/bench-pesado.mjs` → **lee-global** → `__viewerCobertura`
- `scripts/bench-pesado.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/bench-pesado.mjs` → **lee-global** → `__viewerStats`
- `scripts/bench-pesado.mjs` → **lee-global** → `__viewerVista`
- `scripts/bench-pesado.mjs` → **lee-global** → `gc`
- `scripts/bench-pesado.mjs` → **manipula** → `#canvas`
- `scripts/bench-pesado.mjs` → **manipula** → `.viewer-carga`
- `scripts/bench-pesado.mjs` → **manipula** → `#[aria-label="Ver todo el dibujo"]`
- `scripts/bench-reapertura.mjs` → **importa** → `node:fs/promises`
- `scripts/bench-reapertura.mjs` → **importa** → `node:path`
- `scripts/bench-reapertura.mjs` → **importa** → `puppeteer`
- `scripts/bench-reapertura.mjs` → **lee-global** → `__viewerStats`
- `scripts/bench-reapertura.mjs` → **manipula** → `#canvas`
- `scripts/bench-reapertura.mjs` → **manipula** → `.viewer-carga`
- `scripts/bench-viewer.mjs` → **importa** → `node:fs/promises`
- `scripts/bench-viewer.mjs` → **importa** → `node:http`
- `scripts/bench-viewer.mjs` → **importa** → `node:path`
- `scripts/bench-viewer.mjs` → **importa** → `puppeteer`
- `scripts/browser/audit-colocacion-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/audit-estructura-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/audit-estructura-payload.ts` → **importa** → `../../src/VisorConcept/zip`
- `scripts/browser/audit-estructura-payload.ts` → **importa** → `@msgpack/msgpack`
- `scripts/browser/audit-imagen-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/audit-imagen-payload.ts` → **importa** → `pdfjs-dist`
- `scripts/browser/audit-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/bench-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/centro-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/comparar-thumb-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/comparar-thumb-payload.ts` → **importa** → `../../src/Gallery/renderCore`
- `scripts/browser/dump-item8-payload.ts` → **importa** → `../../src/VisorConcept/zip`
- `scripts/browser/dump-item8-payload.ts` → **importa** → `@msgpack/msgpack`
- `scripts/browser/lowend-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/lowend-payload.ts` → **importa** → `../../src/VisorConcept/zip`
- `scripts/browser/profile-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/profile-payload.ts` → **importa** → `../../src/Gallery/renderCore`
- `scripts/browser/sentido-texto-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/sentido-texto-payload.ts` → **importa** → `pdfjs-dist`
- `scripts/browser/stats-payload.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/test-matrices-payload.ts` → **importa** → `../../src/VisorConcept/zip`
- `scripts/browser/test-matrices-payload.ts` → **importa** → `@msgpack/msgpack`
- `scripts/browser/thumb-probe.ts` → **importa** → `../../src/VisorConcept/parser`
- `scripts/browser/thumb-probe.ts` → **importa** → `../../src/Gallery/renderCore`
- `scripts/cap-centro.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-centro.mjs` → **importa** → `node:path`
- `scripts/cap-centro.mjs` → **importa** → `puppeteer`
- `scripts/cap-desface.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-desface.mjs` → **importa** → `node:path`
- `scripts/cap-desface.mjs` → **importa** → `puppeteer`
- `scripts/cap-desface.mjs` → **lee-global** → `__viewerCajas`
- `scripts/cap-desface.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/cap-desface.mjs` → **manipula** → `#canvas`
- `scripts/cap-desface.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-detalle.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-detalle.mjs` → **importa** → `node:path`
- `scripts/cap-detalle.mjs` → **importa** → `puppeteer`
- `scripts/cap-detalle.mjs` → **lee-global** → `__viewerCajas`
- `scripts/cap-detalle.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/cap-detalle.mjs` → **lee-global** → `__viewerStats`
- `scripts/cap-detalle.mjs` → **manipula** → `#canvas`
- `scripts/cap-detalle.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-galeria-menu.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-galeria-menu.mjs` → **importa** → `node:path`
- `scripts/cap-galeria-menu.mjs` → **importa** → `puppeteer`
- `scripts/cap-galeria-menu.mjs` → **manipula** → `#canvas`
- `scripts/cap-galeria-menu.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-galeria-menu.mjs` → **manipula** → `#button`
- `scripts/cap-gesto.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-gesto.mjs` → **importa** → `node:path`
- `scripts/cap-gesto.mjs` → **importa** → `puppeteer`
- `scripts/cap-gesto.mjs` → **lee-global** → `__viewerVista`
- `scripts/cap-gesto.mjs` → **manipula** → `#canvas`
- `scripts/cap-gesto.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-gesto.mjs` → **manipula** → `#[aria-label="Ver todo el dibujo"]`
- `scripts/cap-rotar-export.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-rotar-export.mjs` → **importa** → `node:path`
- `scripts/cap-rotar-export.mjs` → **importa** → `puppeteer`
- `scripts/cap-rotar-export.mjs` → **manipula** → `#canvas`
- `scripts/cap-rotar-export.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-rotar-export.mjs` → **manipula** → `#button`
- `scripts/cap-rotar-export.mjs` → **manipula** → `.gallery-item`
- `scripts/cap-rotar.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-rotar.mjs` → **importa** → `node:path`
- `scripts/cap-rotar.mjs` → **importa** → `puppeteer`
- `scripts/cap-rotar.mjs` → **manipula** → `#canvas`
- `scripts/cap-rotar.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-rotar.mjs` → **manipula** → `#button`
- `scripts/cap-rotar.mjs` → **manipula** → `.gallery-item`
- `scripts/cap-ruta.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-ruta.mjs` → **importa** → `node:path`
- `scripts/cap-ruta.mjs` → **importa** → `puppeteer`
- `scripts/cap-ruta.mjs` → **lee-global** → `__viewerStats`
- `scripts/cap-ruta.mjs` → **manipula** → `#canvas`
- `scripts/cap-ruta.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-trazo.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-trazo.mjs` → **importa** → `node:path`
- `scripts/cap-trazo.mjs` → **importa** → `puppeteer`
- `scripts/cap-trazo.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/cap-trazo.mjs` → **manipula** → `#canvas`
- `scripts/cap-trazo.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-zoomall.mjs` → **importa** → `node:fs/promises`
- `scripts/cap-zoomall.mjs` → **importa** → `node:path`
- `scripts/cap-zoomall.mjs` → **importa** → `puppeteer`
- `scripts/cap-zoomall.mjs` → **lee-global** → `__viewerCajas`
- `scripts/cap-zoomall.mjs` → **lee-global** → `__viewerVista`
- `scripts/cap-zoomall.mjs` → **manipula** → `#canvas`
- `scripts/cap-zoomall.mjs` → **manipula** → `.viewer-carga`
- `scripts/cap-zoomall.mjs` → **manipula** → `#button`
- `scripts/captura-visual.mjs` → **importa** → `node:fs/promises`
- `scripts/captura-visual.mjs` → **importa** → `node:path`
- `scripts/captura-visual.mjs` → **importa** → `puppeteer`
- `scripts/captura-visual.mjs` → **lee-global** → `__viewerStats`
- `scripts/captura-visual.mjs` → **manipula** → `#canvas`
- `scripts/captura-visual.mjs` → **manipula** → `.viewer-carga`
- `scripts/comparar-thumb.mjs` → **importa** → `node:fs/promises`
- `scripts/comparar-thumb.mjs` → **importa** → `node:path`
- `scripts/comparar-thumb.mjs` → **importa** → `puppeteer`
- `scripts/crawl-drive.mjs` → **importa** → `node:fs/promises`
- `scripts/crawl-drive.mjs` → **importa** → `node:fs`
- `scripts/crawl-drive.mjs` → **importa** → `node:path`
- `scripts/crawl-drive.mjs` → **llama-api** → `fetch `/concepts-drive?action=list&folderId=…``
- `scripts/crawl-drive.mjs` → **llama-api** → `fetch `/concepts-drive?action=download&fileId=…``
- `scripts/diag-cache-237.mjs` → **importa** → `node:fs/promises`
- `scripts/diag-cache-237.mjs` → **importa** → `node:path`
- `scripts/diag-cache-237.mjs` → **importa** → `puppeteer`
- `scripts/diag-cache-237.mjs` → **lee-global** → `__viewerStats`
- `scripts/diag-cache-237.mjs` → **manipula** → `#canvas`
- `scripts/diag-cache-237.mjs` → **manipula** → `.viewer-carga`
- `scripts/diag-cache.mjs` → **importa** → `node:fs/promises`
- `scripts/diag-cache.mjs` → **importa** → `node:path`
- `scripts/diag-cache.mjs` → **importa** → `puppeteer`
- `scripts/diag-cache.mjs` → **lee-global** → `__viewerStats`
- `scripts/diag-cache.mjs` → **manipula** → `#canvas`
- `scripts/diag-cache.mjs` → **manipula** → `.viewer-carga`
- `scripts/diag-workers.mjs` → **importa** → `node:fs/promises`
- `scripts/diag-workers.mjs` → **importa** → `node:path`
- `scripts/diag-workers.mjs` → **importa** → `puppeteer`
- `scripts/diag-workers.mjs` → **lee-global** → `__viewerStats`
- `scripts/diag-workers.mjs` → **manipula** → `#canvas`
- `scripts/diag-workers.mjs` → **manipula** → `.viewer-carga`
- `scripts/dump-item8.mjs` → **importa** → `puppeteer`
- `scripts/e2e-descarga-galeria.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-descarga-galeria.mjs` → **importa** → `node:path`
- `scripts/e2e-descarga-galeria.mjs` → **importa** → `puppeteer`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.folder-card .gallery-name`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.folder-card`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-name`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-card.skeleton`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-status`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-grid:not(.gallery-folders-grid) .gallery-card`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-checkbox`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-toolbar-btn`
- `scripts/e2e-descarga-galeria.mjs` → **manipula** → `.gallery-modal-option`
- `scripts/e2e-export.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-export.mjs` → **importa** → `node:path`
- `scripts/e2e-export.mjs` → **importa** → `puppeteer`
- `scripts/e2e-export.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-export.mjs` → **manipula** → `.dropdown-menu`
- `scripts/e2e-funciones.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-funciones.mjs` → **importa** → `node:path`
- `scripts/e2e-funciones.mjs` → **importa** → `puppeteer`
- `scripts/e2e-funciones.mjs` → **lee-global** → `__viewerStats`
- `scripts/e2e-funciones.mjs` → **lee-global** → `dispatchEvent`
- `scripts/e2e-funciones.mjs` → **manipula** → `#button`
- `scripts/e2e-funciones.mjs` → **manipula** → `.gallery-reset-btn`
- `scripts/e2e-funciones.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-funciones.mjs` → **manipula** → `.viewer-carga-fase`
- `scripts/e2e-funciones.mjs` → **manipula** → `.viewer-carga-pct`
- `scripts/e2e-funciones.mjs` → **manipula** → `.viewer-carga-pie`
- `scripts/e2e-funciones.mjs` → **manipula** → `.viewer-carga-relleno`
- `scripts/e2e-funciones.mjs` → **manipula** → `#canvas`
- `scripts/e2e-funciones.mjs` → **manipula** → `#button[title="Ver todo el dibujo"]`
- `scripts/e2e-funciones.mjs` → **manipula** → `.gallery-reciente`
- `scripts/e2e-funciones.mjs` → **manipula** → `.gallery-reciente-nombre`
- `scripts/e2e-funciones.mjs` → **manipula** → `.gallery-reciente-ruta`
- `scripts/e2e-galeria.mjs` → **importa** → `node:path`
- `scripts/e2e-galeria.mjs` → **importa** → `puppeteer`
- `scripts/e2e-galeria.mjs` → **manipula** → `.folder-card .gallery-name`
- `scripts/e2e-galeria.mjs` → **manipula** → `.folder-card`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-name`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-breadcrumb-item`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-card.skeleton`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-status`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-grid:not(.gallery-folders-grid) .gallery-card`
- `scripts/e2e-galeria.mjs` → **manipula** → `#img`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-thumb-error`
- `scripts/e2e-galeria.mjs` → **manipula** → `.gallery-thumb img`
- `scripts/e2e-gama-baja.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-gama-baja.mjs` → **importa** → `node:path`
- `scripts/e2e-gama-baja.mjs` → **importa** → `puppeteer`
- `scripts/e2e-gama-baja.mjs` → **lee-global** → `gc`
- `scripts/e2e-gama-baja.mjs` → **manipula** → `#canvas`
- `scripts/e2e-gama-baja.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-nombres-rutas.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-nombres-rutas.mjs` → **importa** → `node:path`
- `scripts/e2e-nombres-rutas.mjs` → **importa** → `puppeteer`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `#canvas`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.filename-display`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.viewer-refinando`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.gallery-reciente-nombre`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.gallery-reciente-ruta`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `#button`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.gallery-card:not(.folder-card)`
- `scripts/e2e-nombres-rutas.mjs` → **manipula** → `.folder-card`
- `scripts/e2e-perdida-imagenes.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-perdida-imagenes.mjs` → **importa** → `node:path`
- `scripts/e2e-perdida-imagenes.mjs` → **importa** → `puppeteer`
- `scripts/e2e-perdida-imagenes.mjs` → **lee-global** → `__viewerCajas`
- `scripts/e2e-perdida-imagenes.mjs` → **lee-global** → `__viewerCobertura`
- `scripts/e2e-perdida-imagenes.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/e2e-perdida-imagenes.mjs` → **lee-global** → `__viewerVista`
- `scripts/e2e-perdida-imagenes.mjs` → **manipula** → `#canvas`
- `scripts/e2e-perdida-imagenes.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-viewer.mjs` → **escribe-global** → `__f`
- `scripts/e2e-viewer.mjs` → **escribe-global** → `__stop`
- `scripts/e2e-viewer.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-viewer.mjs` → **importa** → `node:path`
- `scripts/e2e-viewer.mjs` → **importa** → `puppeteer`
- `scripts/e2e-viewer.mjs` → **lee-global** → `__f`
- `scripts/e2e-viewer.mjs` → **lee-global** → `__stop`
- `scripts/e2e-viewer.mjs` → **manipula** → `.viewer-carga`
- `scripts/e2e-viewer.mjs` → **manipula** → `.canvas-wrapper canvas`
- `scripts/e2e-viewer.mjs` → **manipula** → `.filename-display`
- `scripts/e2e-zoom-cache.mjs` → **importa** → `node:fs/promises`
- `scripts/e2e-zoom-cache.mjs` → **importa** → `node:path`
- `scripts/e2e-zoom-cache.mjs` → **importa** → `puppeteer`
- `scripts/e2e-zoom-cache.mjs` → **lee-global** → `__viewerStats`
- `scripts/e2e-zoom-cache.mjs` → **manipula** → `#canvas`
- `scripts/e2e-zoom-cache.mjs` → **manipula** → `.viewer-carga`
- `scripts/gen-thumbnails.mjs` → **escribe-global** → `__cs`
- `scripts/gen-thumbnails.mjs` → **importa** → `node:fs/promises`
- `scripts/gen-thumbnails.mjs` → **importa** → `node:http`
- `scripts/gen-thumbnails.mjs` → **importa** → `node:path`
- `scripts/gen-thumbnails.mjs` → **importa** → `puppeteer`
- `scripts/gen-thumbnails.mjs` → **lee-global** → `__cs`
- `scripts/gen-thumbnails.mjs` → **llama-api** → `fetch `http://localhost:/…``
- `scripts/gen-thumbnails.mjs` → **llama-api** → `fetch `/rest/v1/concept_thumbnails…``
- `scripts/perfil-gestos.mjs` → **importa** → `node:fs/promises`
- `scripts/perfil-gestos.mjs` → **importa** → `node:path`
- `scripts/perfil-gestos.mjs` → **importa** → `puppeteer`
- `scripts/perfil-gestos.mjs` → **manipula** → `.viewer-carga`
- `scripts/perfil-gestos.mjs` → **manipula** → `#canvas`
- `scripts/peso-recursos.mjs` → **importa** → `node:fs/promises`
- `scripts/peso-recursos.mjs` → **importa** → `node:path`
- `scripts/profile-heavy.mjs` → **importa** → `node:fs/promises`
- `scripts/profile-heavy.mjs` → **importa** → `node:http`
- `scripts/profile-heavy.mjs` → **importa** → `node:path`
- `scripts/profile-heavy.mjs` → **importa** → `puppeteer`
- `scripts/recorrido.mjs` → **importa** → `node:fs/promises`
- `scripts/recorrido.mjs` → **importa** → `node:path`
- `scripts/recorrido.mjs` → **importa** → `node:child_process`
- `scripts/recorrido.mjs` → **importa** → `puppeteer`
- `scripts/recorrido.mjs` → **lee-global** → `__viewerCajas`
- `scripts/recorrido.mjs` → **lee-global** → `__viewerCobertura`
- `scripts/recorrido.mjs` → **lee-global** → `__viewerFijarVista`
- `scripts/recorrido.mjs` → **lee-global** → `__viewerStats`
- `scripts/recorrido.mjs` → **lee-global** → `__viewerVista`
- `scripts/recorrido.mjs` → **lee-global** → `gc`
- `scripts/recorrido.mjs` → **manipula** → `#canvas`
- `scripts/recorrido.mjs` → **manipula** → `.viewer-carga`
- `scripts/recorrido.mjs` → **manipula** → `#[aria-label="Ver todo el dibujo"]`
- `scripts/recorrido.mjs` → **manipula** → `.btn-close-viewer`
- `scripts/resolve-url.mjs` → **importa** → `puppeteer`
- `scripts/run-suite.mjs` → **importa** → `node:child_process`
- `scripts/run-suite.mjs` → **importa** → `node:fs/promises`
- `scripts/run-suite.mjs` → **importa** → `node:path`
- `scripts/sentido-texto.mjs` → **importa** → `node:fs/promises`
- `scripts/sentido-texto.mjs` → **importa** → `node:path`
- `scripts/sentido-texto.mjs` → **importa** → `puppeteer`
- `scripts/servir-corpus.mjs` → **importa** → `node:fs`
- `scripts/servir-corpus.mjs` → **importa** → `node:fs/promises`
- `scripts/servir-corpus.mjs` → **importa** → `node:http`
- `scripts/servir-corpus.mjs` → **importa** → `node:path`
- `scripts/stats-corpus.mjs` → **importa** → `node:fs/promises`
- `scripts/stats-corpus.mjs` → **importa** → `node:http`
- `scripts/stats-corpus.mjs` → **importa** → `node:path`
- `scripts/stats-corpus.mjs` → **importa** → `puppeteer`
- `scripts/test-matrices.mjs` → **importa** → `node:fs/promises`
- `scripts/test-matrices.mjs` → **importa** → `node:path`
- `scripts/test-matrices.mjs` → **importa** → `puppeteer`
- `src/App.tsx` → **importa** → `react`
- `src/App.tsx` → **importa** → `motion/react`
- `src/App.tsx` → **importa** → `./Gallery/Gallery`
- `src/App.tsx` → **importa** → `./Gallery/NamePrompt`
- `src/App.tsx` → **importa** → `./Gallery/analytics`
- `src/App.tsx` → **importa** → `./Gallery/userIdentity`
- `src/App.tsx` → **importa** → `./Gallery/recientes`
- `src/App.tsx` → **importa** → `./Gallery/supabaseClient`
- `src/App.tsx` → **importa** → `./config`
- `src/App.tsx` → **importa** → `./device`
- `src/App.tsx` → **importa** → `./theme`
- `src/App.tsx` → **importa** → `./rutas`
- `src/Gallery/analytics.ts` → **importa** → `./supabaseClient`
- `src/Gallery/driveClient.ts` → **importa** → `../config`
- `src/Gallery/driveCrawler.ts` → **importa** → `./driveClient`
- `src/Gallery/driveCrawler.ts` → **importa** → `./supabaseClient`
- `src/Gallery/driveCrawler.ts` → **importa** → `./thumbnail`
- `src/Gallery/driveCrawler.ts` → **importa** → `../VisorConcept/parser`
- `src/Gallery/driveCrawler.ts` → **importa** → `../config`
- `src/Gallery/exportMetadata.ts` → **importa** → `./userIdentity`
- `src/Gallery/exportRender.ts` → **importa** → `../VisorConcept/parser`
- `src/Gallery/exportRender.ts` → **importa** → `../device`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-page`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-header`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-header h1`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-subtitle`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-header-actions`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-upload-btn,.gallery-drive-btn`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-upload-btn:hover,.gallery-drive-btn:hover`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-upload-btn:active,.gallery-drive-btn:active`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-icon-btn`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-icon-btn:hover:not(:disabled)`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-icon-btn:active:not(:disabled)`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-icon-btn:disabled`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-trail`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-crumb`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-sep`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-item`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-item:hover:not(:disabled)`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-breadcrumb-item.current`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-status`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-empty`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-error`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-grid`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-grid:last-child`
- `src/Gallery/Gallery.css` → **estila** → `.folder-card`
- `src/Gallery/Gallery.css` → **estila** → `.folder-thumb`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card:hover`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card:active`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card[aria-disabled="true"]`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card.opening`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card.selected`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-checkbox`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card:hover .gallery-checkbox,.gallery-card:focus-visible .gallery-checkbox,.gallery-checkbox.checked`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-checkbox.checked`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-thumb`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-thumb img`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-thumb-error`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-thumb-overlay`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-thumb-progress`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-name`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-date`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-card-error`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-actions`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-btn`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-btn:hover`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-btn:active`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-btn.primary`
- `src/Gallery/Gallery.css` → **estila** → `.gallery-toolbar-btn.primary:hover`
- `src/Gallery/Gallery.tsx` → **importa** → `react`
- `src/Gallery/Gallery.tsx` → **importa** → `motion/react`
- `src/Gallery/Gallery.tsx` → **importa** → `./driveClient`
- `src/Gallery/Gallery.tsx` → **importa** → `./supabaseClient`
- `src/Gallery/Gallery.tsx` → **importa** → `./thumbnail`
- `src/Gallery/Gallery.tsx` → **importa** → `./exportRender`
- `src/Gallery/Gallery.tsx` → **importa** → `./exportMetadata`
- `src/Gallery/Gallery.tsx` → **importa** → `./analytics`
- `src/Gallery/Gallery.tsx` → **importa** → `../VisorConcept/parser`
- `src/Gallery/Gallery.tsx` → **importa** → `../config`
- `src/Gallery/Gallery.tsx` → **importa** → `../rutas`
- `src/Gallery/Gallery.tsx` → **importa** → `../theme`
- `src/Gallery/Gallery.tsx` → **importa** → `./recientes`
- `src/Gallery/Gallery.tsx` → **importa** → `./rasterCache`
- `src/Gallery/NamePrompt.tsx` → **importa** → `react`
- `src/Gallery/NamePrompt.tsx` → **importa** → `motion/react`
- `src/Gallery/raster.worker.ts` → **importa** → `pdfjs-dist`
- `src/Gallery/rasterCache.ts` → **importa** → `../device`
- `src/Gallery/renderCore.ts` → **importa** → `../VisorConcept/parser`
- `src/Gallery/renderCore.ts` → **importa** → `../device`
- `src/Gallery/renderCore.ts` → **importa** → `./rasterCache`
- `src/Gallery/supabaseClient.ts` → **importa** → `../config`
- `src/Gallery/supabaseClient.ts` → **importa** → `./driveClient`
- `src/Gallery/thumbnail.ts` → **importa** → `../VisorConcept/parser`
- `src/Gallery/thumbnail.ts` → **importa** → `../VisorConcept/zip`
- `src/Gallery/thumbnail.ts` → **importa** → `../config`
- `src/Gallery/thumbnail.ts` → **importa** → `./renderCore`
- `src/index.css` → **estila** → `:root`
- `src/index.css` → **estila** → `:root[data-theme="claro"]`
- `src/index.css` → **estila** → `body`
- `src/index.css` → **estila** → `#root`
- `src/index.css` → **estila** → `.viewer-hero`
- `src/main.tsx` → **importa** → `react`
- `src/main.tsx` → **importa** → `react-dom/client`
- `src/main.tsx` → **importa** → `src/App.tsx`
- `src/VisorConcept/App.css` → **estila** → `*`
- `src/VisorConcept/App.css` → **estila** → `body`
- `src/VisorConcept/App.css` → **estila** → `.app-container`
- `src/VisorConcept/App.css` → **estila** → `.filename-display`
- `src/VisorConcept/App.css` → **estila** → `.btn-close-viewer`
- `src/VisorConcept/App.css` → **estila** → `.btn-close-viewer:hover`
- `src/VisorConcept/App.css` → **estila** → `.floating-tools`
- `src/VisorConcept/App.css` → **estila** → `.btn-tool`
- `src/VisorConcept/App.css` → **estila** → `.btn-tool:hover`
- `src/VisorConcept/App.css` → **estila** → `.active-glow`
- `src/VisorConcept/App.css` → **estila** → `.dropdown-container`
- `src/VisorConcept/App.css` → **estila** → `.dropdown-menu`
- `src/VisorConcept/App.css` → **estila** → `.layer-menu-header`
- `src/VisorConcept/App.css` → **estila** → `.btn-tiny`
- `src/VisorConcept/App.css` → **estila** → `.btn-tiny:hover`
- `src/VisorConcept/App.css` → **estila** → `.layer-item`
- `src/VisorConcept/App.css` → **estila** → `.layer-item:hover`
- `src/VisorConcept/App.css` → **estila** → `.layer-item.isolated`
- `src/VisorConcept/App.css` → **estila** → `.layer-name`
- `src/VisorConcept/App.css` → **estila** → `.layer-info`
- `src/VisorConcept/App.css` → **estila** → `.layer-actions`
- `src/VisorConcept/App.css` → **estila** → `.opacity-slider`
- `src/VisorConcept/App.css` → **estila** → `.icon-btn`
- `src/VisorConcept/App.css` → **estila** → `.icon-btn:hover`
- `src/VisorConcept/App.css` → **estila** → `.active-icon`
- `src/VisorConcept/App.css` → **estila** → `.image-gallery`
- `src/VisorConcept/App.css` → **estila** → `.gallery-item`
- `src/VisorConcept/App.css` → **estila** → `.gallery-item:active`
- `src/VisorConcept/App.css` → **estila** → `.gallery-item img`
- `src/VisorConcept/App.css` → **estila** → `.gallery-item:hover`
- `src/VisorConcept/App.css` → **estila** → `.pdf-thumbnail`
- `src/VisorConcept/App.css` → **estila** → `.main-content`
- `src/VisorConcept/App.css` → **estila** → `.canvas-wrapper`
- `src/VisorConcept/App.css` → **estila** → `.empty-state`
- `src/VisorConcept/App.css` → **estila** → `.viewer-placeholder`
- `src/VisorConcept/App.css` → **estila** → `.viewer-placeholder-overlay`
- `src/VisorConcept/App.css` → **estila** → `.viewer-placeholder-img`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-cabecera`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-fase`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-detalle`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-pct`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-riel`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-relleno`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-riel.indeterminada .viewer-carga-relleno`
- `src/VisorConcept/App.css` → **estila** → `.viewer-carga-pie`
- `src/VisorConcept/App.css` → **estila** → `.viewer-loading-badge`
- `src/VisorConcept/App.css` → **estila** → `.viewer-loading-dot`
- `src/VisorConcept/App.css` → **estila** → `.error-state`
- `src/VisorConcept/App.css` → **estila** → `.fullscreen-preview`
- `src/VisorConcept/App.tsx` → **importa** → `react`
- `src/VisorConcept/App.tsx` → **importa** → `./parser`
- `src/VisorConcept/App.tsx` → **importa** → `./progreso`
- `src/VisorConcept/App.tsx` → **importa** → `./Viewer`
- `src/VisorConcept/App.tsx` → **importa** → `./InteractivePreview`
- `src/VisorConcept/App.tsx` → **importa** → `../Gallery/analytics`
- `src/VisorConcept/App.tsx` → **importa** → `../Gallery/driveClient`
- `src/VisorConcept/App.tsx` → **importa** → `../App`
- `src/VisorConcept/App.tsx` → **importa** → `lucide-react`
- `src/VisorConcept/index.tsx` → **importa** → `react`
- `src/VisorConcept/index.tsx` → **importa** → `react-dom/client`
- `src/VisorConcept/index.tsx` → **importa** → `./App`
- `src/VisorConcept/index.tsx` → **importa** → `../App`
- `src/VisorConcept/InteractivePreview.tsx` → **importa** → `react`
- `src/VisorConcept/InteractivePreview.tsx` → **importa** → `lucide-react`
- `src/VisorConcept/InteractivePreview.tsx` → **importa** → `../Gallery/analytics`
- `src/VisorConcept/InteractivePreview.tsx` → **importa** → `../Gallery/renderCore`
- `src/VisorConcept/parser.ts` → **importa** → `@msgpack/msgpack`
- `src/VisorConcept/parser.ts` → **importa** → `./zip`
- `src/VisorConcept/Viewer.tsx` → **importa** → `react`
- `src/VisorConcept/Viewer.tsx` → **importa** → `./parser`
- `src/VisorConcept/Viewer.tsx` → **importa** → `../Gallery/renderCore`
- `src/VisorConcept/Viewer.tsx` → **importa** → `../device`
- `src/VisorConcept/Viewer.tsx` → **importa** → `../theme`
- `test-msgpack.ts` → **importa** → `fs`
- `test-msgpack.ts` → **importa** → `jszip`
- `test-msgpack.ts` → **importa** → `@msgpack/msgpack`
- `test-zip.ts` → **importa** → `fs`
- `test-zip.ts` → **importa** → `jszip`
- `vite.config.ts` → **importa** → `vite`
- `vite.config.ts` → **importa** → `@vitejs/plugin-react`

## 6. APIs y endpoints

**Llamadas a APIs desde el cliente:**
- `fetch `/concepts-drive?action=list&folderId=…`` — scripts/crawl-drive.mjs:47
- `fetch `/concepts-drive?action=download&fileId=…`` — scripts/crawl-drive.mjs:60
- `fetch `http://localhost:/…`` — scripts/gen-thumbnails.mjs:92
- `fetch `/rest/v1/concept_thumbnails…`` — scripts/gen-thumbnails.mjs:148

## 7. Eventos y DOM

**IDs/selectores manipulados por JS (✓ = el id existe en algún HTML analizado):**
- `.folder-card` ⚠ no encontrado en HTML
- `.gallery-card:not(.folder-card)` ⚠ no encontrado en HTML
- `.gallery-thumb img` ⚠ no encontrado en HTML
- `#canvas` ⚠ no encontrado en HTML
- `.viewer-carga` ⚠ no encontrado en HTML
- `#[aria-label="Ver todo el dibujo"]` ⚠ no encontrado en HTML
- `#button` ⚠ no encontrado en HTML
- `.gallery-item` ⚠ no encontrado en HTML
- `.folder-card .gallery-name` ⚠ no encontrado en HTML
- `.gallery-name` ⚠ no encontrado en HTML
- `.gallery-card.skeleton` ⚠ no encontrado en HTML
- `.gallery-status` ⚠ no encontrado en HTML
- `.gallery-grid:not(.gallery-folders-grid) .gallery-card` ⚠ no encontrado en HTML
- `.gallery-checkbox` ⚠ no encontrado en HTML
- `.gallery-toolbar-btn` ⚠ no encontrado en HTML
- `.gallery-modal-option` ⚠ no encontrado en HTML
- `.dropdown-menu` ⚠ no encontrado en HTML
- `.gallery-reset-btn` ⚠ no encontrado en HTML
- `.viewer-carga-fase` ⚠ no encontrado en HTML
- `.viewer-carga-pct` ⚠ no encontrado en HTML
- `.viewer-carga-pie` ⚠ no encontrado en HTML
- `.viewer-carga-relleno` ⚠ no encontrado en HTML
- `#button[title="Ver todo el dibujo"]` ⚠ no encontrado en HTML
- `.gallery-reciente` ⚠ no encontrado en HTML
- `.gallery-reciente-nombre` ⚠ no encontrado en HTML
- `.gallery-reciente-ruta` ⚠ no encontrado en HTML
- `.gallery-breadcrumb-item` ⚠ no encontrado en HTML
- `#img` ⚠ no encontrado en HTML
- `.gallery-thumb-error` ⚠ no encontrado en HTML
- `.filename-display` ⚠ no encontrado en HTML
- `.viewer-refinando` ⚠ no encontrado en HTML
- `.canvas-wrapper canvas` ⚠ no encontrado en HTML
- `.btn-close-viewer` ⚠ no encontrado en HTML

## 8. Dependencias

**Dependencies:**
- @fontsource-variable/inter: ^5.3.0
- @msgpack/msgpack: ^3.1.3
- jspdf: ^4.2.1
- jszip: ^3.10.1
- lucide-react: ^1.31.0
- motion: ^13.1.0
- pdfjs-dist: ^6.2.108
- puppeteer: ^25.5.0
- react: ^19.2.8
- react-dom: ^19.2.8

**DevDependencies:**
- @types/node: ^24.13.3
- @types/react: ^19.2.17
- @types/react-dom: ^19.2.3
- @vitejs/plugin-react: ^6.0.4
- oxlint: ^1.75.0
- typescript: ~6.0.2
- vite: ^8.2.0

## 9. Vendor / excluido del parseo

_No se detectó código vendor._
