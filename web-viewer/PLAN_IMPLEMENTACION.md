# Plan de implementación — Performance, UI/UX y corrección de bugs

**Objetivo primario:** que en un teléfono de gama baja el usuario nunca vea contenido a medio cargar. Todo carga oculto y aparece completo.
**Objetivo secundario:** que la app no muera por OOM ni se degrade silenciosamente durante la sesión.

Fecha: 2026-08-21 · Base: `git HEAD b7537dd`

---

## 0. Aclaración de premisa: no es WebGL

El visor **no usa WebGL**. Es **Canvas2D puro en el hilo principal**, un solo `<canvas>` por visor, contexto creado con `alpha: false` y cacheado en un `WeakMap` (`src/VisorConcept/Viewer.tsx:2822-2830`). No hay `OffscreenCanvas` para el lienzo ni worker de render.

Los únicos workers del proyecto son el pool de rasterizado de PDFs/fotos (`src/Gallery/renderCore.ts:211-309` → `src/Gallery/raster.worker.ts`), que corre pdf.js sobre `OffscreenCanvas` y devuelve `ImageBitmap`.

Esto importa porque cambia el diagnóstico: en gama baja el problema **no** es la GPU ni el pipeline de shaders, es que el hilo principal se bloquea (msgpack síncrono, `getImageData`, `toDataURL`) y que la RAM se agota (~200 MB en objetos `Point`, canvases sin liberar, workers que nunca se cierran). El único punto donde sí aparece un límite tipo GPU es `MAX_CANVAS_SIDE = 16384` (§3.4), que en móviles reales es 4096–8192.

**No se recomienda migrar a WebGL.** El trabajo por frame ya está bien acotado (culling por bbox, `Path2D` con LOD, rAF auto-apagable). Migrar el render a WebGL sería un rewrite de `Viewer.tsx` (132 KB) sin atacar ninguna de las causas reales medidas.

---

## 1. Principio rector: "carga oculta, revelado atómico"

Hoy la arquitectura es **revelado progresivo**: cada recurso que llega se publica y pide un repintado inmediato (`Viewer.tsx:1405`, `Viewer.tsx:1439`). El usuario ve N estados intermedios.

La regla nueva, que gobierna todas las decisiones de las fases 2 y 5:

> Ninguna superficie del lienzo ni de la galería cambia de estado hasta que el contenido que la cubre esté **completo y decodificado**. La transición es un único `opacity` sobre una capa ya pintada, nunca una aparición pieza por pieza.

Ya existe la métrica exacta para implementarlo, hoy solo expuesta para tests: `window.__viewerCobertura()` (`Viewer.tsx:2426-2465`) devuelve `{ visibles, visiblesConBitmap, faltantes }`. Esa función pasa de ser un helper de test a ser **la condición de revelado del producto**.

---

## 2. Fase 0 — Red de seguridad (hacer primero, no tocar código todavía)

El proyecto ya tiene ~100 scripts de verificación en `scripts/`. Antes de cambiar nada hay que tener la línea base, o no se va a poder distinguir una mejora de una regresión.

| Paso | Comando | Qué congela |
|---|---|---|
| 0.1 | `node scripts/bench-lowend.mjs` | fps, frame times y pico de RAM en gama baja |
| 0.2 | `node scripts/bench-arranque.mjs` | tiempo hasta primer contenido útil |
| 0.3 | `node scripts/bench-produccion-completo.mjs` | peor caso (262,9 MB, 96 PDFs) con CPU y red throttleadas |
| 0.4 | `node scripts/test-corpus.mjs` | 176 archivos, 141.287 trazos — **red de seguridad de geometría** |
| 0.5 | `node scripts/e2e-gama-baja.mjs` | flujo completo |

**Guardar la salida en `_baseline/` con fecha.** `test-corpus.mjs` es innegociable: el plan de paridad (`APK/PLAN_PARIDAD_VISOR.md`) costó una investigación de ingeniería inversa completa, y varias optimizaciones de la fase 3 tocan estructuras de datos de geometría.

**Añadir dos métricas nuevas al arsenal**, porque el objetivo del usuario hoy no es medible:

- **0.6 — `scripts/bench-negro.mjs`**: abrir un dibujo con la CPU throttleada, capturar un screenshot cada 100 ms durante 40 s, y contar el **porcentaje de píxeles cercanos al color de fondo** (`#14161c`, `theme.ts:54`) dentro del área del lienzo. La métrica objetivo es: *ningún frame entre el tap y el revelado supera el 5 % de píxeles de fondo descubiertos*. Sin esto, "no se ve negro" es una opinión.
- **0.7 — CLS real**: `PerformanceObserver` sobre `layout-shift` durante el arranque de la galería, porque hoy hay tres saltos de layout encadenados (§5.2).

---

## 3. Fase 1 — Estabilidad: que la pestaña no muera

**Prioridad máxima.** Estos cuatro puntos no degradan la experiencia: la terminan. En un teléfono de 1 GB, Chrome mata la pestaña entre 300 y 450 MB (documentado en `src/device.ts:10-12`).

### 3.1 Techo de tamaño antes de materializar un archivo entero — 🔴 crítico

Hay **dos caminos** que intentan cargar el `.concepts` completo en RAM. Con archivos de hasta 262 MB en la carpeta real, cualquiera de los dos mata la pestaña sin mensaje.

**Camino A — `zip.ts:453`** (`readIndexEscaneando`):
```js
const bytes = await this.source.read(0, this.source.size);
```
Se dispara cuando no se encuentra el EOCD (`zip.ts:341-346`) o el directorio central quedó vacío (`zip.ts:438`) — o sea, con un archivo truncado por una sincronización interrumpida de Concepts, caso que el propio código dice que existe (`zip.ts:443-445`). No hay ningún límite de tamaño.

Peor: el escaneo del data descriptor (`zip.ts:476-482`) avanza **byte a byte** (`q++`) con `getUint32`, en el hilo principal. Son cientos de millones de iteraciones con la UI congelada **antes** de llegar al OOM.

**Camino B — `zip.ts:216-221`**: si el servidor responde 200 en vez de 206, el código **guarda el archivo entero** en `bloques`. Y `podarBloques` (`zip.ts:274`) tiene la guarda `this.bloques.length > 1`, así que **un bloque único gigante nunca se poda**. Esto ocurre de verdad: el proxy fuerza `status: upstream.status === 206 ? 206 : 200` (`supabase/functions/concepts-drive/index.ts:352`), y el CDN de Supabase puede servir desde caché una respuesta previa sin `Range` (`Cache-Control: public, max-age=3600`, `index.ts:332`).

**Implementación:**
1. Añadir en `zip.ts` una constante derivada del tier: `MAX_BYTES_MATERIALIZABLES` = `getBudgets().maxBufferCacheBytes * 2` (en gama baja, ~24 MB).
2. En `readIndexEscaneando`, si `source.size > MAX_BYTES_MATERIALIZABLES` **y** la fuente es `RemoteSource`, lanzar un error tipado `ArchivoDemasiadoGrandeParaReparar` en vez de intentar el escaneo.
3. En la rama de 200-no-206, **abortar** con un error tipado en vez de guardar todo. Reintentar una vez con `Cache-Control: no-cache` para saltear el CDN, y solo entonces fallar.
4. Cambiar la guarda de `podarBloques` para que un bloque único mayor al presupuesto **también** se pueda podar.
5. Convertir el escaneo byte a byte en un escaneo por chunks con `yield` al event loop cada N KB, para los casos donde sí se permita.
6. En la UI, esos errores tipados producen un mensaje concreto ("Este dibujo está dañado o incompleto en Drive"), no una pestaña muerta.

**Aceptación:** abrir un `.concepts` truncado de 262 MB en gama baja muestra un error legible en menos de 2 s, sin superar los 60 MB de heap.

### 3.2 Timeout en todos los `fetch` del cliente — 🔴 crítico

Ningún `fetch` del cliente tiene timeout: `driveClient.ts:41-44`, `driveClient.ts:98-101`, `supabaseClient.ts:27`, `zip.ts:186-189`. El único `AbortSignal.timeout` del cliente está en `exportMetadata.ts:21`.

Esto es más grave de lo que parece: en una red móvil que entra en un túnel, el TCP queda colgado sin RST y `fetch` **nunca resuelve ni rechaza**. En `driveClient.ts:39-53` el `try` nunca llega al `catch`, así que **la lógica de reintentos que ya está escrita jamás se ejecuta**. La galería se queda con el spinner de `listLoading` para siempre, y `handleRefresh` queda bloqueado por la guarda de `Gallery.tsx:387`.

**Implementación:** un helper `fetchConTimeout(url, opts, ms)` que componga `AbortSignal.any([signalDelLlamador, AbortSignal.timeout(ms)])`. Timeouts sugeridos: 8 s para listados, 15 s para rangos de datos, 20 s para el primer byte de una descarga. Aplicarlo en los cuatro sitios.

**Aceptación:** con la red cortada a mitad de un listado, la galería muestra el error y el botón de refrescar vuelve a estar disponible en menos de 10 s.

### 3.3 `Point[]` como objetos JS → typed arrays — 🔴 el mayor consumidor de RAM

`parser.ts:995`:
```js
stroke.points.push({ x, y, p, t1, t2 });
```

El corpus tiene 32.085 trazos (`parser.ts:308`). Con ~100 puntos por trazo son ~3 millones de objetos de 5 campos. En V8 cada uno cuesta ~56–72 bytes con header → **~200 MB retenidos** mientras el documento esté abierto, y se retienen enteros porque `Document.layers` vive toda la sesión del visor.

Eso explica por sí solo el grueso del pico de 316 MB que documenta `device.ts:10-12`, y es exactamente el rango donde Android mata la pestaña.

**Lo importante: los datos ya vienen en un `Uint8Array` con stride de 16 bytes** (`parser.ts:982-993`). Se están desempaquetando a objetos para volver a empaquetarlos en `Path2D`.

