import puppeteer from "puppeteer";

const BASE = (process.env.BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const FILE = process.argv[2];
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";
const FN = "https://kuhcxzusnrttkywgalgk.supabase.co/functions/v1/concepts-drive";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
const r = await page.evaluate(
  async (url, headers) => {
    const mod = await import("/scripts/browser/dump-item8-payload.ts");
    return mod.dump(url, headers);
  },
  `${FN}?action=download&fileId=${FILE}`,
  { apikey: K, Authorization: `Bearer ${K}` }
);
console.log(JSON.stringify(r, null, 2));
await browser.close();
