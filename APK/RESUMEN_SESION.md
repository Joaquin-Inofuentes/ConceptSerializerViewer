# De "los trazos no coinciden" a paridad con la app — recorrido completo

Resumen de toda la investigación y los cambios. El problema de fondo: el visor web
dibujaba las anotaciones fuera de los planos que anotaban, y el texto se leía al
revés. Terminó resuelto y verificado en producción.

---

## 1. Punto de partida

El síntoma reportado, ya anotado en el código como pendiente: en
`Fede y Franco/Concepts/HO/Drawing`, las anotaciones "+0,10" y "+0,40" se leían
**espejadas** y estaban **fuera del plano**, mientras el rótulo del plano de al
lado ("Holmberg 1764") se leía perfecto. El último commit del repo se llamaba
literalmente *"Record that strokes and sheets render half a turn apart"*.

Intentos previos habían dejado en el código dos heurísticas compensatorias y un
comentario que concluía que "Concepts guarda el documento girado 180 grados".

## 2. Descompilar el APK oficial

Sin herramientas instaladas (ni permisos de admin), bajé un JRE portable y jadx a
`APK/_tools/` y descompilé `Concepts.apk` (310 MB, versión 2025.10.1):

- **34.110 clases Java** reconstruidas, **sin ofuscar** (nombres reales).
- El listado completo por paquete quedó en [`LISTADO_CLASES.md`](LISTADO_CLASES.md)
  (2.923 clases propias en 200 paquetes) y el análisis en
  [`ANALISIS_REVERSING.md`](ANALISIS_REVERSING.md).

**El resultado más valioso fue negativo.** Grepeé las 34.110 clases buscando
`tree.pack`: **cero coincidencias**. Toda la lógica del formato vive en C++
compilado (`libCore.so`, 58 MB). Eso descartó la ruta de "leer el Java hasta
entender el formato", que es donde se habría ido el tiempo.

Lo que el APK sí aportó: el binario **no está stripped**, así que conserva los
símbolos C++. Ahí aparecen `SelectionTransformEditor::applyTransform`,
`::applyTranslation`, `::applyScaleFactor`, `::flip(bool)` y
`TreeEditor::setTransform(LeafItem&)` — evidencia directa de que **las
transformaciones viven en el elemento** y de que mover un trazo no reescribe sus
puntos. También `Coords::System::World/Canvas/View/Render`, `RotationTurn` y
`renderTextureHasFlippedYAxis`.

## 3. Medir el formato real

Como el APK no iba a dar el formato, decodifiqué los `tree.pack` de verdad. Ahí
apareció lo importante:

**Trazos e imágenes comparten exactamente la misma cabecera de elemento:**

```
[3, <estilo>, UUID, null, null, 0, <timestamp>, MATRIZ, false, <int>]
                                                 ^ índice 7
```

El parser leía esa matriz **solo para las imágenes**. Medido sobre el corpus:
**9.813 de 32.085 trazos (30,6%) tenían matriz distinta de identidad** — todos
mal ubicados. En un archivo eran el 73,7%.

También apareció que el `.concepts` trae dos entradas que ignorábamos por
completo: **`workspace.pack`** (estado de UI + la cámara guardada: pan, zoom y
rotación de vista en *vueltas*) y `resource.pack`.

## 4. La verdad de referencia que destrabó todo

El problema de método era no tener contra qué comparar. Las métricas indirectas
("¿cuántos trazos caen sobre alguna imagen?") son demasiado gruesas: un trazo
puede estar dentro de la caja del plano y aun así en el lugar equivocado.

La solución fue usar el **`thumb.jpg` que la propia app deja adentro de cada
archivo** y comparar **proporciones**. Eso permitió resolver la última incógnita:
las anotaciones debían caer entre el 32% y el 75% del ancho de la hoja; tratando
la traslación como esquina caían al 80-100%, y como **centro** caen al 26-66%.

**Trampa importante:** el `thumb.jpg` tiene lienzo de tamaño FIJO (1024×640 o
640×1024) con el dibujo encajado adentro, así que su *proporción* no dice nada de
la del documento. Se probó usarla como métrica y da veredictos al azar.

## 5. Los tres errores (y por qué se tapaban entre sí)

1. **La matriz del trazo se ignoraba.** Concepts no reescribe los puntos al
   mover/rotar/escalar: actualiza esa matriz. 30,6% de los trazos afectados.
2. **La conversión de ejes negaba las dos coordenadas** (rotar 180°) cuando el
   documento solo necesita invertir Y. La diferencia es un **espejo** — de ahí el
   texto al revés. Además, las matrices de recurso vienen con **X invertida**
   respecto del espacio de los puntos de los trazos.
