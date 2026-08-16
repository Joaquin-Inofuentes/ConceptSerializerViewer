# Por qué nuestro visor no se ve como la app, y plan para corregirlo

Investigación hecha el 2026-08-16 decodificando `tree.pack` real de 60 archivos del corpus,
comparando contra el `thumb.jpg` que renderiza la propia app, y leyendo los símbolos C++ del
motor nativo `libCore.so` (que **no está stripped**: conserva los nombres de clases y métodos).

---

## Resumen ejecutivo

Nuestro visor no falla por "posicionar mal": falla porque **descarta datos que el archivo sí trae**.
Encontré 5 problemas reales, 2 de ellos con prueba visual directa. Los dos grandes:

1. **Ignoramos la matriz de transformación de cada trazo.** El 30,6% de los trazos del corpus
   (9.813 de 32.085) tiene una matriz ≠ identidad que no aplicamos. Por eso grupos enteros de
   anotaciones aparecen volando lejos del dibujo.
2. **Usamos la convención de coordenadas equivocada.** Hacemos una rotación de 180° (`-x,-y`)
   cuando lo correcto es invertir solo Y (`x,-y`). La diferencia es un **espejado horizontal**:
   por eso el texto se lee al revés.

Evidencia visual en [`APK/evidencia/`](evidencia/).

---

## Cómo está armado el formato realmente

El `.concepts` es un ZIP con estas entradas (verificado):

| Entrada | Qué es | ¿Lo usamos hoy? |
|---|---|---|
| `tree.pack` | El documento: capas, trazos, imágenes colocadas (MessagePack) | Sí |
| `thumb.jpg` | Render oficial de la app (lienzo fijo 1024×640 o 640×1024) | Sí (miniatura) |
| `metadata.json` | `identifier`, `backgroundColor`, `creationTime`, `modificationTime` | Parcial |
| `workspace.pack` | **Estado de UI + CÁMARA guardada** (pan, zoom, rotación de vista, paleta) | **NO** |
| `resource.pack` | Índice de recursos | **NO** |
| `resources/<uuid>.<ext>` | PDFs y fotos embebidos | Sí |

### La estructura de un elemento (el hallazgo central)

Trazos e imágenes comparten **exactamente la misma cabecera de elemento**:

```
cabecera = [ 3, <estilo>, UUID, null, null, 0, <timestamp>, MATRIZ, false, <int> ]
                                                            ↑ índice 7
```

- **Imagen** (`tipo 8` = PDF, `tipo 7` = foto): `item[1][1]` es esa cabecera → leemos su matriz. ✅
- **Trazo** (`tipo 6`, envuelto en `tipo 11` o `tipo 9`): `item[1]` es esa **misma** cabecera →
  **ignoramos su matriz**. ❌

Esa asimetría es toda la explicación de "las imágenes caen bien y los trazos no".

Concepts **no reescribe los puntos** cuando movés/rotás/escalás trazos: actualiza esa matriz.
Lo confirman los símbolos del motor nativo: `SelectionTransformEditor::applyTransform`,
`::applyTranslation`, `::applyScaleFactor`, `::flip(bool)`, y `TreeEditor::setTransform(LeafItem&, …)`.

---

## Los 5 problemas, en orden de impacto

### P1 — Matriz de trazo ignorada (CRÍTICO, con prueba visual)

**Qué pasa:** `parser.ts` lee el blob de puntos y los usa como coordenadas de mundo, descartando
la matriz del elemento.

**Medición sobre el corpus (60 archivos):**
- 9.813 / 32.085 trazos (30,6%) con matriz ≠ identidad → todos mal ubicados.
- 2.122 con rotación real; 6 con determinante negativo (espejados).
- En contraste: 508 / 509 imágenes tienen matriz ≠ identidad, y esas **sí** las aplicamos.
- Peor archivo (`13oMGx…`): 5.439 de 7.381 trazos (73,7%) mal ubicados.

**Prueba visual:** [`2_trazos_SIN_matriz_HOY.png`](evidencia/2_trazos_SIN_matriz_HOY.png) muestra un
grupo entero ("FICHO / SKI / TOMO / BAÑO") disparado lejos a la derecha, que estira el encuadre y
achica todo lo demás. En [`3_trazos_CON_matriz_CORREGIDO.png`](evidencia/3_trazos_CON_matriz_CORREGIDO.png)
ese grupo vuelve a su lugar y se integra con el resto.

**Prueba numérica independiente:** los trazos con matriz identidad están indiscutiblemente en
espacio mundo. Midiendo la distancia de los trazos transformados a esa región: aplicar la matriz
los acerca en 3 archivos y los aleja en 1; en el peor archivo el error mediano cae de **0,1346 a 0,0000**.

