// Vuelca, ya decodificado con el ExtensionCodec real (UUIDs como string,
// matrices de 16 como array de numeros), el item de tipo 8/7 completo y las
// capas, para buscar a mano algun campo de posicion que el parser de
// produccion no este usando.

import { ZipArchive, RemoteSource } from "../../src/VisorConcept/zip";
import { decode, ExtensionCodec } from "@msgpack/msgpack";

function dummyEncode(): Uint8Array {
  return new Uint8Array();
}

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: 1,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 2,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 4,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true), view.getFloat32(12, true)];
  },
});
extensionCodec.register({
  type: 5,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const hex = Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});
extensionCodec.register({
  type: 7,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const m: number[] = [];
    for (let i = 0; i < 16; i++) m.push(view.getFloat32(i * 4, true));
    return m;
  },
});

function resumir(o: any, prof = 0, maxProf = 10): any {
  if (prof > maxProf) return "…";
  if (o instanceof Uint8Array) return `<bytes ${o.length}>`;
  if (Array.isArray(o)) {
    if (o.length > 20) return `[${o.length}: ${o.slice(0, 10).map((x) => resumir(x, prof + 1, maxProf)).join(", ")}, …]`;
    return `[${o.map((x) => resumir(x, prof + 1, maxProf)).join(", ")}]`;
  }
  if (o && typeof o === "object") {
    const ks = Object.keys(o).slice(0, 12);
    return `{${ks.map((k) => `${k}: ${resumir((o as any)[k], prof + 1, maxProf)}`).join(", ")}}`;
  }
  if (typeof o === "string") return o.length > 50 ? `"${o.slice(0, 50)}…"` : `"${o}"`;
  if (typeof o === "number") return String(+o.toFixed(3));
  return String(o);
}

export async function dump(url: string, headers: Record<string, string>) {
  const source = await RemoteSource.open(url, headers);
  const zip = await ZipArchive.open(source);
  const nombreTree = zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) return { error: "sin tree.pack" };
  const bytes = await zip.read(nombreTree);
  const tree: any = decode(bytes, { extensionCodec });

  // Busca todos los items de tipo 7 u 8 (imagenes colocadas) en cualquier
  // profundidad, y los vuelca enteros.
  const encontrados: string[] = [];
  const visitar = (o: any, prof: number) => {
    if (prof > 40) return;
    if (Array.isArray(o)) {
      if (o.length >= 1 && (o[0] === 7 || o[0] === 8) && Array.isArray(o[1])) {
        encontrados.push(resumir(o, 0, 14));
      }
      for (const x of o) visitar(x, prof + 1);
    }
  };
  visitar(tree, 0);
  return { encontrados };
}
