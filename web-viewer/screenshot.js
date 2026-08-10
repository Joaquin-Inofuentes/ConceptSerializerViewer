import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log("Starting server...");
  const server = spawn('npm.cmd', ['run', 'preview', '--', '--port', '5000'], { stdio: 'pipe' });
  
  // wait for server to start
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  console.log("Navigating to http://localhost:5000...");
  await page.goto('http://localhost:5000');
  
  // Wait for React to mount and the button to appear
  await page.waitForSelector('.btn-secondary');
  console.log("Clicking load example...");
  await page.click('.btn-secondary');
  
  // Wait for canvas wrapper to appear
  console.log("Waiting for viewer...");
  await page.waitForSelector('canvas', { timeout: 10000 });
  
  // Wait a bit for drawing to finish
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const screenshotPath = 'C:\\Users\\PC_JOACO\\.gemini\\antigravity\\brain\\7935b7e3-7a91-44d4-822f-1736cc32b5ce\\scratch\\screenshot.png';
  await page.screenshot({ path: screenshotPath });
  console.log("Screenshot saved to: " + screenshotPath);
  
  await browser.close();
  server.kill();
  console.log("Done.");
}

run().catch(console.error);
