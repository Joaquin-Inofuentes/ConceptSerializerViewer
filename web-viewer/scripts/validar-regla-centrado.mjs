// Valida la regla "centrar las colocaciones con traslacion exactamente (0,0)"
// contra TODO el corpus local, sin rasterizar nada: solo geometria de cajas.
//
// Metrica: cuanto se sale el bbox de trazos del area cubierta por las
// imagenes, normalizado. Baja = las notas caen sobre los planos.
//
// OJO — esta metrica es NECESARIA PERO NO SUFICIENTE, comprobado: la regla
// "centrar las colocaciones con traslacion (0,0)" la mejora en 13 archivos y
// no la empeora en ninguno, pero al mirar el render real de uno de ellos
// (Fede y Franco/Concepts/HO/Drawing) se ve que la pagina corregida pasa a
// SUPERPONERSE con la de al lado, y las notas que se querian arreglar siguen
// flotando afuera igual. La metrica solo mira la union de las cajas, no si
// las paginas se pisan entre si ni si cada nota cae sobre SU plano. Nunca
// aceptar un cambio de centrado solo por este numero: hay que mirar el
// antes/despues con scripts/centrado-ab.mjs.
//
//   node --experimental-strip-types scripts/validar-regla-centrado.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { ZipArchive, BufferSource } from "../src/VisorConcept/zip.ts";
const CACHE_DIR = path.resolve(".cache/concepts");
const manifest = JSON.parse(await readFile(path.join(CACHE_DIR, "manifest.json"), "utf8"));
const files = manifest.files.filter(f => f.size && f.localPath);
function de(){return new Uint8Array();}
const ec = new ExtensionCodec();
ec.register({type:1,encode:de,decode:d=>{const v=new DataView(d.buffer,d.byteOffset,d.byteLength);return [v.getFloat32(0,true),v.getFloat32(4,true)];}});
ec.register({type:2,encode:de,decode:d=>{const v=new DataView(d.buffer,d.byteOffset,d.byteLength);return [v.getFloat32(0,true),v.getFloat32(4,true)];}});
ec.register({type:4,encode:de,decode:d=>{const v=new DataView(d.buffer,d.byteOffset,d.byteLength);return [v.getFloat32(0,true),v.getFloat32(4,true),v.getFloat32(8,true),v.getFloat32(12,true)];}});
ec.register({type:5,encode:de,decode:d=>{const h=Array.from(d).map(b=>b.toString(16).padStart(2,"0")).join("");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}});
ec.register({type:7,encode:de,decode:d=>{const v=new DataView(d.buffer,d.byteOffset,d.byteLength);const m=[];for(let i=0;i<16;i++)m.push(v.getFloat32(i*4,true));return m;}});
const girar=m=>{const s=m.slice();for(const i of [0,1,4,5,12,13])s[i]=-s[i];return s;};
const IDENT=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const cajaDe=(m,w,h)=>{const a=m[0],b=m[1],c=m[4],d=m[5],e=m[12],f=m[13];
  const xs=[0,w].flatMap(x=>[0,h].map(y=>a*x+c*y+e)),ys=[0,w].flatMap(x=>[0,h].map(y=>b*x+d*y+f));
  return {x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys),y1:Math.max(...ys)};};