**Implementación:**
1. Reemplazar `Point[]` por un `Float32Array` de coordenadas (`x, y` intercalados) más un `Uint16Array` de presión/tilt cuando se usen. Un trazo pasa a ser `{ xy: Float32Array, extra: Uint16Array, n: number }`.
2. Mantener un accessor `puntoEn(trazo, i)` para el código que hoy itera objetos, migrando los consumidores de a uno.
3. `buildPath` (`Viewer.tsx:288-308`) pasa a leer del `Float32Array` directamente — es su patrón natural.

**Ganancia esperada:** ~200 MB → ~48 MB (4×), y se eliminan 3 millones de allocaciones que hoy disparan GC durante la apertura.

**Riesgo:** toca geometría. `test-corpus.mjs` (paso 0.4) tiene que pasar con **exactamente** los mismos números: 176 archivos, 0 fallos, 141.287 trazos, 2.368 imágenes.

### 3.4 `MAX_CANVAS_SIDE = 16384` es irreal en móviles — 🔴 produce bitmaps en blanco

`renderCore.ts:21`, usado en `clampTarget` (`renderCore.ts:477-482`) y `safeExportScale` (`renderCore.ts:34`). El límite real en muchas GPU Android y iOS antiguas es **4096**, y 8192 en buena parte del resto. **Pasarse no tira error: el bitmap sale en blanco.**

Caso reproducible: un dispositivo clasificado como gama "alta" (`deviceMemory > 4 && cores >= 8`, hoy común en gama media real, `device.ts:62`) obtiene `maxPixelsPerResource = 8M`; en hot son ×4 = 32M, acotado a `(120M × 0.75) / 3 = 30M` (`Viewer.tsx:1324-1328`). Un plano en tira 1:4,7 a 30 Mpx da **2526 × 11873 px**, que pasa el clamp de 16384 sin tocarse y **falla en cualquier dispositivo con techo 8192**.

También `LADO_MAXIMO_OBJETIVO = 8000` en `obtenerImagenCompleta` (`Viewer.tsx:883`) supera 4096.

**Implementación:** mover `MAX_CANVAS_SIDE` a `device.ts` como presupuesto por tier — 4096 en baja, 8192 en media, 16384 solo en escritorio — y **verificarlo en runtime** una sola vez al arrancar: crear un canvas de prueba del tamaño candidato, pintar un píxel, leerlo con `getImageData` y bajar el techo si volvió vacío. Cachear el resultado. Es la única forma fiable, porque `MAX_TEXTURE_SIZE` de WebGL no siempre coincide con el techo de Canvas2D.

---

## 4. Fase 2 — Cero negro (el objetivo principal)

Aquí está el corazón del pedido. Son ocho puntos, ordenados por cuánto negro elimina cada uno.

### 4.1 La vista previa se retira con **un solo** recurso cargado — 🔴 el peor de todos

`src/VisorConcept/App.tsx:728`:
```js
placeholder && doc.resourceIds.length > 0 && !recursosListos && !previaDescartada
  && !(progresoRecursos && progresoRecursos.listos > 0)
```

`progresoRecursos.listos` se incrementa en el **primer** `onEach` (`Viewer.tsx:1436-1438` → `App.tsx:489-501`). Traducido: llega 1 plano de 19 → **se quita el overlay que tapaba todo** → el usuario mira 1 plano real y **18 rectángulos negros** durante los ~28 s restantes.

Es literalmente lo contrario del objetivo.

**Implementación:**
1. Cambiar la condición de `listos > 0` a **cobertura completa del viewport**, usando `__viewerCobertura()` (`Viewer.tsx:2426-2465`): el overlay se retira cuando `visiblesConBitmap === visibles`.
2. Promover esa función de helper de test a API interna estable: `viewerRef.current.cobertura()`, publicada por el `useImperativeHandle` que ya existe.
3. Emitir un evento `onCoberturaCambio` desde el render loop (`Viewer.tsx:2166-2174`, donde ya se detectan los frames limpios) para que `App.tsx` no tenga que hacer polling.
4. Añadir un **techo de espera** (12 s sugerido): si algún recurso falla o tarda demasiado, revelar igual pero con el aviso de planos faltantes que ya existe (`App.tsx:723-727`). Nunca dejar al usuario mirando una preview congelada para siempre.

### 4.2 El primer gesto destapa el lienzo a medio cargar, para siempre — 🔴

`marcarGesto` llama `onPrimerGestoRef.current?.()` en el **primer movimiento** (`Viewer.tsx:1862-1865`) → `setPreviaDescartada(true)` (`App.tsx:515`) → la condición de `App.tsx:728` queda en `false` de forma permanente.

Un toque accidental al 3 % de carga deja el lienzo negro descubierto el resto de la apertura.

**Implementación:** eliminar el descarte por gesto. La preview se retira **solo** por cobertura completa o por el techo de tiempo (§4.1). Si se quiere conservar un escape manual, que sea un botón explícito ("Ver ahora") dentro del overlay, no un side-effect de tocar la pantalla.

Complemento: mientras el overlay está puesto, los gestos deberían **acumularse sobre la preview** (que es una imagen estática, es barato) en vez de sobre el lienzo, para que la app siga sintiéndose viva sin destapar nada.

### 4.3 Flash negro de ~300 ms en cada apertura — 🔴

Secuencia real al abrir un dibujo:

1. `App.tsx:588-604`: mientras `!doc`, se muestra `.viewer-placeholder` con un `<img>` del thumb.
2. Llega `doc` → React remonta: el árbol pasa a `<Viewer>` más un `<img>` **distinto** dentro de `.viewer-placeholder-overlay` (`App.tsx:729-731`).
3. Ese overlay tiene `animation: fadeIn 0.3s ease-out both` (`App.css:299`) → **entra desde opacidad 0**.
4. El canvas recién montado no tiene `width`/`height` (solo se asignan dentro del render, `Viewer.tsx:1913-1923`) y el primer `render()` corre en el rAF siguiente.

Resultado: una ventana de ~300 ms de fondo `#14161c` puro. **Un parpadeo a negro en cada apertura.**

**Implementación:**
1. Que sea **el mismo elemento `<img>`** el que persiste entre los dos estados: subir el `<img>` de la preview por encima del punto donde React reemplaza el subárbol, con una `key` estable, de modo que no se desmonte ni se remonte.
2. Quitar el `fadeIn` de entrada del overlay (`App.css:299`). El overlay ya está visible; solo debe tener `fadeOut` de salida.
3. Pintar el primer frame del canvas **antes** de que sea visible: asignar `width`/`height` y hacer el primer `render()` de forma síncrona en un `useLayoutEffect`, no esperar al rAF.

### 4.4 El placeholder de recurso es negro sobre negro — 🟠

`dibujarHueco` (`Viewer.tsx:2668-2738`, invocado en `Viewer.tsx:2054`) rellena con `huecoRelleno #1b1f28` a **alpha 0.35** (`Viewer.tsx:2700-2702`) sobre un fondo `#14161c` (`theme.ts:54`): el contraste efectivo es prácticamente nulo. Debajo de 16 px de lado ni siquiera dibuja caja, solo un punto (`Viewer.tsx:2687-2695`).

Aun con §4.1 y §4.2 resueltos, los huecos siguen apareciendo al panear fuera del anillo (§4.6), así que hay que arreglarlos igual.

**Implementación, en orden de preferencia:**
1. **Lo mejor:** pintar dentro de cada hueco **el recorte correspondiente de la vista previa embebida** del `.concepts`. La preview ya está decodificada y en memoria (`App.tsx:729`), y la transformación de mundo a pantalla ya está calculada para el bbox del recurso (`Viewer.tsx:578-594`). El usuario ve el plano correcto en baja resolución en lugar de un agujero, y cuando llega el bitmap real la sustitución es un refinamiento, no una aparición.
2. Si (1) resulta caro: subir el alpha a ~0.9 y usar un color claramente distinguible del fondo, más una animación de shimmer sutil que comunique "esto está viniendo".

### 4.5 Bandas negras en zoom-out: bug geométrico — 🟠

`MARGEN_LIENZO = 0.25` (`Viewer.tsx:186`) hace que el canvas cubra `[-0.25W, 1.25W]`, longitud `1.5W`.
`UMBRAL_REANCLAJE_ZOOM = 1.4` (`Viewer.tsx:205`) permite que `k` baje hasta `1/1.4 = 0.714`.
Longitud efectiva tras el transform: `1.5W × 0.714 = 1.071W`.

**Solo 7 % de holgura total**, repartida según dónde esté el ancla del pinch (`dx = panX - s.panX * k`, `Viewer.tsx:1795`). Con un pinch anclado fuera del centro, **una franja del borde queda descubierta** mostrando `.canvas-wrapper` (negro, `App.css:266`) hasta que llegue el redibujo.

El umbral de paneo sí está derivado del margen (`UMBRAL_REANCLAJE = MARGEN_LIENZO * 0.8`, `Viewer.tsx:201`), pero el de zoom está hardcodeado y es **inconsistente** con él.

**Implementación:** derivarlo igual que el de paneo. Para que sea seguro debe cumplir `k_min × 1.5 ≥ 1`, o sea `UMBRAL_REANCLAJE_ZOOM ≤ 1.5`, y con el mismo factor de seguridad 0.8 que usa el paneo queda **≈ 1.2**. Escribirlo como constante derivada, no como número suelto, para que no se vuelvan a desincronizar:
```js
const UMBRAL_REANCLAJE_ZOOM = (1 + MARGEN_LIENZO * 2) * 0.8; // 1.2 con margen 0.25
```

### 4.6 Franja negra en flicks rápidos y paneo fuera del anillo — 🟠

**Flick:** `marcarGesto` compara el desplazamiento **después** de que ya ocurrió (`Viewer.tsx:1850-1858`). Si entre dos `touchmove` el dedo recorre más del 25 % del viewport (trivial en un flick con eventos dropeados en gama baja), el transform ya destapó el borde y el redibujo llega en el rAF siguiente (16–80 ms).

