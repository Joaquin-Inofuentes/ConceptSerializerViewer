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
  
  console.log("Waiting for document to load...");
  await page.waitForSelector('.btn-tool', { timeout: 10000 });
  
  console.log("Testing Export button...");
  const buttons = await page.$$('.btn-tool');
  const exportBtn = buttons[0]; // Export is the first one
  await exportBtn.click();
  
  await page.waitForSelector('.dropdown-menu', { timeout: 3000 });
  console.log("Export menu opened successfully.");
  
  const exportOptions = await page.$$('.dropdown-menu .btn-tiny');
  
  console.log("Testing PDF export...");
  await exportOptions[0].click(); // PDF
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("Testing JPG export...");
  await exportBtn.click();
  await page.waitForSelector('.dropdown-menu', { timeout: 3000 });
  const exportOptions2 = await page.$$('.dropdown-menu .btn-tiny');
  await exportOptions2[1].click(); // JPG
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("Testing PNG export...");
  await exportBtn.click();
  await page.waitForSelector('.dropdown-menu', { timeout: 3000 });
  const exportOptions3 = await page.$$('.dropdown-menu .btn-tiny');
  await exportOptions3[2].click(); // PNG
  await new Promise(r => setTimeout(r, 2000));
  
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
