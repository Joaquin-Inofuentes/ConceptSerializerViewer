// Prueba DECISIVA y no circular: agarra un trazo que HOY queda flotando
// (fuera de cualquier imagen segun la interpretacion actual, esquina
// superior-izquierda), y renderiza la foto real de bytes crudos con DOS
// convenciones de origen local (esquina vs centro) para ver cual la deja
// tapando el trazo de verdad.

import { openConceptsRemote } from "../../src/VisorConcept/parser";

export async function probarCentro(url: string, headers: Record<string, string>) {
  const archivo = await openConceptsRemote(url, headers);
  const doc = await archivo.parse();

  // Bbox actual (esquina) de cada imagen colocada, tal cual lo hace el parser
  // de produccion hoy.
  const cajaEsquina = (img: { transform: number[]; width: number; height: number }) => {
    const m = img.transform; // YA pasado por girarTransform en el parser
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const esquinas = [[0, 0], [img.width, 0], [0, img.height], [img.width, img.height]].map(
      ([x, y]) => [a * x + c * y + e, b * x + d * y + f]
    );
    const xs = esquinas.map((p) => p[0]), ys = esquinas.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const cajaCentro = (img: { transform: number[]; width: number; height: number }) => {
    const m = img.transform;
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const w = img.width, h = img.height;
    const esquinas = [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]].map(
      ([x, y]) => [a * x + c * y + e, b * x + d * y + f]
    );
    const xs = esquinas.map((p) => p[0]), ys = esquinas.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };

  type Placed = { resourceId: string; width: number; height: number; transform: number[]; cE: any; cC: any };
  const colocadas: Placed[] = [];
  for (const l of doc.layers) {
    for (const img of l.images) {
      colocadas.push({
        resourceId: img.resourceId,
        width: img.width,
        height: img.height,
        transform: img.transform,
        cE: cajaEsquina(img),
        cC: cajaCentro(img),
      });
    }
  }

  // Trazos chicos (precisos), con su centro.
  const trazos: Array<{ cx: number; cy: number; area: number }> = [];
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      const b = s.bbox;
      trazos.push({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, area: (b.maxX - b.minX) * (b.maxY - b.minY) });
    }
  }
  trazos.sort((a, b) => a.area - b.area);

  // Busca un trazo que NO caiga en NINGUNA imagen segun "esquina" (flotando
  // hoy) pero SI caiga en exactamente una segun "centro" (candidato ideal
  // para la prueba: sin ambiguedad de cual imagen), Y que ademas sea un JPEG
  // (decodificable directo por createImageBitmap; un PDF necesitaria pdf.js).
  let elegido: { trazo: (typeof trazos)[0]; img: Placed } | null = null;
  for (const t of trazos) {
    const enEsquina = colocadas.filter((c) => t.cx >= c.cE.x0 && t.cx <= c.cE.x1 && t.cy >= c.cE.y0 && t.cy <= c.cE.y1);
    const enCentro = colocadas.filter((c) => t.cx >= c.cC.x0 && t.cx <= c.cC.x1 && t.cy >= c.cC.y0 && t.cy <= c.cC.y1);
    if (enEsquina.length === 0 && enCentro.length >= 1) {
      for (const candidato of enCentro) {
        const trozo = await doc.loadResource(candidato.resourceId);
        const cabecera = trozo ? await trozo.slice(0, 5).text() : "";
        if (cabecera && cabecera !== "%PDF-") {
          elegido = { trazo: t, img: candidato };
          break;
        }
      }
      if (elegido) break;
    }
  }

  if (!elegido) {
    doc.close();
    archivo.close();
    return { error: "no se encontro un trazo flotando-en-esquina-pero-en-centro-y-JPEG" };
  }

  // El trazo elegido, con sus puntos reales (para dibujarlo encima).
  let puntosTrazo: Array<{ x: number; y: number }> = [];
  for (const l of doc.layers) {
    for (const s of l.strokes) {
      const b = s.bbox;
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      if (cx === elegido.trazo.cx && cy === elegido.trazo.cy) {
        puntosTrazo = s.points.map((p) => ({ x: p.x, y: p.y }));
      }
    }
  }

  // Trae los bytes reales del recurso.
  const blob = await doc.loadResource(elegido.img.resourceId);
  doc.close();
  archivo.close();
  if (!blob) return { error: "no se pudo cargar el recurso" };

  const bmp = await createImageBitmap(blob);
  const img = elegido.img;
  const m = img.transform;
  const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];

  // Ventana de recorte: alrededor del trazo, con margen suficiente para ver
  // contexto de la foto.
  const margen = 250;
  const vx0 = elegido.trazo.cx - margen, vy0 = elegido.trazo.cy - margen;
  const vw = margen * 2, vh = margen * 2;
  const escalaCanvas = 3; // supersample para que se lea nitido

  function render(centrado: boolean): string {
    const canvas = new OffscreenCanvas(vw * escalaCanvas, vh * escalaCanvas);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(escalaCanvas, escalaCanvas);
    ctx.translate(-vx0, -vy0);
    // Misma matriz de transform en los dos casos; lo unico que cambia es
    // DONDE, en coordenadas locales, se dibuja el bitmap dentro de ese
    // espacio ya transformado.
    ctx.transform(a, b, c, d, e, f);
    if (centrado) ctx.drawImage(bmp, -img.width / 2, -img.height / 2, img.width, img.height);
    else ctx.drawImage(bmp, 0, 0, img.width, img.height);
    ctx.restore();
    // El trazo real, en rojo brillante, SIN transformar (ya esta en
    // coordenadas de documento).
    ctx.save();
    ctx.scale(escalaCanvas, escalaCanvas);
    ctx.translate(-vx0, -vy0);
    ctx.strokeStyle = "#ff2d55";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    puntosTrazo.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
    return canvas as unknown as string; // placeholder, se convierte afuera
  }

  const canvasEsquina = render(false) as unknown as OffscreenCanvas;
  const canvasCentro = render(true) as unknown as OffscreenCanvas;
  const blobEsquina = await canvasEsquina.convertToBlob({ type: "image/png" });
  const blobCentro = await canvasCentro.convertToBlob({ type: "image/png" });
  const toDataUrl = (b: Blob) =>
    new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(b);
    });

  return {
    trazo: elegido.trazo,
    img: { resourceId: img.resourceId, width: img.width, height: img.height, transform: img.transform },
    cajaEsquina: elegido.img.cE,
    cajaCentro: elegido.img.cC,
    puntosTrazo: puntosTrazo.length,
    esquinaPng: await toDataUrl(blobEsquina),
    centroPng: await toDataUrl(blobCentro),
  };
}
