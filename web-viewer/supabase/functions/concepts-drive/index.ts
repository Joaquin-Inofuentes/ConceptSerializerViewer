// Proxy publico (sin API key) para leer una carpeta publica de Google Drive
// (con subcarpetas anidadas) y descargar archivos .concepts desde ella.
// Usado por ConceptSerializer web-viewer para listar y abrir dibujos sin
// pasar por Drive API/OAuth.
//
// Solo la carpeta RAIZ se hardcodea del lado del cliente (ver src/config.ts);
// tanto el listado de archivos como el de subcarpetas se resuelven en vivo
// aca para cualquier folderId (raiz o subcarpeta), asi que altas/bajas de
// archivos O carpetas se reflejan solas en el proximo listado.
//
// GET ?action=list&folderId=...     -> { ok, folders: [{id,name}], files: [{id,name,modifiedAt,hasTime}] }
//   files viene ordenado del mas reciente al mas viejo (por modifiedAt).
// GET ?action=download&fileId=...   -> bytes crudos del archivo (application/octet-stream)
//
// Desplegado en Supabase (proyecto kuhcxzusnrttkywgalgk) via el MCP de
// Supabase; este archivo es la copia versionada en git, no se autodespliega
// desde aca — si se edita hay que redesplegar manualmente con
// deploy_edge_function o el Supabase CLI.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type EntradaDrive = {
  id: string;
  nombre: string;
  esCarpeta: boolean;
  modificadoTexto: string | null;
};

// Mismo parseo por bloques que usa recuperar-plano-drive: mas robusto que
// un regex monolitico contra el HTML minificado que devuelve Drive.
function parsearCarpeta(html: string): EntradaDrive[] {
  const salida: EntradaDrive[] = [];
  const bloques = html.split('<div class="flip-entry" id="entry-').slice(1);
  for (const bloque of bloques) {
    const idm = /^([^"]+)"/.exec(bloque);
    const hrefm = /href="([^"]+)"/.exec(bloque);
    const titm = /<div class="flip-entry-title">([^<]*)<\/div>/.exec(bloque);
    if (!idm || !hrefm || !titm) continue;
    const modm = /<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/.exec(bloque);
    salida.push({
      id: idm[1],
      nombre: titm[1],
      esCarpeta: hrefm[1].includes("/drive/folders/"),
      modificadoTexto: modm ? modm[1].trim() : null,
    });
  }
  return salida;
}

async function listarCarpetaPublica(folderId: string): Promise<EntradaDrive[]> {
  // hl=en fuerza nombres de mes en ingles para poder parsearlos de forma
  // deterministica (sin esto Drive devuelve el idioma segun geo/headers).
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}&hl=en#list`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Drive folder ${r.status}`);
  return parsearCarpeta(await r.text());
}

// --- Hora real de modificacion (no solo fecha) ---------------------------
// La vista publica "embeddedfolderview" usada arriba solo expone hora real
// ("HH:MM AM/PM") para archivos modificados HOY; para el resto solo da el
// dia. La pagina PUBLICA (sin login) de la carpeta completa en cambio trae
// embebido un blob JS interno (window['_DRIVE_ivd']) con metadata cruda por
// archivo, incluyendo un timestamp real en milisegundos — sin API key ni
// OAuth, es la misma carpeta publica, solo que la pagina completa en vez
// de la vista embebida. Es un formato interno no documentado (puede romper
// si Google cambia el frontend), asi que esto es una mejora "best effort":
// si falla o no matchea, se sigue con el fallback de solo-fecha de arriba.
//
// Verificado empiricamente: cada fila trae dos timestamps consecutivos
// (viewedByMeTime, modifiedTime); el segundo es el que coincide con la
// fecha que ya de por si informa la vista embebida, asi que es el que se usa.
function decodeHexEscapes(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function fetchIvdModifiedTimes(folderId: string): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const r = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return map;
    const html = await r.text();
    const blobMatch = /_DRIVE_ivd'\]\s*=\s*'((?:\\.|[^'\\])*)'/.exec(html);
    if (!blobMatch) return map;
    const decoded = decodeHexEscapes(blobMatch[1]);
    // Cada fila: ["id",["parentFolderId"],"nombre","mimeType",N,(null|N),N,N,N,VIEWED_MS,MODIFIED_MS,...
    const rowRe = /\["([\w-]{15,})",\[[^\]]*\],"((?:\\.|[^"\\])*)","([^"]*)",\d+,(?:null|\d+),\d+,\d+,\d+,(\d+),(\d+),/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(decoded)) !== null) {
      const id = m[1];
      const modifiedMs = parseInt(m[5], 10);
      if (Number.isFinite(modifiedMs) && modifiedMs > 0) {
        map[id] = modifiedMs;
      }
    }
  } catch (_e) {
    // Best-effort: si falla (timeout, formato cambiado, etc.) seguimos con
    // el fallback de solo-fecha, no rompe el listado.
  }
  return map;
}

