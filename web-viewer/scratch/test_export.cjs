const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  console.log("Starting Local UI Test for Export...");
  
  // Find Chrome path for Windows
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  ];
  let executablePath = chromePaths.find(p => fs.existsSync(p));

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  const downloadPath = path.resolve(__dirname, 'downloads');
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });
  
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
  });

  console.log("Navigating to local dev server...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  
  console.log("Clicking 'Probar Ejemplo'...");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.includes('Probar Ejemplo'));
    if (btn) btn.click();
  });
  
  await page.waitForSelector('.btn-tool', { timeout: 10000 });
  
  await page.evaluate(() => {
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      console.log(`[CANVAS EXPORT] width: ${this.width}, height: ${this.height}`);
      return originalToDataURL.apply(this, args);
    };
  });

  page.on('console', msg => console.log('BROWSER:', msg.text()));

  console.log("Testing Canvas Export (Visible Area)...");
  const buttons = await page.$$('.btn-tool');
  const exportBtn = buttons[0]; 
  await exportBtn.click();
  
  await page.waitForSelector('.dropdown-menu', { timeout: 3000 });
  const zoomAllCheck = await page.$('.dropdown-menu input[type="checkbox"]');
  await zoomAllCheck.click(); // Uncheck it
  
  const exportOptions = await page.$$('.dropdown-menu .btn-tiny');
  await exportOptions[2].click(); // PNG
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("Testing Image Export (Zoom All)...");
  const galleryBtn = buttons[1]; // Second button is the layers wait! No, the layers is middle, gallery is bottom! 
  // Let's just evaluate to find the gallery button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.btn-tool'));
    const imgBtn = btns.find(b => b.innerHTML.includes('polyline')); // Lucide Image icon has polyline?
    if (imgBtn) imgBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  await page.evaluate(() => {
    const galleryItems = document.querySelectorAll('.gallery-item');
    if (galleryItems.length > 0) galleryItems[0].click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log("InteractivePreview should be open. Clicking export...");
  await page.evaluate(() => {
    const tools = document.querySelectorAll('.fullscreen-preview .btn-tool');
    if (tools.length > 0) tools[0].click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  await page.evaluate(() => {
    const exports = document.querySelectorAll('.fullscreen-preview .btn-tiny');
    if (exports.length > 2) exports[2].click(); // PNG
  });
  await new Promise(r => setTimeout(r, 2000));

  await browser.close();
  
  const files = fs.readdirSync(downloadPath);
  console.log("Downloaded files:", files);
  
  if (files.find(f => f.includes('.pdf')) && files.find(f => f.includes('.jpg')) && files.find(f => f.includes('.png'))) {
      console.log("SUCCESS: All 3 formats exported successfully!");
  } else {
      throw new Error("Export failed, missing some files.");
  }
  
  await browser.close();
  console.log("All tests passed!");
})().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
