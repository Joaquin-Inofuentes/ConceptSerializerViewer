import fs from 'fs';
import JSZip from 'jszip';
import { decode, ExtensionCodec } from '@msgpack/msgpack';

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: 5,
  encode: () => new Uint8Array(),
  decode: (data) => {
    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});

async function main() {
  const buffer = fs.readFileSync('./public/Dibujo12.concepts');
  const zip = await JSZip.loadAsync(buffer);
  const resData = await zip.file("resource.pack").async("uint8array");
  
  // Try with useMap: false (default)
  try {
      const rp1 = decode(resData, { extensionCodec });
      console.log("Default Decode:", rp1[1]);
  } catch (e) {
      console.error("Default error", e);
  }
}
main();