const MESES: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Fallback cuando no se pudo resolver la hora real via _DRIVE_ivd: Drive
// (vista publica, sin login) solo expone "HH:MM AM/PM" para archivos
// modificados hoy, "Mon D" para el resto del año en curso, o "Mon D, YYYY"
// para años anteriores.
function parsearFechaModificado(texto: string | null, ahora: Date): { iso: string | null; hasTime: boolean } {
  if (!texto) return { iso: null, hasTime: false };
  const t = texto.trim();

  const horaMatch = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t);
  if (horaMatch) {
    let h = parseInt(horaMatch[1], 10) % 12;
    if (horaMatch[3].toUpperCase() === "PM") h += 12;
    const min = parseInt(horaMatch[2], 10);
    const d = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), h, min));
    return { iso: d.toISOString(), hasTime: true };
  }

  let m = /^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/.exec(t);
  if (m) {
    const mes = MESES[m[1].toLowerCase()];
    if (mes) return { iso: `${m[3]}-${mes}-${m[2].padStart(2, "0")}T00:00:00.000Z`, hasTime: false };
  }

  m = /^([A-Za-z]{3})\w*\s+(\d{1,2})$/.exec(t);
  if (m) {
    const mes = MESES[m[1].toLowerCase()];
    if (mes) return { iso: `${ahora.getUTCFullYear()}-${mes}-${m[2].padStart(2, "0")}T00:00:00.000Z`, hasTime: false };
  }

  return { iso: null, hasTime: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "solo GET" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (action === "list") {
      const folderId = url.searchParams.get("folderId") || "";
      if (!folderId) throw new Error("falta folderId");
      const ahora = new Date();
      const [entradas, ivdTimes] = await Promise.all([
        listarCarpetaPublica(folderId),
        fetchIvdModifiedTimes(folderId),
      ]);

      const folders = entradas
        .filter((e) => e.esCarpeta)
        .map((e) => ({ id: e.id, name: e.nombre }));

      const files = entradas
        .filter((e) => !e.esCarpeta)
        .map((e) => {
          const ivdMs = ivdTimes[e.id];
          if (ivdMs) {
            return { id: e.id, name: e.nombre, modifiedAt: new Date(ivdMs).toISOString(), hasTime: true };
          }
          const { iso, hasTime } = parsearFechaModificado(e.modificadoTexto, ahora);
          return { id: e.id, name: e.nombre, modifiedAt: iso, hasTime };
        })
        .sort((a, b) => {
          // Mas reciente primero; sin fecha reconocida va al final.
          if (!a.modifiedAt && !b.modifiedAt) return 0;
          if (!a.modifiedAt) return 1;
          if (!b.modifiedAt) return -1;
          return b.modifiedAt.localeCompare(a.modifiedAt);
        });

      return new Response(JSON.stringify({ ok: true, folders, files }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (action === "download") {
      const fileId = url.searchParams.get("fileId") || "";
      if (!fileId) throw new Error("falta fileId");
      const upstream = await fetch(
        `https://drive.google.com/uc?export=download&id=${fileId}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) },
      );
      if (!upstream.ok || !upstream.body) {
        throw new Error(`Drive download ${upstream.status}`);
      }
      const ct = upstream.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        // Drive devolvio la pagina de advertencia de virus/tamano en vez del archivo.
        throw new Error("Drive devolvio HTML en vez del archivo (interstitial)");
      }
      return new Response(upstream.body, {
        headers: {
          ...CORS,
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "action invalida (list|download)" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
