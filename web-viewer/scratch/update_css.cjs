const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '../src/App.css');
let css = fs.readFileSync(cssPath, 'utf8');

// Add keyframes
if (!css.includes('@keyframes fadeIn')) {
  css += `
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slideDownFade {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes popIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
`;
}

// 1. app-container fade
css = css.replace('.app-container {\n  display: flex;', '.app-container {\n  animation: fadeIn 0.5s ease-out forwards;\n  display: flex;');

// 2. Change all 0.2s transitions to 0.5s
css = css.replace(/transition: all 0\.2s ease/g, 'transition: all 0.5s ease');
css = css.replace(/transition: all 0\.2s/g, 'transition: all 0.5s');

// 3. dropdown-menu animation
css = css.replace('.dropdown-menu {\n  position: absolute;', '.dropdown-menu {\n  animation: slideDownFade 0.5s ease-out forwards;\n  transform-origin: top;\n  position: absolute;');

// 4. Mobile dropdown-menu full width
const mobileMediaQueryMatch = css.match(/@media \(max-width: 480px\) \{[\s\S]*?\n\}/);
if (mobileMediaQueryMatch) {
  const mediaQuery = mobileMediaQueryMatch[0];
  if (!mediaQuery.includes('.dropdown-menu {')) {
    const newMediaQuery = mediaQuery.replace('\n}', `\n  .dropdown-menu {
    position: fixed;
    top: 50px;
    left: 0 !important;
    right: 0 !important;
    width: 100vw !important;
    max-height: calc(100vh - 50px);
    overflow-y: auto;
    border-radius: 0;
    border-left: none;
    border-right: none;
    margin-top: 0;
  }\n}`);
    css = css.replace(mediaQuery, newMediaQuery);
  }
}

// 5. fullscreen-preview animation
css = css.replace('.fullscreen-preview {\n  position: fixed;', '.fullscreen-preview {\n  animation: fadeIn 0.5s ease-out forwards;\n  position: fixed;');
css = css.replace('.fullscreen-preview img {\n  max-width: 100%;', '.fullscreen-preview img {\n  animation: popIn 0.5s ease-out forwards;\n  max-width: 100%;');

fs.writeFileSync(cssPath, css);
console.log("CSS Updated");
