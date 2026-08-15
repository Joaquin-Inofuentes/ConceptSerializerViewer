# Síntomas → grep exacto → sospechosos

El agente entra por acá. Cada fila trae el comando listo; el costo es ~1 línea de resultado por grep.
**Regla previa a todo: si `IA_90_HUECOS.jsonl` menciona el archivo que vas a tocar, el mapa está incompleto ahí — leé el fuente.**

| Síntoma | Comando | Qué devuelve |
|---|---|---|
| Vi un texto/error en la consola | `grep -F "trozo del mensaje" IA_60_LOGS.jsonl` | archivo:línea + método que lo emite |
| Falla algo de `[error]` | `grep '"t":"error"' IA_60_LOGS.jsonl` | todos los logs de ese subsistema, con línea |
| Falla algo de `[console]` | `grep '"t":"console"' IA_60_LOGS.jsonl` | todos los logs de ese subsistema, con línea |
| Falla algo de `[page error]` | `grep '"t":"page error"' IA_60_LOGS.jsonl` | todos los logs de ese subsistema, con línea |
| Falla algo de `[carpeta]` | `grep '"t":"carpeta"' IA_60_LOGS.jsonl` | todos los logs de ese subsistema, con línea |
| Falla algo de `[/]` | `grep '"t":"/"' IA_60_LOGS.jsonl` | todos los logs de ese subsistema, con línea |
| ¿Dónde está el símbolo X? / ¿ya existe algo llamado *X*? | `grep -iP '^X\t' IA_15_SIMBOLOS.tsv` (o `grep -i x` para parcial) | 1 línea con path:línea exacta |
| Va lento / se traba en el celular | `head -6 IA_55_COSTOS.jsonl` | top 5 de costo runtime con `why` y `fix` |
| ¿Cómo llega la ejecución hasta acá? | `grep '"id":"' IA_42_CADENAS.jsonl` | cadenas entrypoint→fin precomputadas |
| Un endpoint devuelve error / ¿qué API hay? | `grep '"s":"/ruta' WEB_40_ENDPOINTS.jsonl` | handler con archivo:línea |
| Me pasaron un código de error (MIP-xxx / ERR_*) | `grep '"c":"CODIGO"' WEB_70_ERRORES.jsonl` | dónde se declara y dónde se dispara |
| Offline roto / no instala / caché vieja | leer `WEB_60_PWA.json` (es chico) | warnings de SW, precache e íconos |
| Un handler del HTML no responde | `grep '"ok":false' WEB_45_DOM.jsonl` | ids y handlers rotos |
| Anduvo ayer y hoy no | `head IA_95_DELTA.jsonl` | qué cambió desde la corrida anterior |
| "Esto debería funcionar y no funciona" | `IA_90_HUECOS.jsonl` primero, SIEMPRE | lo que el mapa sabe que no sabe |
