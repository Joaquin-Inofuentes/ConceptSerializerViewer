import fs from 'fs';
import JSZip from 'jszip';

async function main() {
  const buffer = fs.readFileSync('./public/Dibujo12.concepts');
  const zip = await JSZip.loadAsync(buffer);
  console.log("Zip files:", Object.keys(zip.files));
}
main();
