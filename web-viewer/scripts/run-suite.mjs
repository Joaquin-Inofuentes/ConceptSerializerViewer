// Corre toda la bateria de tests contra una URL (por defecto produccion),
// cronometra cada uno y deja un informe en markdown con los tiempos y el
// resultado. Es lo que hay que ejecutar para responder "¿sigue andando bien?"
// despues de un deploy.
//
//   node scripts/run-suite.mjs                      (contra produccion)
//   BASE_URL=http://localhost:5173 node scripts/run-suite.mjs
//   SOLO=e2e,diag node scripts/run-suite.mjs        (subconjunto)

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "https://unx-concept.vercel.app";
const OUT_DIR = path.resolve(".cache");
const INFORME = path.join(OUT_DIR, "informe-tests.md");
const SOLO = (process.env.SOLO || "").split(",").filter(Boolean);

// `arranque` sirve el build local: mide el arranque del bundle sin depender
// del CDN, y por eso no toma BASE_URL. El resto pega contra la URL real.
const TESTS = [
  {
    id: "diag",
    nombre: "Cache de rasterizados (worker + IndexedDB)",
    script: "scripts/diag-cache.mjs",
    que: "Confirma que el rasterizado va al worker y que reabrir usa el cache guardado.",
  },
  {
    id: "e2e",
    nombre: "Gama baja: 3 mas pesados (CPU 6x, 360x700)",
    script: "scripts/e2e-gama-baja.mjs",
    env: { TOP: "3", THROTTLE: "6" },
    que: "Hitos de apertura, FPS con pan/zoom bruscos, fugas de RAM a 20 s y al cambiar de dibujo.",
  },
  {
    id: "reapertura",
    nombre: "Reapertura con cache persistente",
    script: "scripts/bench-reapertura.mjs",
    que: "Cuanto se gana al abrir por segunda vez un dibujo ya visto.",
  },
  {
    id: "capturas",
    nombre: "Capturas visuales",
    script: "scripts/captura-visual.mjs",
    env: { TOP: "3" },
    que: "Confirma A OJO que los planos se ven (las metricas de pixeles no alcanzan).",
  },
  {
    id: "export",
    nombre: "Export del visor (PNG/JPG/PDF)",
    script: "scripts/e2e-export.mjs",
    que: "Los tres formatos bajan, pesan lo razonable y no salen en blanco.",
  },
  {
    id: "galeria",
    nombre: "Galeria: navegacion y miniaturas",
    script: "scripts/e2e-galeria.mjs",
    que: "Navegar el arbol de carpetas y que las miniaturas carguen nitidas.",
  },
  {
    id: "descargaPdf",
    nombre: "Descarga multiple de galeria (PDF)",
    script: "scripts/e2e-descarga-galeria.mjs",
    args: ["Fede y Franco/Concepts/V1", "pdf"],
    que: "Varios dibujos seleccionados -> un PDF con secciones.",
  },
  {
    id: "descargaZip",
    nombre: "Descarga multiple de galeria (ZIP)",
    script: "scripts/e2e-descarga-galeria.mjs",
    args: ["Fede y Franco/Concepts/V1", "jpg"],
    que: "Varios dibujos seleccionados -> un .zip con un JPG por dibujo.",
  },
  {
    id: "arranque",
    nombre: "Arranque en frio (build local, CPU 6x + Fast 3G)",
    script: "scripts/bench-arranque.mjs",
    sinBaseUrl: true,
    que: "FCP y peso del JS inicial. Sirve dist/ localmente para aislar el bundle del CDN.",
  },
];

function correr(t) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(t.env || {}) };
    if (!t.sinBaseUrl) env.BASE_URL = BASE_URL;
    const t0 = Date.now();
    const hijo = spawn(process.execPath, [t.script, ...(t.args || [])], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let salida = "";
    hijo.stdout.on("data", (d) => {
      const s = d.toString();
      salida += s;
      process.stdout.write(s);
    });
    hijo.stderr.on("data", (d) => {
      const s = d.toString();
      salida += s;
      process.stderr.write(s);
    });
    hijo.on("close", (code) => {
      resolve({ ...t, ms: Date.now() - t0, code, salida });
    });
  });
}

await mkdir(OUT_DIR, { recursive: true });
const aCorrer = SOLO.length ? TESTS.filter((t) => SOLO.includes(t.id)) : TESTS;

console.log(`Bateria contra ${BASE_URL}\n${aCorrer.length} tests\n`);
const inicio = Date.now();
const resultados = [];
for (const t of aCorrer) {
  console.log(`\n${"#".repeat(70)}\n# ${t.nombre}\n${"#".repeat(70)}`);
  const r = await correr(t);
  resultados.push(r);
  console.log(`\n>>> ${t.nombre}: ${(r.ms / 1000).toFixed(1)}s (exit ${r.code})`);
}
const totalMs = Date.now() - inicio;

const seg = (ms) => `${(ms / 1000).toFixed(1)} s`;
const min = (ms) => `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;

// Lineas que resumen cada test, para no tener que abrir el log entero.
function destacados(r) {
  const patrones = /placeholder |FPS |heap:|red:|crecimiento|1a vez|2a vez|rapido al reabrir|exportaciones ok|descargado:|FCP |Galeria montada|JS transferido|reapertura:|workers creados|cache en memoria|sin errores|ERRORES|FATAL/;
  return r.salida
    .split("\n")
    .filter((l) => patrones.test(l))
    .map((l) => l.trim())
    .slice(0, 14);
}

const lineas = [
  `# Informe de tests — ConceptSerializer`,
  ``,
  `- **URL probada:** ${BASE_URL}`,
  `- **Fecha:** ${new Date().toISOString()}`,
  `- **Duracion total:** ${min(totalMs)}`,
  `- **Resultado:** ${resultados.filter((r) => r.code === 0).length}/${resultados.length} tests en verde`,
  ``,
  `## Tiempos por test`,
  ``,
  `| Test | Duracion | Estado |`,
  `|---|---|---|`,
  ...resultados.map((r) => `| ${r.nombre} | ${seg(r.ms)} | ${r.code === 0 ? "OK" : `FALLO (exit ${r.code})`} |`),
  ``,
  `## Detalle`,
  ``,
];

for (const r of resultados) {
  lineas.push(`### ${r.nombre}`, ``, `_${r.que}_`, ``, `**Duracion:** ${seg(r.ms)} — **${r.code === 0 ? "OK" : `FALLO (exit ${r.code})`}**`, ``);
  const d = destacados(r);
  if (d.length) lineas.push("```", ...d, "```", "");
}

await writeFile(INFORME, lineas.join("\n"));
console.log(`\n${"=".repeat(70)}`);
console.log(`TOTAL: ${min(totalMs)} — ${resultados.filter((r) => r.code === 0).length}/${resultados.length} en verde`);
resultados.forEach((r) => console.log(`  ${seg(r.ms).padStart(9)}  ${r.code === 0 ? "OK  " : "FALLO"}  ${r.nombre}`));
console.log(`\nInforme: ${INFORME}`);