**Fuera del anillo:** `MARGEN_ANILLO = 0.6` (`Viewer.tsx:139`). Un paneo mayor a 0,6 viewports llega a recursos sin bitmap, y la cadena hasta que aparezcan es `DEBOUNCE_SINCRONIZAR = 220 ms` (`Viewer.tsx:209`) + espera de slot + red + rasterizado pdf.js (~9 s en gama baja, `raster.worker.ts:6-7`). **Varios segundos de rectángulo negro.**

**Implementación:**
1. **Predicción de velocidad:** en vez de reaccionar al desplazamiento ya ocurrido, estimar la velocidad del dedo en cada `touchmove` y forzar el reanclaje **antes** de que el transform llegue al borde del margen.
2. Con §4.4 (1) resuelto, el paneo fuera del anillo muestra la preview recortada en lugar de negro, que es la mitigación correcta: no se puede rasterizar un PDF en menos de 9 s, pero sí se puede no mostrar un agujero.
3. Considerar subir `MARGEN_ANILLO` en gama alta, donde la RAM lo permite. En gama baja no: agravaría el problema de memoria.

### 4.7 Recursos visibles que desaparecen — 🟠 dos bugs de desalojo

**Bug A:** `recursosVisibles` descarta todo lo que mida menos de `LADO_MINIMO_PX = 24 px` (`Viewer.tsx:219`, filtro en `Viewer.tsx:1142-1143`), y `desalojarLejanos(cercanos)` protege **solo** lo que devuelve esa función (`Viewer.tsx:1659`, `Viewer.tsx:1223`). Un plano que está **en pantalla** pero mide menos de 24 px no está protegido y puede ser desalojado por LRU (`Viewer.tsx:1233-1243`). Al alejarse, planos que se veían se convierten en huecos. Es el síntoma "se pierden las imágenes al hacer zoom out", en una variante que los arreglos anteriores no cubrieron.

**Bug B:** `visibleItem` filtra dentro de `recursosVisibles` (`Viewer.tsx:1130`). Ocultar una capa saca sus recursos de `cercanos` → se desalojan → **volver a mostrarla exige recargar y re-rasterizar todo**, con huecos negros mientras tanto.

**Implementación:** separar dos conceptos que hoy están fusionados en una sola función:
- `recursosARasterizar()` — sigue filtrando por tamaño mínimo y visibilidad de capa (correcto: no tiene sentido rasterizar lo invisible).
- `recursosAProteger()` — todo lo que intersecta el viewport **sin filtro de tamaño**, más todo lo de capas ocultas que ya tenga bitmap (protegido con menor prioridad que lo visible, pero protegido).

`desalojarLejanos` pasa a consumir `recursosAProteger()`.

### 4.8 `onResourcesReady` miente — 🟠

`Viewer.tsx:1756-1758`: se dispara al terminar **el primer** `sincronizarRecursos`, que solo carga `cercanos`. Todo lo que está fuera del anillo sigue vacío y la app ya declara "listo" (`App.tsx:483-486` → fase `listo` → `BarraCarga` devuelve `null`, `App.tsx:28`).

**Implementación:** renombrar a `onPrimerLoteListo` y hacer que la fase `listo` de la barra de carga se dispare por la misma cobertura de §4.1. Una app que dice "listo" mientras hay agujeros negros en pantalla es peor que una que sigue mostrando progreso.

---

## 5. Fase 3 — Cero negro en la galería

La galería tiene su propia versión del mismo problema, más tres saltos de layout encadenados.

### 5.1 El CSS del spinner no está en el bundle inicial — 🔴 arreglo de 5 minutos

`src/App.tsx:252-259` (fallback de `Suspense`) usa `.app-container`, `.empty-state` y `.spin-slow`. Las tres están definidas en `src/VisorConcept/App.css` (`:23`, `:269`, `:464`), que **solo se importa desde `VisorConcept/App.tsx:13`** — o sea, viaja en el chunk lazy que ese fallback está esperando.

Verificado contra el build:
```
dist/assets/index-C8arHb6Z.css        → 0 ocurrencias de "spin-slow"
dist/assets/VisorConcept-DSETmntT.css → 1 ocurrencia
```

**Consecuencia doble:**
- Mientras baja el chunk del visor (justo cuando se ve el fallback), el usuario ve el texto pelado "Cargando visor…" arriba a la izquierda sobre el fondo oscuro. Es exactamente la pantalla a medio cargar que se quiere eliminar.
- En la galería, `spin-slow` se usa en `Gallery.tsx:652`, `:658`, `:786` y `:935`: el spinner de "Generando miniaturas", el del botón Actualizar, el de la tarjeta procesando y el del modal de descarga son **iconos congelados** hasta que el usuario abra un dibujo por primera vez.

**Implementación:** mover `.spin-slow`, `@keyframes spin`, `.app-container` y `.empty-state` a `src/index.css`. Es el mejor retorno por esfuerzo de todo el plan.

### 5.2 Tres saltos de layout encadenados (CLS) — 🟠

**Salto 1 — skeleton de HTML → React.** El skeleton estático de `index.html:80-93` es una gran idea, pero no coincide con la grilla real:

| | Boot (`index.html`) | Real (`Gallery.css`) |
|---|---|---|
| Columnas | `minmax(159px, 1fr)` (`:48`) | `minmax(150px, 1fr)` (`:189`) |
| Padding tarjeta | `.75rem` (`:55`) | `.6rem` (`:212`) |
| Radio | `12px` (`:53`) | `10px` (`:211`) |
| Fuente | `system-ui` (`:40`) | `Inter Variable` (`Gallery.css:6`) |
| Título | `1.6rem` (`:44`) | `1.5rem` (`Gallery.css:21`) |
| Ausentes | — | header-actions, breadcrumb, recientes |

Al montar React cambia el número de columnas, la altura de cada tarjeta, la tipografía (FOUT por `font-display: swap`) y aparecen ~120 px de UI nueva encima de la grilla. Encima, `Gallery.css:8` hace un `fadeIn 0.15s` que **cross-fadea** los dos estados desalineados.

**Salto 2 — skeleton de React → contenido.** `Gallery.tsx:696-704` renderiza siempre **6 tarjetas fijas** sin importar si la carpeta tiene 3 o 60, y **no incluye la fila de fecha** (`.gallery-date`, `Gallery.tsx:791-793`), así que cada tarjeta real crece ~11 px. La grilla de carpetas (`Gallery.tsx:707-743`) aparece encima y empuja todo hacia abajo.

**Salto 3 — barras que aparecen y desaparecen.** `.gallery-status` ("Generando miniaturas: X de Y", `Gallery.tsx:656-662`) ocupa ~46 px con su margen (`Gallery.css:147-160`) y **desaparece sola** al terminar: toda la grilla salta hacia arriba. Lo mismo con "Últimos abiertos" (`Gallery.tsx:673-692`), que se carga async **después** del primer render e inserta ~90 px, y con `.gallery-error` (`Gallery.tsx:664-668`). El breadcrumb hace `flex-wrap: wrap` sin scroll horizontal (`Gallery.css:102-109`): una ruta profunda ocupa 2–3 líneas.

**Implementación:**
1. Alinear `index.html:46-69` con `Gallery.css:185-218` **píxel a píxel**: 159→150, `.75rem`→`.6rem`, 12px→10px, e incluir la fila de fecha y los ~120 px de header/breadcrumb.
2. Precargar la fuente Inter con `<link rel="preload" as="font" crossorigin>` y usar `size-adjust` en un `@font-face` de fallback para matar el FOUT.
3. Reservar con `min-height` los slots de `.gallery-status`, `.gallery-recientes` y `.gallery-error` para que aparecer/desaparecer no empuje nada.
4. Al breadcrumb, `overflow-x: auto` con `flex-wrap: nowrap`.
5. Quitar el `fadeIn` de `Gallery.css:8` una vez que los dos estados coincidan: si están alineados, el cross-fade sobra.

**Aceptación:** CLS medido en el paso 0.7 por debajo de 0,1.

### 5.3 37 tarjetas con shimmer durante minutos — 🟠

`Gallery.tsx:774-789`: `runPool(pending, 3, processItem)` (`Gallery.tsx:302`) procesa de a 3. En una carpeta de 40 dibujos sin caché, los otros 37 quedan en `queued` mostrando `skeleton-shimmer`. Es la "pantalla de casillas vacías".

Y el shimmer es, además, lo peor que se puede animar: `Gallery.css:521-544` anima `background-position` sobre un `linear-gradient`, lo cual **no va por compositor** y obliga a repintar el gradiente en cada frame, en cada tarjeta, a 60 fps. Con 37 tarjetas son 37 repintados por frame en el mismo hilo que está corriendo `getImageData` (§6.1).

**Implementación:**
1. Reemplazar el shimmer por un `transform: translateX()` sobre un pseudo-elemento (sí va por compositor).
2. **Revelado atómico por tarjeta:** en vez de `status → skeleton | img`, hacer `await img.decode()` antes de montar y revelar la tarjeta completa con un único `opacity`. Quitar `thumbIn`/`scale(1.04)` (`Gallery.css:289-300`), que hace que la miniatura **entre agrandándose** dentro de un `overflow:hidden` en vez de aparecer completa.
3. Añadir `loading="lazy"` y `decoding="async"` a `Gallery.tsx:776` (hoy no tiene ninguno de los dos, así que **todas** las miniaturas se decodifican de golpe).
4. Añadir `@media (prefers-reduced-motion: reduce)` a `Gallery.css`, que hoy no lo tiene: la app es **menos accesible después de montar React** que antes (`index.html:74-76` sí lo respeta).

### 5.4 Las miniaturas se hornean con fondo blanco — 🟠

`thumbnail.ts:66-67` y `:166-168` usan `fillStyle = "#ffffff"` y guardan en **JPEG (sin alpha)** en Supabase. En tema oscuro, cada tarjeta es un cuadrado blanco y **no hay forma de arreglarlo desde CSS**.

