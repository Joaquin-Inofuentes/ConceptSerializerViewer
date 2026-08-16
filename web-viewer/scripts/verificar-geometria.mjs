// Arnes de verificacion geometrica del formato .concepts.
//
// Decodifica `tree.pack` SIN pasar por el visor (ni Vite, ni navegador, ni
// pdf.js): lee el zip a mano y el MessagePack con la misma tabla de extension
// types que usa el parser. Eso es a proposito — si compartiera codigo con el
// visor, un error en el parser se veria "correcto" aca tambien.
//
// Para que sirve: cuando se toca la geometria (matrices, convencion de ejes)
// hay que poder decidir si un cambio mejora o empeora SIN mirar 200 dibujos a
// ojo. Estas son las dos metricas que resultaron utiles, y una que NO:
//
//   cohesion  — los trazos con matriz IDENTIDAD estan indiscutiblemente en
//               espacio mundo (nadie los movio). Se mide cuan lejos caen los
//               trazos CON matriz de esa region, normalizado por su diagonal.
//               Si un grupo entero "vuela", esto se dispara. Es la metrica que
//               detecta el bug de la matriz de trazo ignorada.
//   sobre-img — % de trazos cuyo centro cae sobre alguna imagen colocada.
//               Ruidosa por si sola (las anotaciones al margen son legitimas),
//               util solo como señal de cambio brusco.
//
//   NO USAR el aspecto del bbox contra el de thumb.jpg: el thumb tiene lienzo
//   de tamaño FIJO (1024x640 o 640x1024) con el dibujo encajado adentro, asi
//   que su proporcion no dice NADA de la proporcion del documento. Se probo y
//   da veredictos al azar.
//
//   node scripts/verificar-geometria.mjs            -> corre el corpus
//   node scripts/verificar-geometria.mjs <id|ruta>  -> un archivo, con detalle
//   node scripts/verificar-geometria.mjs --png <id> -> ademas escribe un PNG
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inflateRawSync, deflateSync } from "node:zlib";
import { decode, ExtensionCodec } from "@msgpack/msgpack";

const CACHE = path.resolve(".cache/concepts");

