import fs from 'fs';
import { parseConceptsFile } from './src/parser.ts'; // Wait, ts-node or similar needed. Let's just write a test script in TS and use tsx or just use Vite's built-in tools.

async function main() {
  const buffer = fs.readFileSync('./public/Dibujo12.concepts');
  try {
    const doc = await parseConceptsFile(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    console.log("BBOX:", doc.bbox);
    console.log("Layers:", doc.layers.length);
    console.log("Images:", doc.layers.reduce((acc, l) => acc + l.images.length, 0));
    console.log("Strokes:", doc.layers.reduce((acc, l) => acc + l.strokes.length, 0));
    if (doc.layers.length > 0 && doc.layers[0].strokes.length > 0) {
      console.log("First stroke points sample:", doc.layers[0].strokes[0].points.slice(0, 3));
    }
  } catch (e) {
    console.error(e);
  }
}
main();