### P2 — Convención de coordenadas equivocada (CRÍTICO, con prueba visual)

**Qué pasa:** Concepts guarda el documento con **Y hacia arriba** (convención matemática); el canvas
del navegador tiene **Y hacia abajo**. La conversión correcta es invertir **solo Y**: `(x, y) → (x, -y)`.

Nosotros hacemos `girarPunto → (-x, -y)` y `girarTransform → niega las 6 componentes de la afín`,
que es una **rotación de 180°**. La diferencia entre rotar 180° e invertir Y es un **espejado en X**.

**Prueba visual:** misma región del mismo archivo, misma escala:
- [`4_convencion_flipY_texto_legible.png`](evidencia/4_convencion_flipY_texto_legible.png) — se lee
  perfecto: `7,60x12,60x0,50 = 4,66 m³ / 2 = 3,2 m³`.
- [`5_convencion_rot180_texto_ESPEJADO.png`](evidencia/5_convencion_rot180_texto_ESPEJADO.png) — el
  mismo texto sale espejado.

**Por qué el hack parecía funcionar:** rotar 180° corrige el aspecto *grueso* del encuadre (queda
"derecho" en vez de patas para arriba), así que a simple vista pasaba. Pero cada glifo queda
espejado. El comentario en `parser.ts` que dice "se midió la dirección del texto y corría hacia la
izquierda en los 25 planos" describe justamente el espejado, mal interpretado como rotación.

Esto también explica el bug ya anotado como pendiente ("trazos y planos a media vuelta uno del
otro"): sobre el espejado global se le sumaron parches por recurso (`rotation: 0` en pdf.js,
compensación EXIF) que corrigen las imágenes pero no los trazos, dejándolos desfasados entre sí.

### P3 — Segunda matriz de imagen ignorada (ALTO)

Cada imagen tiene **dos** matrices: la de colocación (cabecera índice 7, la que sí usamos) y una
segunda al final del cuerpo del ítem, que **ignoramos**. En `13oMGx…` las 26 imágenes la tienen
distinta de identidad, incluida una rotación de 90° exacta: `[0,-1,1,0,0,0]`.

Esa segunda matriz es la que mapea el contenido del recurso dentro de la caja del elemento — es
decir, **es donde vive la rotación de página del PDF**. Hoy la suplimos a mano forzando
`rotation: 0` en pdf.js y compensando EXIF por separado; el archivo ya nos da el dato exacto.

### P4 — Imágenes anidadas en grupos se pierden (MEDIO)

`buscarElementos` solo reconoce trazos (`tipo 6`). Si una imagen está anidada dentro de un grupo en
vez de colgar directo de la capa, nunca vuelve a pasar por `procesarItem` y **desaparece en
silencio** (no aparece mal ubicada: no aparece).

### P5 — Heurísticas que compensan los bugs anteriores (MEDIO)

Con P1–P3 corregidos, estas dejan de tener sentido y pasan a ser dañinas:
- `corregirColocacionesFlotantes` — centra imágenes cuando "ningún trazo cae sobre ninguna imagen".
  Ese 0% era **síntoma** de P1/P2.
- El centrado cuando la parte lineal es identidad (`transform[12] -= width/2`) — parche de la misma
  familia.
- La compensación EXIF no se aplica en el camino de recorte por zoom (`renderCore.ts:774`, guardado
  por `!region`): una foto con EXIF 5-8 se ve bien de lejos y mal de cerca.

### Además: datos que tiramos

- **`workspace.pack` trae la cámara guardada** (viewport, pan, zoom y rotación de vista en *turns*).
  El motor nativo tiene `CanvasTransform::setViewportRotation(RotationTurn)` y
  `Export::ModelData::Canvas::viewportRotation`. Abrir el dibujo en el mismo encuadre que la app es
  gratis: el dato está ahí.
- **Capas:** tienen matriz propia (índice 4 de su cabecera) y campos de visibilidad/opacidad que hoy
  no leemos del archivo.

---

## Plan de implementación

Orden pensado para que cada paso sea verificable por separado y no se tape un bug con otro.
**Importante:** P1 y P2 deben ir juntos en la misma tanda de verificación, porque las heurísticas
actuales (P5) están calibradas contra los dos bugs a la vez; corregir uno solo puede empeorar la
métrica y llevar a conclusiones falsas.

### Paso 0 — Red de seguridad (antes de tocar nada)

1. Crear `scripts/verificar-geometria.mjs` con el arnés que ya usé en esta investigación:
   decodifica `tree.pack` sin dependencias del visor y renderiza los trazos a PNG.
2. Congelar una **línea base** sobre ≥20 archivos del corpus: para cada uno, guardar bbox del
   documento, cantidad de trazos/imágenes, y un PNG de referencia.
