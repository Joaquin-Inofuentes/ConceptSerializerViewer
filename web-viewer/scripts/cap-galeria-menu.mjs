import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = path.resolve(".cache/detalle");
const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?tier=alta&file=${FILE}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("canvas")?.width > 1, { timeout: 240000 });
await page.waitForFunction(() => !document.querySelector(".viewer-carga"), { timeout: 240000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /^Imágenes:/.test(b.title || ""));
  btn.click();
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: path.join(OUT, "galeria-menu.png") });
console.log("guardado");
await browser.close();
