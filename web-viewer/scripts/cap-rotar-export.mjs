import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 900000 });
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on("pageerror", (e) => console.error("[error]", e.message.slice(0, 200)));
await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${FILE}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /^Imágenes:/.test(b.title || ""));
  btn.click();
});
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => {
  const items = [...document.querySelectorAll(".gallery-item")].filter((it) => !it.classList.contains("gallery-item-lejos"));
  items[0].click();
});
await new Promise((r) => setTimeout(r, 1000));

// Rota 90.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.title || "").startsWith("Rotar 90"));
  btn.click();
});
await new Promise((r) => setTimeout(r, 300));

// Intercepta la descarga: monkeypatch createObjectURL/anchor.click para
// capturar el dataURL en vez de bajarlo de verdad.
const capturado = await page.evaluate(async () => {
  return new Promise((resolve) => {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      resolve({ href: this.href.slice(0, 60), download: this.download });
      HTMLAnchorElement.prototype.click = origClick;
    };
    const btn = [...document.querySelectorAll("button")].find((b) => (b.title || "") === "Exportar");
    btn.click();
    setTimeout(() => {
      const pngBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("PNG"));
      pngBtn.click();
    }, 300);
  });
});
console.log("capturado:", JSON.stringify(capturado));

await browser.close();