**Implementación:** guardar en **WebP con alpha** (soportado en todos los navegadores objetivo) sobre fondo transparente, y dejar que la tarjeta ponga el color. Requiere invalidar el caché de Supabase — usar el mismo mecanismo de versionado explícito que ya se aplica en `rasterCache.ts:114` (`VERSION_RASTER`). Bonus: WebP pesa ~30 % menos que el JPEG actual.

### 5.5 Colores hardcodeados que rompen un tema — 🟠

| Elemento | Valor | Problema |
|---|---|---|
| `Gallery.css:362` `.gallery-toolbar` | `color: #fff` sobre `--bg-elevado` (`#ffffff` en claro) | **Texto blanco sobre blanco: "N seleccionados" es invisible** |
| `Gallery.css:387-388` `.gallery-toolbar-btn` | `rgba(255,255,255,.12)` + `#fff` | El botón de cancelar desaparece en tema claro |
| `Gallery.css:309-319` `.gallery-thumb-overlay` | `rgba(255,255,255,0.65)` | Flash blanco sobre la tarjeta en tema oscuro |
| `Gallery.css:199-202` `.folder-thumb` | `#eaf1ff` | Rectángulos azul claro en grilla oscura |
| `Gallery.css:252` `.gallery-checkbox` | `rgba(255,255,255,0.85)` | Círculo blanco en oscuro |
| `Gallery.css:452-455` `.gallery-modal-option:hover` | `#f1f6ff` | Flash claro en oscuro |
| `Gallery.css:180` `.gallery-error` | `border: #f5c2c7` | Borde rosa claro en oscuro |

**Implementación:** los siete pasan a tokens de `index.css:20-70`, que ya está completo y bien estructurado. Añadir una regla de lint (o un test de CSS) que rechace literales hex fuera de `index.css` y `theme.ts`.

**Bonus relacionado:** `Gallery.tsx:100` mantiene una **copia local** del estado de tema y no escucha el evento `concepts:tema` que emite `theme.ts:32`. Si el visor cambia el tema, el icono Sol/Luna de la galería (`Gallery.tsx:600`) queda desincronizado.

### 5.6 Se pierde el scroll al cerrar el visor — 🟡

`Gallery.tsx:573` usa `style={hidden ? {display:"none"} : undefined}`. `display:none` **colapsa el documento**: al cerrar el dibujo la galería reaparece desde arriba, con la posición de scroll perdida, y el `fadeIn` de `Gallery.css:8` se vuelve a disparar.

**Implementación:** reemplazar por `visibility: hidden; position: absolute; inset: 0` o por `content-visibility: hidden`, que preservan el layout y el scroll.

---

## 6. Fase 4 — Performance en gama baja

### 6.1 Mover el recorte de miniaturas a un worker — 🔴 el mayor bloqueo del hilo principal

`thumbnail.ts:18-75` (`encuadrarAContenido`) corre **entero en el hilo principal**, por cada archivo, ×3 en paralelo:

| Paso | Costo para un `thumb.jpg` de 2048×1536 |
|---|---|
| `createImageBitmap(blob)` (`:135`) | 12,6 MB decodificados |
| canvas full-size + `drawImage` (`:25-28`) | 12,6 MB más |
| `getImageData(0,0,W,H)` (`:35`) | 12,6 MB de `Uint8ClampedArray` |
| doble bucle JS (`:36-46`) | **3,1 millones de iteraciones bloqueando** |
| `toDataURL` (`:74`) | codificación JPEG **síncrona** |

**~38 MB de pico y varios cientos de ms de bloqueo por tarjeta, ×3 concurrentes.** En un teléfono de 1 GB esto solo ya explica la mayoría de los tirones de la galería.

Y **ningún canvas de la galería se libera**: `renderCore.ts:1159-1167` (`liberarImagen`) existe precisamente porque en iOS/Android el buffer no vuelve hasta el GC, pero `thumbnail.ts` nunca hace `canvas.width = 0` en `:19`, `:62`, `:163` ni `:211`.

**Implementación:**
1. Crear `src/Gallery/thumb.worker.ts` que reciba el `Blob` del `thumb.jpg` y devuelva un `Blob` WebP ya recortado, usando `OffscreenCanvas` + `convertToBlob()` (asíncrono, no `toDataURL`).
2. Reemplazar el doble bucle por un **muestreo cada 2–4 píxeles**: da el mismo bbox con 4–16× menos trabajo.
3. Liberar todos los canvas intermedios con `canvas.width = 0` (patrón que el proyecto ya tiene resuelto en `renderCore.ts:1159-1167`).
4. Fallback al camino actual si `soportaOffscreen()` (`device.ts:164-172`) da `false`.

### 6.2 Los presupuestos de `device.ts` se ignoran en la galería y en el ZIP — 🔴

`device.ts` define presupuestos cuidadosos por tier, con los números medidos documentados. Cuatro caminos los ignoran:

| Sitio | Valor hardcodeado | Debería ser |
|---|---|---|
| `Gallery.tsx:302` | `runPool(pending, 3, ...)` | `getBudgets().concurrency` (**2** en gama baja) |
| `thumbnail.ts:194-198` | `maxPixels: 1M`, `maxTotalPixels: 8M`, `concurrency: 4` | derivado de `getBudgets()` |
| `zip.ts:99` | `MAX_CACHE_BYTES = 12 MB` | `getBudgets().maxBufferCacheBytes` |
| `parser.ts:481` | `MAX_BYTES_BLOBS = 16 MB` | derivado del tier |

El caso de `thumbnail.ts` es el peor: como se invoca desde 3 `processItem` simultáneos, el techo efectivo es **24 Mpx ≈ 96 MB**, contra los 12 Mpx / 48 MB que `device.ts:79` establece para gama baja. **El presupuesto se dobla en silencio.**

Y `zip.ts` + `parser.ts` son los únicos caminos que tocan los bytes crudos del archivo: en gama baja son 28 MB fijos encima de los 48 MB de bitmaps.

**`gestureDpr` está definido en `device.ts:44/92/108/123` y no lo consume nadie** (verificado por grep). O se usa para bajar la resolución durante el gesto, o se borra.

**Además, `topeDpr: 2` en las tres gamas** (`device.ts:91/107/122`). En un 412×915 @ DPR 2, con el margen de 1,5×, el canvas es `1236 × 2744` = **3,39 Mpx = 13,6 MB** de backing store y 3,39 Mpx de fill por frame sucio. El comentario de `Viewer.tsx:182-184` ("el canvas de un teléfono es chico, 0,85 Mpx acá") está calculado con DPR 1: la realidad es 4× eso. En gama baja debería ser `topeDpr: 1.5` o incluso 1.

### 6.3 Sacar el parseo del hilo principal — 🟠

`parser.ts:439` hace `decode()` de msgpack de forma **totalmente síncrona** sobre `tree.pack` (0,79 MB comprimidos → varios MB inflados). En un teléfono de gama baja son segundos de hilo principal congelado, con la barra de progreso sin poder repintarse. Lo mismo en `parser.ts:401` para `workspace.pack`.

Se suma el recorrido recursivo de `buscarElementos` (`parser.ts:922-942`), que llama `o.filter(...)` creando un array nuevo **en cada nodo** del árbol.

**Implementación, en dos escalones:**
1. **Barato e inmediato:** cambiar a `decodeAsync()` de `@msgpack/msgpack` v3, que ya es dependencia. Cede el hilo entre chunks y permite que la barra de progreso se repinte.
2. **Correcto:** mover `documentoDesdeZip` completo a un worker. Todo su trabajo es cómputo puro sobre bytes, y con los typed arrays de §3.3 el resultado es **transferible sin copia**, lo cual convierte esto en una mejora doble.

**Además, quitar `leerCamara` del camino crítico.** `parser.ts:496` la tiene `await`-eada **antes** de devolver el documento: suma una request de rango extra + un `decode()` completo + una búsqueda recursiva **antes de que el visor pueda dibujar un solo trazo**. La cámara es puramente cosmética (`parser.ts:396`: "Nunca es un error que falte"). Debe resolverse en paralelo, o después del primer dibujado.

### 6.4 Doble carga de todos los recursos al abrir — 🔴 duplica el tiempo de apertura

Dos sincronizaciones compiten al abrir:
- `Viewer.tsx:1092-1094` (`fitToBounds` en efecto) → `Viewer.tsx:1082` `pedirRefinadoRef.current()` → debounce de 220 ms.
- `Viewer.tsx:1741-1765` (efecto de carga inicial) → espera 1 rAF → `sincronizarRecursos(abort.signal)`.

A los 220 ms dispara la segunda. Sus recursos todavía no llegaron (un PDF tarda segundos), así que `sinBitmap` (`Viewer.tsx:1605-1607`) **los vuelve a incluir todos** y llama a `cargarRecursos` de nuevo. El `sincronizarAbortRef.current?.abort()` de `Viewer.tsx:1727` aborta el sync *debounced* anterior, **no el inicial**, y abortar tampoco detiene el trabajo ya encolado en el worker.

**La causa raíz: no existe registro de "en vuelo".** Consecuencia: al abrir, y en cada gesto durante la carga, se re-pide y re-rasteriza todo lo que aún no llegó. Con 2 workers y ~9 s por PDF en gama baja, esto multiplica el tiempo de apertura.

**Implementación:** un `Map<resourceId, Promise>` de peticiones en vuelo, consultado por `sinBitmap` y `necesita()`. Una petición en vuelo con una escala **igual o mayor** a la pedida cuenta como satisfecha. Es el arreglo de mayor impacto en el tiempo de apertura percibido.

**Relacionado:** `rasterizarEnWorker` (`renderCore.ts:333-360`) **no tiene forma de cancelar**. Abortar solo evita publicar el resultado; el worker sigue quemando CPU con trabajo obsoleto. Añadir un mensaje `cancelar(tareaId)` que el worker atienda entre páginas.