// ---------------------------------------------------------------- msgpack
const f32 = (d, n) => {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const o = [];
  for (let i = 0; i < n; i++) o.push(v.getFloat32(i * 4, true));
  return o;
};
export const codec = new ExtensionCodec();
for (const t of [0, 1, 2, 3]) codec.register({ type: t, encode: () => null, decode: (d) => ({ __e: t, v: f32(d, Math.min(4, d.length / 4)) }) });
codec.register({ type: 4, encode: () => null, decode: (d) => ({ __e: 4, v: f32(d, 4) }) });
codec.register({ type: 5, encode: () => null, decode: (d) => {
  const h = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { __uuid: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}` };
}});
codec.register({ type: 6, encode: () => null, decode: (d) => ({ __e: 6, v: f32(d, Math.min(8, d.length / 4)) }) });
codec.register({ type: 7, encode: () => null, decode: (d) => ({ __MAT: f32(d, 16) }) });
for (let t = 8; t < 40; t++) codec.register({ type: t, encode: () => null, decode: (d) => ({ __e: t, raw: d }) });

// ---------------------------------------------------------------- zip
function zipEntries(buf) {
  let eo = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error("zip sin EOCD");
  const n = buf.readUInt16LE(eo + 10);
  let off = buf.readUInt32LE(eo + 16);
  const out = new Map();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    out.set(buf.toString("utf8", off + 46, off + 46 + nl), { method, csize, lho });
    off += 46 + nl + el + cl;
  }
  return out;
}
function zipRead(buf, e) {
  const nl = buf.readUInt16LE(e.lho + 26), el = buf.readUInt16LE(e.lho + 28);
  const s = e.lho + 30 + nl + el;
  const raw = buf.subarray(s, s + e.csize);
  return e.method === 0 ? raw : inflateRawSync(raw);
}

// ---------------------------------------------------------------- geometria
export const esIdentidad = (m) =>
  Math.abs(m[0]-1)<1e-6 && Math.abs(m[1])<1e-6 && Math.abs(m[4])<1e-6 &&
  Math.abs(m[5]-1)<1e-6 && Math.abs(m[12])<1e-6 && Math.abs(m[13])<1e-6;
const aplicar = (m, x, y) => [m[0]*x + m[4]*y + m[12], m[1]*x + m[5]*y + m[13]];
/** Compone dos afines guardadas como matriz 4x4 (solo se usan 0,1,4,5,12,13). */
const componer = (A, B) => {
  const r = A.slice();
  r[0]=A[0]*B[0]+A[4]*B[1];  r[1]=A[1]*B[0]+A[5]*B[1];
  r[4]=A[0]*B[4]+A[4]*B[5];  r[5]=A[1]*B[4]+A[5]*B[5];
  r[12]=A[0]*B[12]+A[4]*B[13]+A[12];
  r[13]=A[1]*B[12]+A[5]*B[13]+A[13];
  return r;
};

/**
 * Extrae trazos e imagenes de un .concepts.
 *
 * `opciones.matrizTrazo` decide si se aplica la matriz del elemento a los
 * puntos del trazo — es exactamente la diferencia entre el bug y el arreglo,
 * y esta parametrizada para poder medir el antes/despues con el mismo codigo.
 */
export function leerDocumento(file, opciones = {}) {
  const { matrizTrazo = true, matriz2Imagen = true } = opciones;
  const buf = readFileSync(file);
  const ents = zipEntries(buf);
  const nt = [...ents.keys()].find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nt) return null;
  const dec = decode(zipRead(buf, ents.get(nt)), { extensionCodec: codec });
  const dd = Array.isArray(dec) && dec.length > 1 ? dec[1] : dec;
  const capas = Array.isArray(dd)
    ? dd.find((x) => Array.isArray(x) && x.length > 0 && x.every((c) => Array.isArray(c) && c.length > 0 && c[0] === 1))
    : null;

  const strokes = [], images = [];
  function rec(o) {
    if (!Array.isArray(o)) return;
    const t = o[0];
    // Trazo: tipo 6 con cabecera de elemento estandar en o[1].
    if (t === 6 && Array.isArray(o[1]) && o[1][0] === 3 && o[1][7] && o[1][7].__MAT) {
      const m = o[1][7].__MAT;
      const blob = o.find((x) => x instanceof Uint8Array && x.length >= 16 && x.length % 16 === 0);
      if (blob) {
        const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const n = Math.floor(blob.length / 16);
        const pts = [];
        for (let i = 0; i < n; i++) {
          const x = v.getFloat32(i*16, true), y = v.getFloat32(i*16+4, true);
          pts.push(matrizTrazo ? aplicar(m, x, y) : [x, y]);
        }
        strokes.push({ m, pts, identidad: esIdentidad(m) });
      }
      return;
    }
    // Imagen: tipo 7 (foto) u 8 (pdf); la cabecera esta un nivel mas adentro.
    if ((t === 7 || t === 8) && Array.isArray(o[1])) {
      const cu = o[1], hdr = cu[1];
      if (Array.isArray(hdr) && hdr[7] && hdr[7].__MAT) {
        const sz = cu.find((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number")
                || cu.find((x) => x && x.__e === 1)?.v;
        const segunda = cu.find((x, i) => i > 2 && x && x.__MAT);
        let m = hdr[7].__MAT;
        if (matriz2Imagen && segunda) m = componer(m, segunda.__MAT);
        if (sz) images.push({ m, w: sz[0], h: sz[1], tieneSegunda: !!segunda });
      }
      return;
    }
    for (const x of o) rec(x);
  }
  for (const c of (capas || [])) rec(c);
  return { strokes, images, capas: (capas || []).length };
}

const bboxDe = (pts) => {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const [x, y] of pts) { b.x0=Math.min(b.x0,x); b.x1=Math.max(b.x1,x); b.y0=Math.min(b.y0,y); b.y1=Math.max(b.y1,y); }
  return b;
};
const cajaImagen = (im) => bboxDe([[0,0],[im.w,0],[0,im.h],[im.w,im.h]].map(([x,y]) => aplicar(im.m,x,y)));

/** Metricas de un documento ya leido. */
export function metricas(doc) {
  const ident = doc.strokes.filter((s) => s.identidad);
  const movidos = doc.strokes.filter((s) => !s.identidad);
  const centro = (s) => { const b = bboxDe(s.pts); return [(b.x0+b.x1)/2, (b.y0+b.y1)/2]; };

  let cohesion = 0;
  if (ident.length >= 20 && movidos.length >= 1) {
    let R = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const s of ident) { const b = bboxDe(s.pts);
      R.x0=Math.min(R.x0,b.x0); R.x1=Math.max(R.x1,b.x1); R.y0=Math.min(R.y0,b.y0); R.y1=Math.max(R.y1,b.y1); }
    const diag = Math.hypot(R.x1-R.x0, R.y1-R.y0) || 1;
    const ds = movidos.map((s) => { const [x,y] = centro(s);
      return Math.hypot(Math.max(R.x0-x,0,x-R.x1), Math.max(R.y0-y,0,y-R.y1)) / diag; }).sort((a,b)=>a-b);
    cohesion = ds[Math.floor(ds.length * 0.95)] ?? 0; // p95: un solo grupo volador ya se ve
  }

  const cajas = doc.images.map(cajaImagen);
  const sobre = doc.strokes.length && cajas.length
    ? doc.strokes.filter((s) => { const [x,y] = centro(s);
        return cajas.some((c) => x>=c.x0 && x<=c.x1 && y>=c.y0 && y<=c.y1); }).length / doc.strokes.length * 100
    : 0;

  const todo = [...doc.strokes.flatMap((s) => s.pts), ...doc.images.flatMap((im) =>
    [[0,0],[im.w,0],[0,im.h],[im.w,im.h]].map(([x,y]) => aplicar(im.m,x,y)))];
  const bb = todo.length ? bboxDe(todo) : { x0:0,x1:0,y0:0,y1:0 };

  return {
    trazos: doc.strokes.length, movidos: movidos.length, imagenes: doc.images.length,
    cohesionP95: +cohesion.toFixed(4), sobreImagen: +sobre.toFixed(1),
    ancho: +(bb.x1-bb.x0).toFixed(1), alto: +(bb.y1-bb.y0).toFixed(1),
  };
}

// ---------------------------------------------------------------- PNG
function crc32(b){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
 let x=0xffffffff;for(const v of b)x=t[(x^v)&0xff]^(x>>>8);return (x^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
 const td=Buffer.concat([Buffer.from(type,"ascii"),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td));
 return Buffer.concat([len,td,c]);}
function png(w,h,rgb){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 const rows=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){rows[y*(w*3+1)]=0;rgb.copy(rows,y*(w*3+1)+1,y*w*3,(y+1)*w*3);}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);}

/** Render de diagnostico: gris = trazos sin matriz, rojo = con matriz,
 * azul = caja de cada imagen. Y se invierte (el documento es Y-arriba). */
export function renderPNG(doc, W = 1000, H = 640) {
  const px = Buffer.alloc(W*H*3, 255);
  const pts = [...doc.strokes.flatMap((s) => s.pts), ...doc.images.flatMap((im) =>
    [[0,0],[im.w,0],[0,im.h],[im.w,im.h]].map(([x,y]) => aplicar(im.m,x,y)))];
  if (!pts.length) return png(W,H,px);
  const b = bboxDe(pts);
  const sc = Math.min((W-20)/((b.x1-b.x0)||1), (H-20)/((b.y1-b.y0)||1));
  const P = (x,y) => [Math.round((x-b.x0)*sc + 10), Math.round(H - ((y-b.y0)*sc + 10))];
  const put=(x,y,c)=>{if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*3;px[i]=c[0];px[i+1]=c[1];px[i+2]=c[2];};
  const line=(x0,y0,x1,y1,c)=>{const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let e=dx-dy;
    for(let k=0;k<9000;k++){put(x0,y0,c);if(x0===x1&&y0===y1)break;const e2=2*e;if(e2>-dy){e-=dy;x0+=sx;}if(e2<dx){e+=dx;y0+=sy;}}};
  for (const im of doc.images) { const c = cajaImagen(im);
    const a=P(c.x0,c.y0), d=P(c.x1,c.y1);
    line(a[0],a[1],d[0],a[1],[70,110,220]); line(d[0],a[1],d[0],d[1],[70,110,220]);
    line(d[0],d[1],a[0],d[1],[70,110,220]); line(a[0],d[1],a[0],a[1],[70,110,220]); }
  for (const s of doc.strokes) { const c = s.identidad ? [120,120,120] : [210,40,40];
    for (let i=1;i<s.pts.length;i++){ const a=P(...s.pts[i-1]), d=P(...s.pts[i]); line(a[0],a[1],d[0],d[1],c); } }
  return png(W,H,px);
}

// ---------------------------------------------------------------- CLI
function resolver(arg) {
  if (existsSync(arg)) return arg;
  const p = path.join(CACHE, arg.endsWith(".concepts") ? arg : `${arg}.concepts`);
  if (existsSync(p)) return p;
  throw new Error(`no encuentro ${arg}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verificar-geometria.mjs")) {
  const args = process.argv.slice(2);
  const conPng = args.includes("--png");
  const objetivo = args.find((a) => !a.startsWith("--"));

  if (objetivo) {
    const f = resolver(objetivo);
    console.log(`archivo: ${path.basename(f)}\n`);
    for (const [etiqueta, op] of [
      ["SIN matriz de trazo (comportamiento viejo)", { matrizTrazo: false, matriz2Imagen: false }],
      ["CON matriz de trazo", { matrizTrazo: true, matriz2Imagen: false }],
      ["CON matriz de trazo + 2da matriz de imagen", { matrizTrazo: true, matriz2Imagen: true }],
    ]) {
      const d = leerDocumento(f, op);
      const m = metricas(d);
      console.log(etiqueta.padEnd(46), JSON.stringify(m));
      if (conPng) {
        const nom = `.cache/geom-${path.basename(f,".concepts").slice(0,12)}-${op.matrizTrazo?(op.matriz2Imagen?"full":"mat"):"viejo"}.png`;
        writeFileSync(nom, renderPNG(d));
        console.log("   ->", nom);
      }
    }
  } else {
    const files = readdirSync(CACHE).filter((f) => f.endsWith(".concepts"));
    console.log("archivo".padEnd(30), "trazos".padStart(7), "movidos".padStart(8), "img".padStart(5),
                "cohesionP95 viejo->nuevo".padStart(26), "  sobreImg viejo->nuevo");
    let peorViejo = [], mejoras = 0, empeora = 0;
    for (const f of files) {
      try {
        const viejo = metricas(leerDocumento(path.join(CACHE,f), { matrizTrazo:false, matriz2Imagen:false }));
        const nuevo = metricas(leerDocumento(path.join(CACHE,f), { matrizTrazo:true,  matriz2Imagen:false }));
        if (!viejo.movidos) continue;
        if (nuevo.cohesionP95 < viejo.cohesionP95 - 1e-4) mejoras++;
        else if (nuevo.cohesionP95 > viejo.cohesionP95 + 1e-4) empeora++;
        if (viejo.cohesionP95 > 0.05) peorViejo.push({ f, viejo: viejo.cohesionP95, nuevo: nuevo.cohesionP95 });
        console.log(f.slice(0,28).padEnd(30), String(viejo.trazos).padStart(7), String(viejo.movidos).padStart(8),
          String(viejo.imagenes).padStart(5),
          `${viejo.cohesionP95.toFixed(4)} -> ${nuevo.cohesionP95.toFixed(4)}`.padStart(26),
          `   ${viejo.sobreImagen.toFixed(1)}% -> ${nuevo.sobreImagen.toFixed(1)}%`);
      } catch {}
    }
    console.log(`\ncohesion: mejora en ${mejoras} archivos, empeora en ${empeora}`);
    console.log(`archivos con trazos voladores (cohesionP95 > 0.05) ANTES del arreglo: ${peorViejo.length}`);
    peorViejo.sort((a,b)=>b.viejo-a.viejo).slice(0,10).forEach((r)=>
      console.log(`   ${r.f.slice(0,40).padEnd(42)} ${r.viejo.toFixed(4)} -> ${r.nuevo.toFixed(4)}`));
  }
}
