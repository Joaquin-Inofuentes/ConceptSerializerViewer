# Auditoria de los 23 "sospechosos" (overlap < 15%)

`node scripts/audit-alineacion-corpus.mjs` mide que % de trazos caen dentro de
la caja de ALGUNA imagen del mismo archivo. Es una metrica gruesa: penaliza
cualquier archivo donde las fotos/PDFs sean pocos y chicos frente a un dibujo
grande (plano completo con lineas por todos lados), que es el patron normal en
la mayoria de estos 176 archivos, no un indicio de bug.

## Metodo de esta revision

Para cada uno de los 23 se comparo la caja total de imagenes (`imgBox`) contra
la caja total de trazos (`trazoBox`): si ambas cajas se superponen a nivel
global, el dibujo y las fotos estan en la misma zona del mundo (no hay
rotacion/escala/traslacion global mal aplicada) y el overlap bajo es solo
"pocas fotos salpicadas en un plano grande". Si NO se superponen, es señal de
un bug real de colocacion.

## Resultado: 23/23 son falsos positivos de la metrica

En los 23 casos `imgBox` y `trazoBox` se superponen (confirmado
programaticamente, ver tabla abajo). Los dos con overlap mas dramatico casi 0%
son ejemplos claros del patron esperado:

- **Drawing.sync-conflict-...concepts (0.1%, 996 trazos, 1 imagen):** un solo
  PDF/foto de referencia en una esquina del plano; 996 trazos de dibujo cubren
  el resto de la hoja. `imgBox` 736x159 cae dentro del area cubierta por
  `trazoBox` 611x397 en la misma region.
- **Submuracion.concepts / Sobre Subsuelo.concepts (HO, 3.2%/11.6%):** ya
  documentado como falso positivo conocido — tira vertical multi-hoja, mismo
  patron que el resto.

Verificacion visual adicional en `Luminarias.concepts` (fuera de la lista de
sospechosos, pero mismo patron de "muchos trazos + pocas fotos"): la foto
`fc37e841` (235x177, un caño con cables saliendo del piso) se ve nitida, en su
posicion correcta debajo de la anotacion "NPT : +1.50", sin espejado —
consistente con el fix de espejado de fotos (commit `409157a`) funcionando
para todo el corpus, no solo el caso probado antes.

Ningun archivo de los 23 mostro `imgBox`/`trazoBox` en regiones separadas ni
proporciones de imagen inconsistentes con lo esperado. No se encontraron bugs
reales de geometria en este lote.

| archivo | overlap | trazos | imgs | imgBox | trazoBox | cajas se superponen |
|---|---|---|---|---|---|---|
| Drawing.sync-conflict-20260126-164034-Q4WQSO5 | 0.1% | 996 | 1 | 736x159 | 611x397 | si |
| Bañeras De Todos Los Pisos | 2% | 50 | 5 | 1564x2231 | 572x1167 | si |
| AF- CALCULO DE ANCLAJES 1ER Y 2DO.sync-conflict-20260226-105001 | 2.3% | 610 | 1 | 1246x266 | 1079x409 | si |
| Submuracion | 3.2% | 7119 | 26 | 26031x28443 | 49663x25588 | si |
| AF- CALCULO DE ANCLAJES 1ER Y 2DO | 4% | 847 | 1 | 1246x266 | 1113x419 | si |
| Baños | 4% | 124 | 2 | 727x1063 | 652x944 | si |
| 0.Base | 5% | 20 | 5 | 6240x9821 | 5773x2643 | si |
| Drawing 4 (Fran y fede) | 6.8% | 74 | 2 | 484x292 | 441x139 | si |
| RO- 1er Iluminacion | 7.4% | 189 | 7 | 742x235 | 182x225 | si |
| MA- CARPINTERIAS | 7.5% | 914 | 4 | 6762x3829 | 3900x4079 | si |
| Electricidad 1 er Piso | 7.6% | 461 | 11 | 3346x1236 | 3171x911 | si |
| Drawing 2.sync-conflict-20260728-143511-CIY5VAJ | 7.8% | 103 | 1 | 4214x1156 | 2123x555 | si |
| Drawing (MARIANO ACHA, 1er PISO) | 8.6% | 93 | 3 | 3330x6922 | 3938x5608 | si |
| AA DE 1er Y 2do | 9.3% | 182 | 5 | 4665x1052 | 864x586 | si |
| RO- MEDICION DE MARCOS | 10% | 260 | 1 | 924x1304 | 800x1278 | si |
| Colocación 2do | 10.2% | 118 | 6 | 1487x987 | 1256x798 | si |
| RO- 3ro Replanteo Y Electricidad | 10.3% | 349 | 5 | 5791x3393 | 4277x2638 | si |
| Drawing 4 (V2) | 10.3% | 29 | 1 | 5197x1544 | 3105x1219 | si |
| Hormigón Visto | 11.1% | 27 | 11 | 1094x1853 | 575x2432 | si |
| LINEAS DE ESTACIONAMIENTO | 11.5% | 52 | 1 | 6237x1544 | 1282x614 | si |
| Sobre Subsuelo | 11.6% | 2765 | 12 | 6007x15785 | 11992x20643 | si |
| Drawing 6 (Fran y fede) | 11.6% | 146 | 2 | 484x292 | 441x139 | si |
| Drawing 2 (ACUÑA DE FIGUEROA, AF- hormigon losa 4 piso) | 14.2% | 487 | 2 | 7279x3545 | 5190x3073 | si |

## No fixes aplicados a geometria/render

No se toco `parser.ts`, `renderCore.ts` ni `Viewer.tsx` en esta revision: no
hizo falta, no hay bug real que corregir en estos 23 archivos.