### 6.5 `createImageBitmap` masivo al reabrir — 🟠

`rasterCache.ts:210-224` hace `Promise.all` sobre **todos** los pedidos, cada uno con `createImageBitmap(fila.blob)`. Al reabrir un dibujo de 19 planos son 19 decodificaciones JPEG concurrentes de 1–3 Mpx **en el hilo principal**: un pico de jank grande justo al abrir.

**Implementación:** procesar por lotes del tamaño de `budgets.concurrency`, con `await` entre lotes. Idealmente, decodificar en el worker y transferir los `ImageBitmap`.

### 6.6 `toDataURL` síncrono en cinco caminos — 🟠

| Ubicación | Tamaño | Cuándo |
|---|---|---|
| `Viewer.tsx:974` | hasta 6 Mpx | abrir una foto a pantalla completa |
| `Viewer.tsx:1491` | 384 px × N | abrir el menú de imágenes |
| `Viewer.tsx:824-827` | hasta 24 Mpx | export |
| `InteractivePreview.tsx:179` | hasta 24 Mpx | export de foto |
| `exportRender.ts:123` | hasta 24 Mpx | export de galería |

`Viewer.tsx:974` es el más grave en uso normal: produce un string base64 de MB que vive en el estado de React (`App.tsx:295/301`) **más** la imagen decodificada en el `<img>`. En gama baja son 24 MB decodificados + ~1,5 MB de string.

`exportRender.ts:110` es el más grave en export: retiene el data URL de **todos** los archivos a la vez hasta armar el PDF/ZIP. Con 20 dibujos son ~27 MB de strings vivas simultáneas.

**Implementación:** `canvas.convertToBlob()` / `canvas.toBlob()` + `URL.createObjectURL` en los cinco, guardando `Blob` en vez de data URL. Asíncrono y ~25 % menos memoria. Recordar `revokeObjectURL`.

**Y `maxExportPixels: 24_000_000` en gama baja (`device.ts:87`) es irreal**: son 96 MB de canvas en un teléfono de 1 GB, más el data URL, más los bitmaps vivos. Bajarlo a ~8 Mpx en gama baja y avisar al usuario que la exportación será de menor resolución, en vez de matar la pestaña.

**Bonus:** `exportRender.ts:249` genera el ZIP sin `compression: "STORE"`, así que JSZip aplica DEFLATE a JPEGs ya comprimidos — CPU puro en el hilo principal a cambio de ~0 % de ahorro.

### 6.7 Re-renders de React en la galería — 🟠

`Gallery.tsx` **no tiene un solo `React.memo`, `useMemo` ni componente de tarjeta extraído**. Todo está inline en `Gallery.tsx:747-797`.

- `processItem` hace **dos** `setItems` por archivo (`Gallery.tsx:158-160` y `:175-179`). Con 40 archivos: **80 re-renders del componente completo**, cada uno re-ejecutando `items.map` sobre las 40 tarjetas y reconciliando ~8 nodos por tarjeta, incluidos los SVG de lucide-react (que son componentes React reales).
- `Gallery.tsx:566-567`: `pendingCount` y `cachedCount` recorren `items` en cada render, sin `useMemo`.
- Estado global que re-renderiza toda la grilla: `selected` (marcar **una** tarjeta re-renderiza las 40), `toast`, `refreshing`, `tema`, `recientes`, `showFormatPicker` y `exportProgress` (que se actualiza una vez por archivo exportado, re-renderizando la grilla completa detrás del modal).

**Implementación:** extraer `<TarjetaArchivo>` con `React.memo`, sacar `selected`/`toast`/`exportProgress` de la ruta de render de la grilla (contexto separado o `useSyncExternalStore`), memoizar los contadores, y añadir `content-visibility: auto` a `.gallery-card` (`Gallery.css:204`) como red de seguridad de una línea contra el coste de pintar lo que está fuera de pantalla.

**En el visor**, el equivalente: `setIsDragging`/`setIsRightDragging` (`Viewer.tsx:2206/2212/2340/2389`) provocan un re-render completo de `ViewerBase` **al empezar y al terminar cada gesto**, justo cuando importa la latencia, y solo alimentan el `cursor` (`Viewer.tsx:2608`) y el indicador rojo (`Viewer.tsx:2639`). Deben pasar a un ref más una clase CSS. `rightDragStartPos` como `useState` (`Viewer.tsx:2353`) causa otro re-render al iniciar cada pinch. Y `InteractivePreview` **no está memoizado** (`App.tsx:736-743`): si el usuario abre una foto durante la carga, se re-renderiza entero ~10 veces por segundo.

### 6.8 Red: tres desperdicios concretos — 🟠

1. **El árbol de carpetas se baja dos veces en paralelo.** `Gallery.tsx:319-321` espera a `fetchAllFolderCache()`, que es `select=*` **sin límite** (`supabaseClient.ts:117-126`) e incluye las columnas JSON `subfolders` y `files` de **todas** las carpetas. Y en un deep-link, `App.tsx:146` llama `ubicarArchivo(id)` → `supabaseClient.ts:163` → **`fetchAllFolderCache()` otra vez**, sin memoización ni deduplicación, concurrente con la primera. Es el caso más común (link compartido). Arreglo: memoizar la promesa y proyectar solo las columnas necesarias.

2. **Las miniaturas se re-descargan en cada visita a la carpeta.** `Gallery.tsx:255` llama `fetchCachedThumbnails` en **cada** `loadFolder`, sin caché local. Son data-URLs base64 de ~14 KB × N. Una carpeta de 60 dibujos son ~840 KB de JSON parseado con `JSON.parse` síncrono, **cada vez que se entra**. Arreglo: persistir en IndexedDB junto a `source_modified_at`, que ya se trae y ya sirve de validador.

3. **URL sin límite → 414 silencioso.** `supabaseClient.ts:63-67` arma `drive_file_id=in.(...)` con ~42 caracteres por id percent-encodeado. Una carpeta de 200 dibujos genera ~8.400 caracteres → **414 URI Too Long**. `pedir()` lo traga (`supabaseClient.ts:28-30`: `console.error` + `return null`) → mapa vacío → **los 200 archivos entran en `queued`** y se regeneran las 200 miniaturas desde cero. Es la diferencia entre carga instantánea y varios minutos. Arreglo: batchear en tandas de ~50.

---

## 7. Fase 5 — Bugs de degradación silenciosa

Estos son los más peligrosos de todos: no rompen nada de forma visible, van deteriorando la sesión hasta que el usuario dice "hoy anda lento". Los cinco están en el pool de workers y el caché.

### 7.1 `workersRotos` es un latch permanente — 🔴

`renderCore.ts:223`, `:242`, `:254`, `:260`, `:305`. `worker.onerror` pone `workersRotos = true` y **nadie lo vuelve a poner en `false`** — ni `cerrarWorkersRaster()` (`:363-368`) ni `crearSlot()` en un intento posterior.

**Escenario:** teléfono de 1 GB, un worker muere por OOM al abrir un dibujo pesado — el caso **esperado** en gama baja. A partir de ahí y **para el resto de la sesión**, `tomarSlot`/`esperarSlot` devuelven `null` y **todo pdf.js pasa al hilo principal** vía `rasterizarEnMain` (`:488-558`): los mismos 40,9 s de bloqueo que `raster.worker.ts:143-145` documenta como el bug que se arregló en su momento. Y como el fallback es silencioso, solo se percibe como lentitud.

**Implementación:** `workersRotos` pasa a ser un contador con ventana temporal ("3 fallos en 60 s → desactivar por 5 min"), y `cerrarWorkersRaster()` lo resetea. Además, loguear el evento para que sea diagnosticable.

### 7.2 Fuga de slots del pool → el pool se queda en cero — 🔴

`esperarSlot` (`renderCore.ts:304-309`) encola un `resolve` **sin timeout ni signal**, mientras el llamador tiene `withTimeout(..., 30000)` (`renderCore.ts:774`, `:658`).

**Escenario:** en 3G y gama baja un pedido vence por timeout. El `resolve` queda huérfano en `colaSlots` para siempre. Cuando un slot se libera, `liberarSlot` (`:278-287`) se lo entrega a ese resolver muerto y **lo deja marcado `ocupado` sin devolverlo nunca** (`:281-283`). Con 2–3 timeouts en gama baja, el pool queda con **0 slots utilizables**, todo lo siguiente vence también, y los recursos **no aparecen más**: hueco permanente en el lienzo.

**Implementación:** las entradas de `colaSlots` llevan el mismo `AbortSignal` y timeout que el pedido; al vencer, se sacan de la cola. `liberarSlot` descarta entradas ya abortadas antes de entregar el slot.

### 7.3 Workers que nunca se cierran — 🟠

`programarCierreWorkers` (`renderCore.ts:382-388`): si al vencer los 20 s **algún slot está ocupado**, el `if` no hace nada y `cierreDiferido` ya se puso en `null` (`:385`) — **no se reprograma nunca**.

**Escenario:** cerrás el visor mientras hay un refinado en vuelo (lo normal si cerrás durante un zoom). Los 2–4 workers, cada uno con pdf.js y hasta 2 PDFs parseados, quedan vivos **indefinidamente** mientras navegás la galería — justo cuando la galería necesita la RAM para las miniaturas. El propio comentario de `:372-381` explica que esto es exactamente lo que se quería evitar.

**Relacionado:** el worker muerto se queda en el pool (`renderCore.ts:240-251` limpia `pendientes` y pone `ocupado=false` pero **no hace `terminate()` ni lo saca de `pool`**), y `cerrarWorkersRaster` (`:363-368`) hace `terminate()` **sin rechazar `slot.pendientes`**, dejando promesas colgadas hasta que las mate `withTimeout` a los 60 s.

**Implementación:** reprogramar el cierre si hay slots ocupados; sacar del pool los workers muertos con `terminate()`; rechazar `pendientes` en `cerrarWorkersRaster`.

### 7.4 Clave de caché invertida en fotos verticales — 🟠

