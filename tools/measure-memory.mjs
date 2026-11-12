// Measures what tabs cost and what sleeping gives back, on real sites:
//   npm run measure
// Opens the public front pages below (signed out, in a throwaway profile),
// reads memory with every tab loaded, puts all but one to sleep, reads again.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SITES = [
  'https://www.youtube.com/',
  'https://www.linkedin.com/',
  'https://www.tiktok.com/',
  'https://www.instagram.com/',
  'https://x.com/',
  'https://www.facebook.com/',
];
const WORK = path.join(import.meta.dirname, '..', '.smoke', 'measure');
fs.rmSync(WORK, { recursive: true, force: true });
process.env.FANOUT_USER_DATA = WORK;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(ctx) {
  const { tabs, store } = ctx;
  ctx.window.show();
  await wait(1500);
  const idle = tabs.metrics().totalMB;

  store.data.settings.maxLiveTabs = 0;
  store.data.settings.sleepAfterMinutes = 0;
  await ctx.window.webContents.executeJavaScript(
    `window.fanout.createBrand(${JSON.stringify({ name: 'Measure', color: '#2f6fed', folder: '', urls: SITES })})`);
  const brand = store.data.brands[0];
  for (const tab of brand.tabs) {
    tabs.select(tab.id);
    await wait(9000); // long enough for a heavy front page to settle
  }
  const loaded = tabs.metrics();

  tabs.sleepOthers();
  await wait(5000);
  const slept = tabs.metrics();

  console.log(`fanout with no tabs          ${idle} MB`);
  console.log(`${loaded.live} tabs loaded                ${loaded.totalMB} MB`);
  for (const tab of brand.tabs) {
    console.log(`    ${new URL(tab.homeUrl).hostname.padEnd(22)} ${String(loaded.tabs[tab.id] ?? '-').padStart(5)} MB`);
  }
  console.log(`${slept.live} loaded, ${brand.tabs.length - slept.live} asleep          ${slept.totalMB} MB`);
  console.log(`given back by sleeping       ${loaded.totalMB - slept.totalMB} MB`);
}

import('../src/main/main.js')
  .then(({ ready }) => ready)
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
