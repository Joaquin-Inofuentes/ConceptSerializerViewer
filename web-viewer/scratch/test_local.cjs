const puppeteer = require('puppeteer');

(async () => {
  console.log("Starting Local UI Test...");
  const browser = await puppeteer.launch({ headless: 'new' });
  
  try {
    const page = await browser.newPage();
    
    // Test 1: Desktop Viewport
    console.log("Setting desktop viewport...");
    await page.setViewport({ width: 1280, height: 800 });
    
    console.log("Navigating to local dev server...");
    await page.goto('http://127.0.0.1:5173/');
    
    console.log("Waiting for app to load...");
    await page.waitForSelector('.btn-primary');
    
    console.log("Clicking 'Probar Ejemplo'...");
    await page.click('.btn-primary');
    
    console.log("Waiting for document to load...");
    await page.waitForSelector('.btn-tool', { timeout: 10000 });
    
    console.log("Document loaded! Testing Layer button on Desktop...");
    const buttons = await page.$$('.btn-tool');
    
    // The first dropdown button should be layers
    await buttons[0].click();
    
    // Wait for the dropdown menu to appear
    await page.waitForSelector('.layer-menu', { timeout: 3000 });
    console.log("Layer menu opened successfully on Desktop.");
    
    // Click outside to close it using mouse
    console.log("Clicking outside to close layer menu...");
    // Click in the middle of the canvas
    await page.mouse.click(500, 500);
    
    // Wait for the menu to disappear
    await page.waitForFunction(() => !document.querySelector('.layer-menu'), { timeout: 3000 });
    console.log("Layer menu closed successfully on Desktop.");
    
    console.log("Testing Image button on Desktop...");
    await buttons[1].click();
    await page.waitForSelector('.image-menu', { timeout: 3000 });
    console.log("Image menu opened successfully on Desktop.");
    
    console.log("Clicking outside to close image menu...");
    await page.mouse.click(500, 500);
    await page.waitForFunction(() => !document.querySelector('.image-menu'), { timeout: 3000 });
    console.log("Image menu closed successfully on Desktop.");

    // --- Mobile Test ---
    console.log("\\n--- Testing Mobile Viewport ---");
    await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true });
    
    console.log("Testing Layer button on Mobile...");
    // Need to use tap for mobile
    const layerBtn = await page.$('.dropdown-container:nth-child(1) .btn-tool');
    const layerBox = await layerBtn.boundingBox();
    await page.touchscreen.tap(layerBox.x + layerBox.width/2, layerBox.y + layerBox.height/2);
    
    await page.waitForSelector('.layer-menu', { timeout: 3000 });
    console.log("Layer menu opened successfully on Mobile.");
    
    console.log("Touching outside to close layer menu...");
    await page.touchscreen.tap(180, 400);
    
    await page.waitForFunction(() => !document.querySelector('.layer-menu'), { timeout: 3000 });
    console.log("Layer menu closed successfully on Mobile.");
    
    console.log("Testing Image button on Mobile...");
    const imageBtn = await page.$('.dropdown-container:nth-child(2) .btn-tool');
    const imageBox = await imageBtn.boundingBox();
    await page.touchscreen.tap(imageBox.x + imageBox.width/2, imageBox.y + imageBox.height/2);
    
    await page.waitForSelector('.image-menu', { timeout: 3000 });
    console.log("Image menu opened successfully on Mobile.");
    
    console.log("Touching outside to close image menu...");
    await page.touchscreen.tap(180, 400);
    await page.waitForFunction(() => !document.querySelector('.image-menu'), { timeout: 3000 });
    console.log("Image menu closed successfully on Mobile.");

    console.log("ALL TESTS PASSED");
    
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