`renderCore.ts:821-823` intercambia `pedidoW`/`pedidoH` para orientaciones EXIF 5–8. Esos valores **ya intercambiados** son los que se **escriben** en la clave (`renderCore.ts:909` → `rasterCache.ts:270`). Pero la **lectura** (`renderCore.ts:689-690`) usa `target.width/height` **sin intercambiar**.

La clave exacta nunca coincide, y el segundo nivel tampoco: `rasterCache.ts:188` filtra `c.pedidoW >= p.pedidoW*0.8 && c.pedidoH >= p.pedidoH*0.8`, y con ejes cruzados (guardado 300×400 contra pedido 400×300) da `300 >= 320` → `false`.

**Escenario:** **toda foto vertical sacada con el teléfono se re-rasteriza entera en cada apertura** aunque esté cacheada, y además ensucia el caché con entradas que nunca se leen y que empujan la poda.

**Implementación:** normalizar el orden de ejes en un solo lugar (`claveRaster`), de modo que escritura y lectura usen la misma convención. Bumpear `VERSION_RASTER` (`rasterCache.ts:114`) para invalidar las entradas basura, siguiendo la práctica que el archivo ya tiene documentada.

### 7.5 `topeAlcanzado` marcado con el techo equivocado — 🟠

`Viewer.tsx:1427`: `topeAlcanzadoRef.current[id] = anchoReal*altoReal >= maxPixelsPedido * 0.95`.

`maxPixelsPedido` vale `budgets.maxPixelsPerResource` cuando `hot=false` (anillo, `Viewer.tsx:1329`) y hasta **4× eso** cuando `hot=true` (`Viewer.tsx:1324-1328`). Si un recurso cargado por el anillo satura el techo bajo, queda marcado `topeAlcanzado = true` — y `necesita()` devuelve `false` **para siempre** (`Viewer.tsx:1589-1592`).

**Escenario:** ese plano nunca se refina aunque el usuario se le acerque. Queda borroso el resto de la sesión.

**Implementación:** guardar **el valor del techo con el que se alcanzó**, no un booleano, y comparar contra el techo actual. Además, limpiar `topeAlcanzadoRef` y `plenoPedidoRef` en `desalojarLejanos` (`Viewer.tsx:1240` solo borra `escalaPorRecursoRef`) y en `marcarHot` (`Viewer.tsx:1281`).

### 7.6 Fugas de `ImageBitmap` y promesas — 🟠

- **`renderCore.ts:703-728`:** `leerRasterVarios` ya creó **todos** los `ImageBitmap` antes de que empiece el bucle. Si `options.signal?.aborted` corta en `:705`, los bitmaps de todos los recursos restantes quedan **sin `.close()`**. Con pan/zoom rápido, cada aborto filtra decenas de MB.
- **`renderCore.ts:726`:** el bitmap de "adelanto" se entrega por `onEach` sin meterlo en `loaded`, así que el cleanup por abort del visor (`Viewer.tsx:1443-1455`) no lo ve, y el `onEach` del visor descarta antes de tocarlo (`Viewer.tsx:1400`). Queda vivo hasta que muera la pestaña.
- **`renderCore.ts:47-52`** (`withTimeout`): crea un `setTimeout` que **nunca se cancela** aunque la promesa gane. Con `timeoutMs: 60000` (`Viewer.tsx:1384`) y N recursos × M sincronizaciones, se acumulan timers de 60 s reteniendo closures.
- **`renderCore.ts:869-875`** (`enMain`): cuando el worker falla, cae al hilo principal **sin volver a comprobar `signal.aborted`**. Escenario: el usuario cierra el dibujo → `soltarPdfsAbiertos()` → los renders en vuelo rechazan → **se rasteriza con pdf.js en el hilo principal un dibujo ya cerrado**. Cientos de ms a segundos de bloqueo después de cerrar.

**Implementación:** `try/finally` que cierre los bitmaps restantes al abortar; registrar el adelanto en `loaded`; `clearTimeout` en `withTimeout`; re-chequear `aborted` antes de `enMain()`.

### 7.7 Race de invalidación: se ven los planos de ayer — 🔴 corrección, no performance

`Gallery.tsx:403-405`:
```js
void invalidarSiCambio(item.id, item.modifiedAt);   // async, sin await
onOpen(item.id, item.name, originRect, ...);        // síncrono
```

`invalidarArchivo` (`rasterCache.ts:418-424`) hace `getAll()` del índice más **una transacción por fila** (`await` dentro del `for`). Mientras tanto el visor ya montó y llega a `leerRasterVarios` (`renderCore.ts:703`) en decenas de ms.

**Escenario:** el usuario abrió `Plano.concepts` ayer. Hoy alguien lo re-subió a Drive con planos distintos. Toca la tarjeta → el visor lee de IndexedDB los rasterizados **del contenido viejo** antes de que el borrado termine → **ve los planos de ayer con las anotaciones de hoy encima**. Es exactamente el bug que esa función existe para prevenir (`rasterCache.ts:445-449`).

**Implementación:** `await invalidarSiCambio(...)` antes de `onOpen`, o pasarle al visor una promesa que espere antes de su primera lectura de caché. Aprovechar para convertir el borrado por filas en una sola transacción con cursor.

### 7.8 Otros bugs de corrección — 🟠

- **`pedirPreviews` rompe el menú de imágenes de forma permanente** (`Viewer.tsx:1473-1498`): `previewsDeRef.current = firma` se asigna **antes** del loop (`:1476-1477`), el loop cede el hilo con `setTimeout(0)` (`:1495`), y durante esa cesión `desalojarLejanos`/`marcarHot` pueden llamar a `liberarImagen` (`:1241`, `:1283`) que hace `ImageBitmap.close()`. La siguiente iteración hace `drawImage` sobre un bitmap cerrado → **`InvalidStateError`**, sin `try/catch`, invocado con `void ... ?.()` sin `.catch` (`App.tsx:553`). Como la firma ya quedó registrada, **reabrir el menú no reintenta**: la galería de imágenes queda vacía el resto de la sesión. Falta el mismo chequeo `anchoUtil()` que sí se usa en el render loop (`Viewer.tsx:2031`, `:2835-2839`).
- **`collectFolderFiles` con concurrencia ilimitada** (`Gallery.tsx:483-488`): `Promise.all` sobre **todas** las subcarpetas, recursivo, sin límite de profundidad ni fan-out. Un árbol de 40 subcarpetas en 3 niveles dispara ~40 requests simultáneas al edge function → ~80 a Drive → 429/5xx → reintentos con backoff (`driveClient.ts:51`) → **efecto manada**. Y el modal de progreso ni se muestra, porque `setExportProgress` está en `Gallery.tsx:517`, **después** del bucle: la app parece colgada. Arreglo: usar el `runPool` que ya existe en el mismo archivo (`Gallery.tsx:88`) y mostrar el modal antes.
- **Errores de red indistinguibles de "sin miniatura"** (`parser.ts:341-343`, `:355-357`, `:588-592`): `readEmbeddedThumbnail` traga **todo** con `catch { return null }`. Un 502 esporádico del proxy durante la lectura de `thumb.jpg` (110 KB) hace que la app caiga al camino caro — `parse()` completo, msgpack en el hilo principal, pdf.js — **segundos de CPU y ~10× los datos** para producir una imagen de 192 px que estaba a un reintento de distancia. Arreglo: distinguir "no existe la entrada" (devolver `null`) de "falló la lectura" (propagar y reintentar).
- **`crypto.randomUUID()` a nivel de módulo** (`analytics.ts:7`): solo existe en secure contexts, se ejecuta al importar, fuera de todo `try`. Probar el build desde el teléfono en `http://192.168.1.x:5173` lanza `TypeError` en la evaluación del módulo, y como `Gallery.tsx:16` lo importa, **la app entera queda en blanco** sin relación aparente con analytics. Arreglo: lazy + fallback.
- **`URL.revokeObjectURL` inmediato tras `click()`** (`exportRender.ts:250-255`): carrera conocida en Safari/Firefox móvil — la descarga puede fallar o bajar truncada sin error. Además el `<a>` nunca se agrega al DOM. Arreglo: diferir el revoke.
- **`InteractivePreview` resetea rotación y zoom al llegar el full-HD** (`:111-118`): cuando `App.tsx:301` reemplaza la miniatura, `img.complete` es `false` → `setRotacion(0)` → `onLoad` vuelve a rotar → `encuadrar()` resetea zoom y pan. La foto **se des-rota y se re-rota** con un salto, y **se descarta cualquier zoom que el usuario hizo mientras esperaba**.
- **La transición CSS lagea el pinch** (`InteractivePreview.tsx:407`): `transition: isDragging || isRightDragging ? 'none' : 'transform 0.1s ease'`. En pinch, `handleTouchStart` hace `setIsDragging(false)` (`:323`) y `isRightDragging` es exclusivo de mouse → **la transición de 0,1 s queda activa durante todo el pinch**: gomoso y con retraso perceptible.
- **`exportDrawing` puede colgarse para siempre** (`InteractivePreview.tsx:121-126`): `await new Promise(resolve => { img.onload = resolve; ... })` **sin `onerror`**.
- **`grillaCache` es un global de módulo que sobrevive al desmontaje** (`Viewer.tsx:2779`): retiene un canvas y un `CanvasPattern` creado desde un contexto ya destruido, y se reutiliza al reabrir el visor.
- **`mtimes` en localStorage crece sin límite** (`rasterCache.ts:426-442`): una entrada por cada archivo abierto alguna vez, nunca podado, con `JSON.parse` + `JSON.stringify` **síncronos** en cada apertura. Con 500 archivos vistos son ~35 KB de parse síncrono justo en el momento del tap.

---

## 8. Fase 6 — UI/UX móvil

### 8.1 Safe areas: declaradas pero nunca usadas — 🔴

`index.html:6` habilita `viewport-fit=cover`, pero **no hay un solo `env(safe-area-inset-*)` en todo el proyecto** (verificado por grep).