3. Métrica de aceptación por archivo:
   - *legibilidad*: el texto no debe salir espejado (chequeo visual sobre 5 archivos elegidos);
   - *cohesión*: ningún grupo de trazos a más de 1,5 diagonales del bbox de los trazos con matriz
     identidad (detecta el "grupo volador" de P1);
   - *no-regresión*: los archivos que hoy se ven bien no deben cambiar su bbox más de 2%.

### Paso 1 — Aplicar la matriz de elemento a los trazos (P1)

En `parser.ts`:

1. En `emitirTrazo`, leer la matriz de la cabecera del trazo (`o[1][7]`, validando que sea el array
   de 16 floats del ext type 7) y aplicarla a cada punto al construir `stroke.points`.
2. Escalar el ancho del trazo por el factor de escala de esa matriz
   (`sqrt(|det|)` de la parte lineal), si no un trazo escalado sale con el grosor original.
3. Reconocer explícitamente los envoltorios `tipo 11` y `tipo 9` en `procesarItem` en vez de caer al
   recursivo genérico, para no depender de que el `buscarElementos` "adivine".

Riesgo controlado: si la matriz no está o no es válida, comportarse exactamente como hoy.

### Paso 2 — Arreglar la convención de coordenadas (P2)

1. Reemplazar `girarPunto(x,y) → [-x,-y]` por `[x,-y]`.
2. Reemplazar `girarTransform` (que niega `[0,1,4,5,12,13]`) por la composición correcta con el
   flip de Y: para la afín `[a,b,c,d,e,f]`, pasar a `[a,-b,-c,d,e,-f]`.
   (Es `F ∘ M` con `F = diag(1,-1)`; no es lo mismo que negar todo.)
3. Revisar los tres lugares que hoy compensan a mano y quitar la compensación **solo si** la
   verificación del Paso 0 lo confirma: el `rotation: 0` de pdf.js pasa a decidirse por P3.

### Paso 3 — Usar la segunda matriz de imagen (P3)

1. Leerla en `procesarItem` (última matriz del cuerpo del ítem) y guardarla en `ImageElement`.
2. Al dibujar, componer: primero la segunda matriz (contenido → caja), después la de colocación.
3. Con eso, dejar que pdf.js entregue el viewport **con** su rotación natural y comparar contra el
   camino actual (`rotation: 0`) archivo por archivo. Quedarse con el que dé deformación 1,000.
4. Volver a correr `scripts/audit-imagenes.mjs` (ya existe): debe seguir dando ≤2% de desvío.

### Paso 4 — Imágenes anidadas (P4)

Hacer que el recorrido recursivo reconozca imágenes en cualquier nivel, no solo trazos: mover la
detección de `tipo 7/8` adentro de `buscarElementos` (o mejor, unificar en un solo recorrido que
despache por tipo). Verificar contando imágenes detectadas por archivo antes/después.

### Paso 5 — Retirar las heurísticas (P5)

Recién ahora, y una por una, midiendo con el arnés del Paso 0:
1. Quitar `corregirColocacionesFlotantes`.
2. Quitar el centrado por "parte lineal identidad".
3. Arreglar la compensación EXIF para que también aplique en el camino con `region`
   (o mejor: si P3 resuelve la orientación desde el archivo, eliminarla).

Si al quitar una heurística algún archivo empeora, **eso es información**: significa que queda un
caso del formato sin entender. Anotarlo, no volver a poner el parche a ciegas.

### Paso 6 — Paridad de encuadre con la app (mejora visible, opcional pero barata)

Leer `workspace.pack` y usar la cámara guardada (pan, zoom, rotación de vista) como encuadre inicial
al abrir un dibujo, en vez de nuestro "fit to bounds". Es lo que hace que al abrir un archivo se vea
igual que en la app, en la misma parte del dibujo.

### Paso 7 — Capas

Leer del archivo la matriz de capa (aplicarla a todos sus hijos) y los campos de visibilidad, en vez
de asumir capas neutras.

---

## Lo que queda fuera de alcance

El formato interno de los `.pack` está reconstruido por observación, no por especificación. Lo que
**no** se puede sacar leyendo Java del APK (ya verificado: cero menciones a `tree.pack` en las 34.110
clases) es la semántica exacta de campos que todavía no identificamos. Si en el futuro aparece un
caso que no cierra, el siguiente paso es desensamblar `libCore.so` con Ghidra/IDA — y ahí hay una
ventaja concreta: **el binario conserva los símbolos**, así que las funciones están nombradas
(`Drawing::Tree::LeafItem`, `CanvasTransform::setViewportRotation`, etc.).
