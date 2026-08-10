import JSZip from "jszip";
import { decode, ExtensionCodec } from "@msgpack/msgpack";

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Point {
  x: number;
  y: number;
  p: number; // pressure
  t1: number; // tilt1
  t2: number; // tilt2
}

export interface Stroke {
  id: string;
  points: Point[];
  color: { r: number; g: number; b: number; a: number; hex: string };
  width: number;
  bbox: BBox;
}

export interface ImageElement {
  id: string;
  resourceId: string;
  blobUrl?: string;
  width: number;
  height: number;
  transform: number[];
}

export interface Layer {
  id: string;
  index: number;
  strokes: Stroke[];
  images: ImageElement[];
}

export interface Document {
  layers: Layer[];
  bbox: BBox;
  resources: Record<string, Blob>;
}

const extensionCodec = new ExtensionCodec();
const dummyEncode = () => new Uint8Array();

extensionCodec.register({
  type: 0,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
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
    return [
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
      view.getFloat32(12, true),
    ];
  },
});
extensionCodec.register({
  type: 5,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});
extensionCodec.register({
  type: 7,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const m = [];
    for (let i = 0; i < 16; i++) {
      m.push(view.getFloat32(i * 4, true));
    }
    return m;
  },
});

function rgbaToHex(r: number, g: number, b: number, a: number) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const hexR = Math.round(clamp(r) * 255).toString(16).padStart(2, "0");
  const hexG = Math.round(clamp(g) * 255).toString(16).padStart(2, "0");
  const hexB = Math.round(clamp(b) * 255).toString(16).padStart(2, "0");
  const hexA = Math.round(clamp(a) * 255).toString(16).padStart(2, "0");
  return `#${hexR}${hexG}${hexB}${hexA}`;
}

export async function parseConceptsFile(fileBuffer: ArrayBuffer): Promise<Document> {
  const zip = await JSZip.loadAsync(fileBuffer);
  
  const resources: Record<string, Blob> = {};
  
  if (zip.file("resource.pack")) {
    const resData = await zip.file("resource.pack")!.async("uint8array");
    const rp = decode(resData, { extensionCodec }) as any;
    const mapa = (Array.isArray(rp) && rp.length > 1) ? rp[1] : {};
    
    // Fallback iteration
    if (mapa) {
        let keys = Object.keys(mapa);
        for (const k of keys) {
            const ruuid = k;
            const filename = Object.keys(zip.files).find(n => n.replace(/-/g, "").includes(ruuid.replace(/-/g, "")));
            if (filename) {
                const fileBlob = await zip.file(filename)!.async("blob");
                resources[ruuid] = fileBlob;
            }
        }
    }
  }

  if (!zip.file("tree.pack")) {
    throw new Error("No se encontró tree.pack en el archivo.");
  }
  const treeData = await zip.file("tree.pack")!.async("uint8array");
  const tree = decode(treeData, { extensionCodec }) as any;

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;
  
  const layers: Layer[] = [];
  const globalBbox: BBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  if (Array.isArray(docData)) {
    const docCapas = docData.find(x => Array.isArray(x) && x.length > 0 && x.every(c => Array.isArray(c) && c.length > 0 && c[0] === 1));
    
    if (docCapas) {
      docCapas.forEach((capa: any, index: number) => {
        layers.push(procesarCapa(capa, index, globalBbox));
      });
    } else {
      const fallbackLayer: Layer = { id: "fallback", index: 0, strokes: [], images: [] };
      buscarElementos(docData, fallbackLayer, globalBbox);
      if (fallbackLayer.strokes.length > 0 || fallbackLayer.images.length > 0) {
        layers.push(fallbackLayer);
      }
    }
  }

  return { layers, bbox: globalBbox, resources };
}

function procesarCapa(nodo: any, idx: number, globalBbox: BBox): Layer {
  const hdr = nodo[1];
  let capaId = "";
  if (Array.isArray(hdr) && hdr.length > 1) {
     capaId = hdr[1]; 
  }
  
  const layer: Layer = { id: capaId, index: idx, strokes: [], images: [] };
  
  const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
  for (const item of items) {
    procesarItem(item, layer, globalBbox);
  }
  return layer;
}

function procesarItem(item: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(item) || item.length === 0) return;
  
  const tipo = item[0];
  const cuerpo = item.length > 1 ? item[1] : null;
  
  if (tipo === 8 && Array.isArray(cuerpo)) {
    const interno = Array.isArray(cuerpo) && cuerpo.length > 1 && Array.isArray(cuerpo[1]) ? cuerpo[1] : [];
    
    let elementoId = "";
    const u = interno.find(x => typeof x === "string" && x.includes("-"));
    if (u) elementoId = u;
    
    let resourceId = "";
    const ru = cuerpo.find(x => typeof x === "string" && x.includes("-"));
    if (ru) resourceId = ru;
    
    let width = 0, height = 0;
    const tam = cuerpo.find(x => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
    if (tam) { width = tam[0]; height = tam[1]; }
    
    let transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const mat = interno.find(x => Array.isArray(x) && x.length === 16);
    if (mat) transform = mat;
    
    layer.images.push({
      id: elementoId,
      resourceId,
      width,
      height,
      transform
    });
    
  } else if (tipo === 1 && item.length > 1 && Array.isArray(item[1]) && item[1].length > 0 && item[1][0] === 4) {
    // subcapa
  } else {
    buscarElementos(item, layer, globalBbox);
  }
}

function buscarElementos(o: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(o)) return;
  
  const blobs = o.filter(x => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);
  
  if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
    emitirTrazo(o, blobs[0], layer, globalBbox);
    return;
  }
  
  for (const x of o) {
    buscarElementos(x, layer, globalBbox);
  }
}

function emitirTrazo(o: any, blob: Uint8Array, layer: Layer, globalBbox: BBox) {
  const hdr = o[1];
  
  const stroke: Stroke = {
    id: "",
    points: [],
    color: { r: 0, g: 0, b: 0, a: 1, hex: "#000000" },
    width: 1,
    bbox: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  };
  
  try {
    const bw = hdr[1][1];
    const core = bw[1];
    const col = core[2];
    if (Array.isArray(col) && col.length >= 4) {
      stroke.color = {
        r: col[0], g: col[1], b: col[2], a: col[3],
        hex: rgbaToHex(col[0], col[1], col[2], col[3])
      };
    }
    stroke.width = bw[3] || 1;
  } catch {
    // fallback
  }
  
  const u = hdr.find((x: any) => typeof x === "string" && x.includes("-"));
  if (u) stroke.id = u;
  
  const n = Math.floor(blob.length / 16);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  
  for (let i = 0; i < n; i++) {
    const x = view.getFloat32(i * 16, true);
    const y = view.getFloat32(i * 16 + 4, true);
    const p = view.getUint16(i * 16 + 8, true);
    const t1 = view.getUint16(i * 16 + 10, true);
    const t2 = view.getUint16(i * 16 + 12, true);
    
    stroke.points.push({ x, y, p, t1, t2 });
    
    if (x < stroke.bbox.minX) stroke.bbox.minX = x;
    if (x > stroke.bbox.maxX) stroke.bbox.maxX = x;
    if (y < stroke.bbox.minY) stroke.bbox.minY = y;
    if (y > stroke.bbox.maxY) stroke.bbox.maxY = y;
    
    if (x < globalBbox.minX) globalBbox.minX = x;
    if (x > globalBbox.maxX) globalBbox.maxX = x;
    if (y < globalBbox.minY) globalBbox.minY = y;
    if (y > globalBbox.maxY) globalBbox.maxY = y;
  }
  
  layer.strokes.push(stroke);
}