| Elemento | Valor actual | Consecuencia |
|---|---|---|
| `.floating-tools` | `bottom: 20px; right: 20px` (`App.css:69-77`) | Los botones quedan **bajo el indicador de home** |
| `.btn-close-viewer` | `top: 10px; right: 10px` (`App.css:48-51`) | Bajo el notch en landscape |
| `.viewer-carga` | `bottom: 1.25rem` (`App.css:323`) | Tapada por el indicador |
| `.gallery-toolbar` | `bottom: 1.5rem` (`Gallery.css:355`) | La barra de selección queda sobre el indicador |
| Botón "Cerrar (ESC)" | `top: 20px; right: 20px` (`InteractivePreview.tsx:480`) | Bajo el notch |

**Implementación:** `calc(20px + env(safe-area-inset-bottom))` y equivalentes en los cinco. Es mecánico.

### 8.2 `100vh` en vez de `100dvh` — 🔴

`App.css:27` (`.app-container { height: 100vh }`), `App.css:18` e `index.css:91`. En Safari y Chrome móvil, `100vh` **incluye la zona de la barra de URL**: la fila inferior de herramientas queda **debajo del borde visible**, y el usuario no puede scrollear porque hay `overflow: hidden`.

**Implementación:** `100dvh` con fallback `100vh` para navegadores viejos.

### 8.3 Gestos táctiles — 🟠

- **No hay doble tap para zoom.** Hay **triple tap** para "ver todo" (`Viewer.tsx:2328-2334`, `newCount >= 3`), que es un gesto no estándar y **no está documentado en ninguna parte de la UI**. Añadir doble tap (el gesto que todo el mundo espera) y mantener el triple como atajo.
- **El contador de taps no se resetea por movimiento:** un arrastre corto seguido de dos toques dispara `fitToBounds` sin querer.
- **No hay inercia ni momentum en el paneo.** En móvil se siente rígido. Es la diferencia más grande entre "se siente nativo" y "se siente una web".
- **`InteractivePreview` no tiene doble ni triple tap:** para volver al encuadre hay que rotar dos veces o cerrar y reabrir.
- **Sin `overscroll-behavior`** ni en `.app-container` ni en `.fullscreen-preview`: en Android, un gesto vertical que el canvas no consuma puede disparar **pull-to-refresh y recargar la página**, perdiendo el dibujo abierto.
- **Sin `-webkit-touch-callout: none`:** `user-select: none` está (`App.css:31`), pero en iOS un long-press puede abrir el menú de compartir.

### 8.4 El modo selección es invisible en móvil — 🟠

`Gallery.css:258-265`: el checkbox tiene `opacity: 0` y solo se muestra con `:hover`, `:focus-visible` o `.checked`. **En un teléfono no hay hover.**

Consecuencia: el modo selección y **toda la exportación PDF/ZIP** (`Gallery.tsx:817-877`) son una función invisible en el dispositivo principal de la app. Funciona (un elemento con `opacity: 0` sigue recibiendo eventos), pero nadie lo va a descubrir.

**Implementación:** en pantallas táctiles (`@media (hover: none)`), mostrar el checkbox siempre a baja opacidad, o activar el modo selección con long-press y entonces revelar todos los checkboxes.

**Bug adyacente:** `Gallery.css:262` exige que **la tarjeta** tenga `:focus-visible`; cuando el usuario tabula al `<button>` interno, la tarjeta lo pierde y **el checkbox enfocado sigue invisible**. Usar `:focus-within`.

### 8.5 Áreas táctiles por debajo del mínimo — 🟠

`.gallery-icon-btn` es **30×30 px** (`Gallery.css:79-80`); los de tema/reset, 38×38 (`Gallery.css:570-575`). El mínimo recomendado es 44×44. Agrandar el área táctil sin agrandar el icono (padding o pseudo-elemento).

### 8.6 Feedback de exportación — 🟠

`App.tsx:649-651` dispara `exportDrawing` y el menú queda abierto sin cambios. En gama baja el export tarda decenas de segundos **con el hilo principal bloqueado** (`toDataURL` de hasta 24 Mpx): el usuario cree que no funcionó y vuelve a apretar, **encolando un segundo export**. Y `exportFueRecortado` solo hace `console.warn` (`Viewer.tsx:737-739`).

En la galería es peor: `exportProgress` se re-renderiza **desde el mismo componente que está bloqueado** (`Gallery.tsx:530`), así que **el contador no se mueve** mientras el canvas trabaja.

**Implementación:** deshabilitar el botón durante el export, mostrar progreso real (que exige ceder el hilo entre archivos con `await new Promise(r => setTimeout(r, 0))`), y avisar al usuario cuando la exportación se recortó por presupuesto.

**Menor:** `Viewer.tsx:705` usa `alert()` para el lienzo vacío — diálogo nativo bloqueante, inconsistente con el resto de la UI.

### 8.7 Accesibilidad — 🟡

| Problema | Ubicación |
|---|---|
| `<div role="button" tabIndex={0}>` con un `<button>` **anidado** dentro → ARIA inválido | `Gallery.tsx:712-734`, `:750-772` |
| El checkbox no tiene `role="checkbox"` ni `aria-checked` | `Gallery.tsx:765-772`, `:727-734` |
| Sin `aria-live` → el progreso de miniaturas y el toast son inaudibles | `Gallery.tsx:656-662`, `:803-815` |
| Los **4 modales** no tienen `role="dialog"`, `aria-modal`, trampa de foco ni cierre con Escape | `Gallery.tsx:839`, `:879`, `:919`, `NamePrompt.tsx:19` |
| `alt={item.name}` duplica el `.gallery-name` de abajo → doble anuncio; debería ser `alt=""` | `Gallery.tsx:776` vs `:790` |
| `aria-label` faltante en los botones de export/capas/imágenes (solo tienen `title`) | `App.tsx:635`, `:89`, `:170` |
| `prefers-reduced-motion` no cubre `pulseDot`, `fadeIn`, `slideUpFade`, `popIn`, `spin-slow` ni el hero | `App.css:425-484`, `src/App.tsx:242` |

**Nota positiva que conviene no romper:** el `onKeyDown` con Enter/Espacio y `preventDefault` está bien puesto (`Gallery.tsx:719-724`, `:757-762`), ningún elemento remueve el `outline`, y la barra de carga tiene `role="status" aria-live="polite"` (`App.tsx:33`).

### 8.8 Micro-optimización de layout — 🟡

`Viewer.tsx:2642-2643` llama `getBoundingClientRect()` **dos veces dentro del JSX**, forzando layout síncrono en cada render mientras dura el gesto de zoom. Mismo problema en `InteractivePreview.tsx:424-425`.

---

## 9. Fase 7 — Build, deploy y seguridad

### 9.1 `puppeteer` está en `dependencies` — 🔴 arreglo de 10 segundos

`package.json:21`. Vercel instala Puppeteer y **descarga Chromium (cientos de MB) en cada build**. Es herramental de test puro (los ~100 scripts de `scripts/`) y no entra en el bundle. Mover a `devDependencies`.

### 9.2 Sin `build.target` en Vite — 🔴 riesgo de pantalla en blanco

`vite.config.ts` no tiene bloque `build` en absoluto. Vite 8 usa por defecto un target moderno (`baseline-widely-available`). El proyecto declara soportar un tier de gama baja para teléfonos de 1 GB (J7 Neo, TCL 30 SE) y tiene una batería de tests para ello, pero **esos tests corren en Chrome de escritorio con CPU throttling, no en un WebView Android viejo**. `tsconfig.app.json` declara `target: es2023` pero con `noEmit: true`: **no afecta el output**, solo tipa.

Si algún WebView del parque real no soporta la sintaxis emitida, la app falla con pantalla en blanco y **ningún test lo detectaría**. Es el riesgo con peor relación impacto/esfuerzo del proyecto: se arregla con una línea.

**Implementación:** fijar `build.target` explícitamente al mínimo real que se quiere soportar (por ejemplo `['chrome87', 'safari14']`) y verificarlo una vez en un dispositivo físico de gama baja.

### 9.3 pdf.js bundleado dos veces — 🟠 ~430 KB de más

`dist/assets/pdf-*.js` (427 KB, hilo principal) **más** el mismo pdf.js embebido dentro de `raster.worker-*.js` (430 KB). Es consecuencia de no tener `manualChunks` y de que Vite bundlea los workers de forma aislada.

**Implementación:** verificar si el camino de `rasterizarEnMain` (`renderCore.ts:488-558`) justifica tener pdf.js también en el hilo principal. Si es solo un fallback, cargarlo con `import()` dinámico bajo demanda: se ahorran 427 KB de descarga y parseo en el 95 % de las sesiones.

### 9.4 `vercel.json` sin headers — 🟠

Solo tiene `rewrites`. El rewrite SPA está bien resuelto (la negación de `assets/` hace que un asset faltante dé 404 real en vez de HTML). Falta:
- `Cache-Control: public, max-age=31536000, immutable` para `/assets/*` — los archivos ya vienen con hash en el nombre, y es lo que más rinde en 3G.
- Headers de seguridad básicos.

### 9.5 Sin PWA ni Service Worker — 🟠

`public/` solo tiene `favicon.svg` e `icons.svg`: no hay `manifest.webmanifest`, ni `sw.js`, ni iconos de instalación. Para una app que se usa en obra desde el teléfono, no hay offline ni "agregar a pantalla de inicio".

(El warning de `WEB_60_PWA.json` sobre "el manifest no declara icons" es un **falso positivo**: el analizador leyó `.cache/concepts/manifest.json` del corpus como si fuera un webmanifest.)

**Implementación:** manifest + iconos + un Service Worker que cachee el app shell con `stale-while-revalidate`. Encaja de forma natural con la caché de miniaturas en IndexedDB de §6.8.2.

### 9.6 El edge function es un proxy abierto de Drive — 🔴 seguridad