3. **La matriz posiciona el CENTRO del recurso, no la esquina.** Ese era el
   desfase de ~800 unidades. La resta correcta ya existía en el código pero
   condicionada a que la matriz no tuviera rotación ni escala — y un plano
   insertado casi siempre viene rotado 90° a media escala, así que nunca corría
   donde hacía falta.

**Por qué costó tanto:** arreglar uno solo empeora el resultado. Corregís los
trazos y se espejan los planos; corregís los planos y se espejan los trazos.
Encima las imágenes, al dibujarse como bitmap, recibían un volteo que les
cancelaba media vuelta y las hacía *parecer* correctas — lo que llevó a la
conclusión razonable pero falsa de que el documento venía girado 180°.

**Trampa de índices que costó una iteración entera:** en la matriz 4×4 la afín 2D
vive en `[0]=a [1]=b [4]=c [5]=d [12]=e [13]=f`. Componer con `diag(1,-1)` niega
b, d, f = índices **1, 5, 13** (no el 4, que es `c`). Negar el 4 produce un
espejado sutil que parece un problema de posición.

## 6. Qué se cambió

- Se aplica la matriz del elemento a los puntos del trazo, y se escala el grosor
  por `sqrt(|det|)`.
- Conversión de ejes unificada: `(x,-y)` para trazos, `aCanvasTransform(espejarX(M))`
  para recursos.
- Colocación centrada siempre.
- Imágenes anidadas dentro de grupos: antes desaparecían en silencio.
- Compensación EXIF también en el camino de recorte por zoom.
- Se retiraron las dos heurísticas compensatorias.
- Se lee la cámara guardada de `workspace.pack` y las matrices de capa.
- **Texto (ítem tipo 13)**: antes se descartaba entero. Ahora se dibuja.

**Lo que se investigó y se descartó con datos:** componer la segunda matriz de
imagen. Probados los dos órdenes, empeora en 94 archivos contra 51 (36,4% → 27,4%
de trazos sobre su imagen). No es una matriz de colocación.

## 7. Verificación

- **Corpus completo: 176 archivos, 0 fallos**, 141.287 trazos, 2.368 imágenes,
  con el parser real (no una reimplementación).
- De los 9 archivos con "trazos voladores", **6 quedaron en cohesión 0,0000** y 2
  mejoraron. Empeora levemente en 5 — anotado, no barrido bajo la alfombra.
- Validado visualmente contra el `thumb.jpg` oficial en HO/Drawing, Submuración,
  Palier y Luminarias.
- **Verificado en producción** (`unx-concept.vercel.app`), no solo local.

Herramientas nuevas en `web-viewer/scripts/`:
- `test-corpus.mjs` — corre el parser **real** sobre todo el corpus.
- `verificar-geometria.mjs` — decodifica `tree.pack` **sin** el visor, a propósito:
  si compartiera código, un error del parser se vería "correcto" en su propio test.
- `cap-comparar.mjs` — captura una ruta y extrae al lado el `thumb.jpg` oficial.

## 8. Qué falta (auditoría honesta)

| Qué | Estado |
|---|---|
| **Contenido de las fotos (tipo 7) espejado** | **Bug abierto.** Los PDF (tipo 8) están bien. Se comprobó que quitarles el espejo de la matriz NO es la solución: la foto se despega de su etiqueta, o sea que la ubicación es correcta y falta voltear el bitmap. |
| Presión y tilt del lápiz | Se parsean, no se usan: grosor constante. |
| Pinceles con textura | La app tiene texturas reales; nosotros líneas planas. |
| 2ª matriz de imagen | Presente en ~99%, sin usar (ver arriba). |
| `resource.pack` | Sin usar. |
| Modos de fusión de capa | No se leen del archivo. |

Fuera de alcance por diseño (viven en el motor nativo): editar, exportar a
PSD/DXF/SVG, reconocimiento de formas, librería de objetos, herramientas de
precisión.

## 9. Conclusión

El visor no fallaba por un error de cálculo sino por **descartar datos que el
archivo ya traía**. Los tres errores eran independientes pero se enmascaraban
mutuamente, y ninguna métrica indirecta alcanzaba para separarlos: hizo falta
comparar contra el render que la propia app deja adentro de cada archivo.

Y el aporte del APK fue el mapa, no la prueba: sirvió para saber **dónde no
buscar** (el formato no está en el Java) y para confirmar la hipótesis con los
símbolos del binario. La evidencia decisiva salió de medir el formato real.