const centrar=(m,w,h)=>{const s=m.slice();s[12]=m[12]-(m[0]*w)/2-(m[4]*h)/2;s[13]=m[13]-(m[1]*w)/2-(m[5]*h)/2;return s;};
async function analizar(f){
  const zip=await ZipArchive.open(new BufferSource(await readFile(f.localPath)));
  const nt=zip.names().find(n=>/(^|\/)tree\.pack$/.test(n)); if(!nt) return null;
  const tree=decode(await zip.read(nt),{extensionCodec:ec});
  const imgs=[],trz=[];
  const vi=item=>{if(!Array.isArray(item)||!item.length)return;const t=item[0],c=item.length>1?item[1]:null;
    if((t===8||t===7)&&Array.isArray(c)){const int=Array.isArray(c[1])?c[1]:null;
      const tam=c.find(x=>Array.isArray(x)&&x.length===2&&typeof x[0]==="number");
      const m=int?int.find(x=>Array.isArray(x)&&x.length===16):null;
      const rid=c.find(x=>typeof x==="string"&&x.includes("-"));
      if(tam&&tam[0]>0&&tam[1]>0&&rid)imgs.push({w:tam[0],h:tam[1],m});return;}
    bt(item);};
  const bt=o=>{if(!Array.isArray(o))return;
    const bl=o.filter(x=>x instanceof Uint8Array&&x.length>=32&&x.length%16===0);
    if(bl.length&&o.length>2&&o[0]===6&&Array.isArray(o[1])){const b=bl[0],n=Math.floor(b.length/16),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
      let a=Infinity,c2=Infinity,d=-Infinity,e=-Infinity;
      for(let i=0;i<n;i++){const x=-v.getFloat32(i*16,true),y=-v.getFloat32(i*16+4,true);
        if(x<a)a=x;if(x>d)d=x;if(y<c2)c2=y;if(y>e)e=y;}
      trz.push({x0:a,y0:c2,x1:d,y1:e});return;}
    for(const x of o)bt(x);};
  const dd=Array.isArray(tree)&&tree.length>1?tree[1]:tree;
  const dc=Array.isArray(dd)?dd.find(x=>Array.isArray(x)&&x.length&&x.every(c=>Array.isArray(c)&&c.length&&c[0]===1)):null;
  if(dc)dc.forEach(cp=>{const it=Array.isArray(cp)&&cp.length>2&&Array.isArray(cp[2])?cp[2]:[];it.forEach(vi);});
  if(!imgs.length||!trz.length)return null;
  // Matriz final tal cual la produce el parser HOY (centrado por lineal-identidad + giro)
  const finales=imgs.map(im=>{const m=(im.m||IDENT).slice();
    if(m[0]===1&&m[1]===0&&m[4]===0&&m[5]===1){m[12]-=im.w/2;m[13]-=im.h/2;}
    return girar(m);});
  const nunca=finales.map(m=>m[12]===0&&m[13]===0);
  const conRegla=finales.map((m,i)=>nunca[i]?centrar(m,imgs[i].w,imgs[i].h):m);
  const desb=ms=>{const bs=ms.map((m,i)=>cajaDe(m,imgs[i].w,imgs[i].h));
    const ix0=Math.min(...bs.map(b=>b.x0)),ix1=Math.max(...bs.map(b=>b.x1));
    const iy0=Math.min(...bs.map(b=>b.y0)),iy1=Math.max(...bs.map(b=>b.y1));
    const tx0=Math.min(...trz.map(t=>t.x0)),tx1=Math.max(...trz.map(t=>t.x1));
    const ty0=Math.min(...trz.map(t=>t.y0)),ty1=Math.max(...trz.map(t=>t.y1));
    const fuera=Math.max(0,ix0-tx0)+Math.max(0,tx1-ix1)+Math.max(0,iy0-ty0)+Math.max(0,ty1-iy1);
    return +(fuera/(((tx1-tx0)+(ty1-ty0))||1)).toFixed(4);};
  return {n:imgs.length,nunca:nunca.filter(Boolean).length,actual:desb(finales),conRegla:desb(conRegla)};
}
const out=[];
for(let i=0;i<files.length;i++){
  try{const r=await analizar(files[i]); if(r)out.push({name:files[i].name,folderPath:files[i].folderPath,...r});}catch{}
  if((i+1)%40===0)console.error(`... ${i+1}/${files.length}`);
}
const afectados=out.filter(r=>r.nunca>0);
const mejoran=afectados.filter(r=>r.conRegla<r.actual-0.0001);
const empeoran=afectados.filter(r=>r.conRegla>r.actual+0.0001);
const igual=out.filter(r=>Math.abs(r.conRegla-r.actual)<=0.0001);
console.log(`\n${out.length} archivos con imagenes+trazos`);
console.log(`  con alguna colocacion nunca-movida: ${afectados.length}`);
console.log(`  MEJORAN: ${mejoran.length}   EMPEORAN: ${empeoran.length}   sin cambio: ${igual.length}`);
console.log(`\n== Los que mejoran ==`);
mejoran.sort((a,b)=>(b.actual-b.conRegla)-(a.actual-a.conRegla));
for(const r of mejoran) console.log(`  ${r.actual} -> ${r.conRegla}  (${r.nunca}/${r.n} nunca-movidas)  ${r.name}`);
if(empeoran.length){console.log(`\n== LOS QUE EMPEORAN (hay que mirarlos) ==`);
  for(const r of empeoran) console.log(`  ${r.actual} -> ${r.conRegla}  (${r.nunca}/${r.n})  ${r.name}  [${r.folderPath}]`);}