`supabase/functions/concepts-drive/index.ts:317-328`:
```js
const fileId = url.searchParams.get("fileId") || "";
if (!fileId) throw new Error("falta fileId");
```

**Cero validación** más allá de "no vacío". No hay lista blanca de carpetas, ni verificación de que el `fileId` pertenezca a `DRIVE_FOLDER_ID`, ni límite de tamaño, ni rate limiting. Lo mismo para `folderId` (`index.ts:282`).

La `SUPABASE_ANON_KEY` está hardcodeada en `config.ts:4-5` — correcto para una anon key, **pero es la única puerta**: viaja en el bundle público, con `Access-Control-Allow-Origin: *` (`index.ts:21`) y un JWT que expira en **2101** (`exp: 2101535934`, ~75 años). Cualquiera que abra devtools tiene una credencial permanente para descargar **cualquier archivo público de Drive del planeta** a través de tu función (consumiendo tu egress y tu cuota de invocaciones), o para usarla como proxy de anonimización.

La lista blanca de hosts para el parámetro `u` (`index.ts:33-44`) está bien pensada y demuestra que el riesgo se consideró — **pero se aplicó al parámetro equivocado**. `fileId`/`folderId` son la superficie real.

**Implementación mínima:** validar `/^[A-Za-z0-9_-]{10,60}$/` en ambos (que además cierra la inyección de query string de `index.ts:77`, `:106`, `:207`, donde el valor decodificado se interpola crudo en la URL de Google), y verificar la pertenencia al árbol de `DRIVE_FOLDER_ID` contra la tabla `drive_folder_cache` que ya existe.

### 9.7 La IP del usuario se filtra y queda estampada en los archivos exportados — 🟠

`exportMetadata.ts:21` consulta `https://api.ipify.org` (un tercero, sin consentimiento) y la IP pública se escribe en los metadatos del PDF (`keywords: ip:${metadata.ip}`, `exportRender.ts:203`) y en `metadata.txt` dentro del ZIP (`exportRender.ts:238`).

Combinado con `userName` de localStorage (`userIdentity.ts:4`) y la fecha, **cualquiera que reciba el PDF obtiene la IP y el nombre de quien exportó**.

**Implementación:** si el objetivo es trazabilidad interna, resolverlo **en el edge function** (que ya ve la IP del cliente, sin terceros) y guardarlo en la tabla de eventos — no incrustado en un archivo pensado para compartirse.

### 9.8 Higiene — 🟡

- **4 archivos rotos en la raíz:** `debug.ts`, `test-msgpack.ts`, `test-zip.ts` y `screenshot.js` leen `./public/Dibujo12.concepts`, que ya no existe. `debug.ts` importa `./src/parser.ts` (ruta obsoleta) y `screenshot.js` escribe en una ruta absoluta hardcodeada de otra herramienta. Borrarlos, junto con `scratch/`.
- **`tsc -b` no chequea nada de `scripts/`** (101 archivos): `tsconfig.node.json` incluye **solo** `vite.config.ts`. Coincide con los 54 huecos `ts-partial` que declara `IA_90_HUECOS.jsonl`.
- **`.oxlintrc.json` es el template stock de Vite** (2 reglas), con `typeAware` desactivado.
- **`README.md` es el boilerplate de Vite sin editar** y **no existe ningún `CLAUDE.md`**. El conocimiento real del proyecto vive en `APK/PLAN_PARIDAD_VISOR.md`, `APK/RESUMEN_SESION.md` y en los comentarios del código (que son inusualmente buenos). Vale la pena un `CLAUDE.md` que apunte ahí.
- **El esquema de Supabase no está versionado:** no hay `supabase/migrations/`. La tabla `concept_thumbnails` y `drive_folder_cache` viven solo en el proyecto remoto.
- **`THUMBNAIL_SIZE = 192`** (`config.ts:14`) contra tarjetas de 150 px CSS: a DPR 2–3 la tarjeta necesita 300–450 px reales, así que **las miniaturas se ven borrosas justo en el dispositivo objetivo**. Subir a 384 (con WebP de §5.4, el peso se compensa).
- **CSS muerto** (verificado por grep): `.gallery-card.opening` (`Gallery.css:229-231`), `.gallery-card[aria-disabled="true"]` (`:226-228`), `.gallery-thumb-progress` (`:323-329`).
- **Código muerto:** `driveClient.ts:94-133` (`downloadDriveFile`), `driveCrawler.ts` completo (nadie importa `crawlAndCacheEverything`), y toda la maquinaria de recortes por región (`renderCore.ts:73-78`, `raster.worker.ts:196-203`, `regionEnBitmap` en `renderCore.ts:1145-1157`), desactivada desde `Viewer.tsx:1330-1341` pero todavía en el bundle y en el worker.

---

## 10. Orden de ejecución recomendado

El orden importa: varias correcciones dependen de otras, y algunas de performance solo son medibles una vez que la app deja de morirse.

### Bloque A — Cimientos (1 sesión)
`Fase 0` completa · §9.1 (puppeteer) · §9.2 (`build.target`) · §5.1 (CSS del spinner)

Empezar por lo que se mide y por los tres arreglos de minutos que ya eliminan una pantalla rota y un riesgo de pantalla en blanco.

### Bloque B — Que no se muera (2–3 sesiones)
§3.1 (techo de tamaño) · §3.2 (timeouts) · §3.4 (`MAX_CANVAS_SIDE`) · §7.1 (`workersRotos`) · §7.2 (fuga de slots) · §7.3 (workers que no cierran)

Sin esto, cualquier medición de performance en gama baja está contaminada: se estaría midiendo una app que ya se degradó a sí misma.

### Bloque C — Cero negro (3–4 sesiones) ← **el objetivo del pedido**
§4.1 (cobertura completa) · §4.2 (no descartar por gesto) · §4.3 (flash de apertura) · §4.4 (huecos con preview recortada) · §4.5 (umbral de zoom) · §4.7 (desalojo) · §5.3 (revelado atómico en galería) · §5.2 (CLS)

Este es el bloque que responde literalmente a "que no haya sectores en negro cargando visibles". Verificar con `bench-negro.mjs` (paso 0.6).

### Bloque D — Performance real (3–4 sesiones)
§6.4 (doble carga) · §6.1 (miniaturas al worker) · §3.3 (typed arrays) · §6.3 (parseo fuera del hilo) · §6.2 (presupuestos) · §6.7 (re-renders)

§6.4 primero porque es el que más reduce el tiempo de apertura percibido, y es un cambio acotado. §3.3 y §6.3 se refuerzan entre sí (typed arrays hace el resultado transferible sin copia).

### Bloque E — Corrección y pulido (2–3 sesiones)
§7.4–§7.8 · §6.5 · §6.6 · §6.8 · §8 completo

### Bloque F — Plataforma (1–2 sesiones)
§9.3–§9.7 · §9.8

---

## 11. Criterios de aceptación globales

Medidos en gama baja (`?tier=baja` o dispositivo real), sobre el peor caso del corpus:

| # | Criterio | Cómo se verifica |
|---|---|---|
| 1 | **Ningún frame entre el tap y el revelado muestra más de 5 % de píxeles de fondo descubiertos** | `scripts/bench-negro.mjs` (0.6) |
| 2 | CLS del arranque de la galería por debajo de 0,1 | `PerformanceObserver` (0.7) |
| 3 | Pico de heap por debajo de 250 MB al abrir el dibujo de 262,9 MB | `bench-produccion-completo.mjs` |
| 4 | Ningún bloqueo del hilo principal mayor a 200 ms durante la apertura | `bench-cpu-profile.mjs` |
| 5 | La sesión no se degrada: abrir y cerrar 10 dibujos seguidos mantiene el fps del primero | test nuevo de sesión larga |
| 6 | Geometría intacta: 176 archivos, 0 fallos, 141.287 trazos, 2.368 imágenes | `test-corpus.mjs` |
| 7 | Un `.concepts` truncado de 262 MB da error legible en menos de 2 s, sin matar la pestaña | test nuevo |
| 8 | Con la red cortada, todo estado de carga se resuelve en menos de 20 s | test nuevo |

El criterio 5 es el que hoy no existe y es el que más importa en uso real: los bugs de la fase 5 (§7) son todos acumulativos dentro de una misma sesión.

---

## 12. Lo que conviene NO tocar

El proyecto tiene decisiones muy bien pensadas y documentadas. Vale la pena listarlas para no romperlas por accidente:

- **El lector de ZIP por rangos HTTP** (`zip.ts`): permite abrir un dibujo de 262 MB bajando el 4 % de sus bytes. Soporta ZIP64, tolera offsets corridos ±64 bytes y usa `DecompressionStream` nativo. Es lo mejor del proyecto.
- **La resolución del interstitial de virus de Drive** (`index.ts:199-226`): sin esto, ~30 % de los `.concepts` no se podían abrir.
- **El modelo híbrido de pan/zoom** (transform CSS durante el gesto + reanclaje): el enfoque es correcto; solo hay que arreglar el umbral de §4.5.
- **`esperarSlot` encolando en vez de caer al hilo principal** (`renderCore.ts:304-309`): exactamente lo correcto para gama baja.
- **El versionado explícito de cachés con el motivo documentado** (`rasterCache.ts:30`, `:114`).
- **El script inline de tema en `index.html:23-32`**: aplica `data-theme` antes de pintar, con `try/catch` para incógnito. Cero flash blanco.
- **La barra de carga con porcentaje real** (`progreso.ts`): calculado sobre los bytes que de verdad se van a bajar, con ETA suavizada por EMA, y barra indeterminada honesta cuando no se puede calcular.
- **El manejo de `popstate`** (`App.tsx:181-199`): atrás **reabre** el dibujo si la URL apunta a él, no solo cierra.
- **La degradación silenciosa de todo lo persistente** (IndexedDB y localStorage devuelven `null`/no-op en incógnito en vez de romper).
- **Los comentarios del código**: densos y con mediciones concretas. Son la documentación real del proyecto. Mantener ese estándar en todo lo que se agregue.
