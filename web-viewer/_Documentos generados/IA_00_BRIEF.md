# web-viewer — Mapa IA (Web · frontend)

102 archivos propios (18.835 líneas), 0 vendor. Módulos ES (`import`/`export`).

## Capas (por carpeta)
| Capa | Archivos | Rol dominante |
|---|---|---|
| `scripts` | 60 | script |
| `Gallery` | 15 | src |
| `src` | 8 | src |
| `VisorConcept` | 8 | src |
| `(raíz)` | 6 | throwaway — **ruido: ignorar salvo pedido explícito** |
| `scratch` | 4 | test |
| `supabase` | 1 | src |

**61 archivos clasificados como `script`/`throwaway`** (scripts sueltos de migración y prueba): no forman parte del producto. `grep '"role"' IA_20_INDICE.jsonl` para verlos.

## Entrypoints
- `index.html`

## Hubs (quién define los globals que todos leen)
- `scripts/e2e-viewer.mjs` — define `__f`, `__stop`; **1 archivos dependen de eso**
- `scripts/gen-thumbnails.mjs` — define `__cs`; **1 archivos dependen de eso**

## PWA
Service Worker ``.
**Avisos:**
- el manifest no declara `icons`: la PWA no es instalable
Detalle → `WEB_60_PWA.json`.

## Cómo usar estos archivos
1. Archivo o símbolo → `grep '"i":"ruta/archivo.js"' IA_20_INDICE.jsonl`
2. ¿Qué rompo si renombro un global? → `grep '"gr":\[[^]]*NombreGlobal' IA_30_GRAFO.jsonl`
3. Impacto → `grep '"i":"ruta/archivo.js"' IA_35_INVERSO.jsonl`
4. Bugs de DOM/CSS ya cruzados → `grep '"ok":false' WEB_45_DOM.jsonl WEB_50_ESTILOS.jsonl`
5. Costo de cada archivo del OUT → `IA_10_MANIFIESTO.json`
6. **Antes de afirmar algo: `IA_90_HUECOS.jsonl`.**

## Leyenda
`role` src/test/script/throwaway/vendor · `layer` carpeta · `gw` globals que ESCRIBE · `gr` globals que LEE · `dyn` cargas dinámicas · `wk` workers · `st` claves de storage · `srv` rutas que sirve · `fi` fan-in · `fn` funciones como `[nombre, línea, params, flags]` · `ld` orden real de carga.
