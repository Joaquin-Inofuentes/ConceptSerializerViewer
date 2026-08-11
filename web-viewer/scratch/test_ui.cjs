const puppeteer = require('puppeteer');

(async () => {
  console.log("Starting UI Test...");
  const browser = await puppeteer.launch({ headless: 'new' });
  
  try {
    const page = await browser.newPage();
    
    // Test 1: Mobile Viewport
    console.log("Setting mobile viewport...");
    await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true });
    
    console.log("Navigating to Vercel deployment...");
    await page.goto('https://web-viewer-dusky.vercel.app/');
    
    console.log("Waiting for app to load...");
    await page.waitForSelector('.btn-primary');
    
    console.log("Clicking 'Probar Ejemplo'...");
    await page.click('.btn-primary');
    
    console.log("Waiting for document to load...");
    await page.waitForSelector('.stats', { timeout: 10000 });
    
    console.log("Document loaded! Testing Layer button...");
    const buttons = await page.$$('.btn-dropdown');
    
    // The first dropdown button should be layers
    await buttons[0].click();
    
    // Wait for the dropdown menu to appear
    await page.waitForSelector('.layer-menu');
    console.log("Layer menu opened successfully.");
    
    // Click outside to close it using touch
    console.log("Touching outside to close layer menu...");
    // Touch in the middle of the canvas
    await page.touchscreen.tap(180, 400);
    
    // Wait for the menu to disappear
    await page.waitForFunction(() => !document.querySelector('.layer-menu'), { timeout: 3000 });
    console.log("Layer menu closed successfully.");
    
    console.log("Testing Image button...");
    await buttons[1].click();
    await page.waitForSelector('.image-menu');
    console.log("Image menu opened successfully.");
    
    console.log("Touching outside to close image menu...");
    await page.touchscreen.tap(180, 400);
    await page.waitForFunction(() => !document.querySelector('.image-menu'), { timeout: 3000 });
    console.log("Image menu closed successfully.");

    console.log("Testing Close Document button...");
    // The close button is a red X. It's the only button in the header with the title "Cerrar documento".
    const closeBtn = await page.$('button[title="Cerrar documento"]');
    if (!closeBtn) throw new Error("Close button not found");
    await closeBtn.click();
    
    await page.waitForSelector('.empty-state', { timeout: 3000 });
    console.log("Document closed successfully.");
    
    console.log("ALL TESTS PASSED: Mobile UI behaves perfectly.");
    
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
