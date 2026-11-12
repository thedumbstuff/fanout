// Draws fanout's icons from the SVG below and writes them as PNG:
//   build/icon.png  1024px, the app icon (electron-builder makes .ico/.icns from it)
//   build/drag.png    64px, shown under the pointer while files are dragged
// Run with:  npm run icon

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'build');

// One dot fanning out to three scraps of paper.
const APP_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="24" y="24" width="464" height="464" rx="104" fill="#070705"/>
  <g fill="none" stroke="#ede4d3" stroke-width="22" stroke-linecap="round">
    <path d="M150 256 C 230 256, 250 140, 330 140"/>
    <path d="M150 256 H 330"/>
    <path d="M150 256 C 230 256, 250 372, 330 372"/>
  </g>
  <circle cx="142" cy="256" r="44" fill="#ede4d3"/>
  <rect x="318" y="96" width="88" height="88" rx="10" fill="#fb5f89" transform="rotate(-8 362 140)"/>
  <rect x="318" y="212" width="88" height="88" rx="10" fill="#f7d31c" transform="rotate(5 362 256)"/>
  <rect x="318" y="328" width="88" height="88" rx="10" fill="#f7f1e4" transform="rotate(-4 362 372)"/>
</svg>`;

const DRAG_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M14 6h24l14 14v36a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#f7d31c" stroke="#070705" stroke-width="3" stroke-linejoin="round"/>
  <path d="M38 6v14h14" fill="#f7f1e4" stroke="#070705" stroke-width="3" stroke-linejoin="round"/>
  <path d="M32 46V28M24 35l8-8 8 8" fill="none" stroke="#070705" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function render(svg, size, file) {
  const window = new BrowserWindow({
    width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true,
    enableLargerThanScreen: true,
  });
  const html = `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = (await window.webContents.capturePage()).resize({ width: size, height: size, quality: 'best' });
  fs.writeFileSync(file, image.toPNG());
  window.destroy();
  console.log(`${path.relative(process.cwd(), file)}  ${size}px`);
}

// Not top-level await: Electron does not become ready until this file has
// finished loading, so waiting for it here would wait forever.
app.on('window-all-closed', () => {}); // closing the first drawing must not quit before the second
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await render(APP_ICON, 1024, path.join(OUT, 'icon.png'));
  await render(DRAG_ICON, 64, path.join(OUT, 'drag.png'));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
