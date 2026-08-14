// Vuelca la ESTRUCTURA del arbol de un .concepts: que tipos de item hay en
// cada capa y a que profundidad. Sirve cuando un archivo trae recursos
// embebidos pesados pero el parser no encuentra ninguna imagen colocada: casi
// siempre significa que ese archivo usa una forma del arbol que el parser no
// contempla (otra version de Concepts, subcapas, agrupaciones).

import { openConceptsRemote } from "../../src/VisorConcept/parser";
import { ZipArchive, RemoteSource } from "../../src/VisorConcept/zip";
import { decode } from "@msgpack/msgpack";

export async function auditarEstructura(url: string, headers: Record<string, string>) {
  // Se relee el tree.pack crudo para poder mirar el arbol sin el filtro del
  // parser (que es justamente lo que se esta poniendo en duda).
  const source = await RemoteSource.open(url, headers);
  const zip = await ZipArchive.open(source);
  const nombreTree = zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) return { error: "sin tree.pack" };
  const bytes = await zip.read(nombreTree);
  const tree: any = decode(bytes);

  const entradasZip = zip.names().map((n) => ({ n, kb: Math.round((zip.get(n)?.compressedSize || 0) / 1024) }));
  const recursosZip = entradasZip.filter((e) => e.kb > 64 && !/tree\.pack|thumb/i.test(e.n));

  // Recorrido generico: cuenta los `item[0]` de todo array que parezca un
  // item ([tipo, cuerpo]) y anota los uuid que aparecen sueltos.
  const tipos = new Map<number, number>();
  const uuids = new Set<string>();
  const matrices16 = { total: 0, ejemplos: [] as any[] };
  let profundidadMax = 0;

  // Un ejemplo por tipo, resumido, para poder ver como se representa cada uno.
  const ejemploPorTipo = new Map<number, string>();
  const resumir = (o: any, prof = 0, maxProf = 6): any => {
    if (prof > maxProf) return "…";
    if (o instanceof Uint8Array) return `<bytes ${o.length}>`;
    if (o instanceof Map) {
      // msgpack puede devolver mapas; hay que mirarlos porque ahi adentro
      // suele estar el uuid del recurso.
      const e = [...o.entries()].slice(0, 8);
      return `Map{${e.map(([k, v]) => `${resumir(k, prof + 1, maxProf)}: ${resumir(v, prof + 1, maxProf)}`).join(", ")}}`;
    }
    if (Array.isArray(o)) {
      if (o.length > 12) return `[${o.length}: ${o.slice(0, 6).map((x) => resumir(x, prof + 1, maxProf)).join(", ")}, …]`;
      return `[${o.map((x) => resumir(x, prof + 1, maxProf)).join(", ")}]`;
    }
    if (o && typeof o === "object") {
      const ks = Object.keys(o).slice(0, 10);
      return `{${ks.map((k) => `${k}: ${resumir((o as any)[k], prof + 1, maxProf)}`).join(", ")}}`;
    }
    if (typeof o === "string") return o.length > 44 ? `"${o.slice(0, 44)}…"` : `"${o}"`;
    if (typeof o === "number") return String(+o.toFixed(3));
    return String(o);
  };

  const visitar = (o: any, prof: number) => {
    if (prof > profundidadMax) profundidadMax = prof;
    if (typeof o === "string" && /[0-9a-f]{8}-[0-9a-f]{4}/i.test(o)) uuids.add(o);
    // Los uuid tambien pueden venir dentro de mapas/objetos, no solo en arrays.
    if (o instanceof Map) {
      for (const [k, v] of o) {
        visitar(k, prof + 1);
        visitar(v, prof + 1);
      }
      return;
    }
    if (o && typeof o === "object" && !Array.isArray(o) && !(o instanceof Uint8Array)) {
      for (const v of Object.values(o)) visitar(v, prof + 1);
      return;
    }
    if (!Array.isArray(o)) return;
    if (o.length === 16 && o.every((x) => typeof x === "number")) {
      matrices16.total++;
      if (matrices16.ejemplos.length < 3) matrices16.ejemplos.push(o.map((n) => +n.toFixed(2)));
    }
    if (o.length >= 1 && typeof o[0] === "number" && o.length <= 4) {
      tipos.set(o[0], (tipos.get(o[0]) || 0) + 1);
      if (!ejemploPorTipo.has(o[0])) ejemploPorTipo.set(o[0], resumir(o));
    }
    if (prof > 40) return; // corte de seguridad
    for (const x of o) visitar(x, prof + 1);
  };
  visitar(tree, 0);

  // Lo que ve el parser de verdad.
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();
  const porCapa = doc.layers.map((l, i) => ({
    capa: i,
    id: (l.id || "").slice(0, 8),
    trazos: l.strokes.length,
    imagenes: l.images.length,
  }));
  const vistoPorElParser = {
    capas: doc.layers.length,
    imagenes: doc.layers.reduce((n, l) => n + l.images.length, 0),
    recursoIds: doc.resourceIds.length,
  };
  doc.close();
  archivo.close();

  return {
    zip: {
      entradas: entradasZip.length,
      recursosPesados: recursosZip.length,
      MBrecursos: +(recursosZip.reduce((n, e) => n + e.kb, 0) / 1024).toFixed(1),
      muestraNombres: recursosZip.slice(0, 6).map((e) => `${e.n} (${e.kb}KB)`),
    },
    arbol: {
      profundidadMax,
      uuids: uuids.size,
      matrices16: matrices16.total,
      ejemplosMatriz: matrices16.ejemplos,
      tiposMasComunes: [...tipos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14),
      ejemplos: [...ejemploPorTipo.entries()]
        .sort((a, b) => (tipos.get(b[0]) || 0) - (tipos.get(a[0]) || 0))
        .slice(0, 8)
        .map(([t, s]) => `tipo ${t} (x${tipos.get(t)}): ${s.slice(0, 260)}`),
      uuidsMuestra: [...uuids].slice(0, 4),
    },
    parser: vistoPorElParser,
    porCapa,
  };
}
