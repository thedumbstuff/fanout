// Measures what tabs cost and what sleeping gives back, on real sites:
//   npm run measure
// Opens the public front pages below (signed out, in a throwaway profile),
// reads memory with every tab loaded, puts all but one to sleep, reads again.

import { app, webContents } from 'electron';
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

/** Memory by kind of process, e.g. "Tab x6 1400MB, GPU x1 300MB". */
function breakdown() {
  const kinds = new Map();
  for (const metric of app.getAppMetrics()) {
    const kind = metric.type === 'Utility' ? (metric.name || metric.serviceName || 'Utility') : metric.type;
    const entry = kinds.get(kind) ?? { count: 0, kb: 0 };
    entry.count += 1;
    entry.kb += metric.memory.workingSetSize;
    kinds.set(kind, entry);
  }
  return [...kinds].map(([kind, { count, kb }]) => `${kind} x${count} ${Math.round(kb / 1024)}MB`).join(', ');
}

let refusals = 0;
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-prevent-unload', () => { refusals += 1; });
});

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

  console.log('all loaded:      ', breakdown());
  const active = tabs.activeTabId();
  for (const tab of brand.tabs) {
    if (tab.id !== active) tabs.sleep(tab.id, { auto: true });
  }
  await wait(4000);
  console.log('4s after sleep:  ', breakdown());
  await wait(40000);
  console.log('44s after sleep: ', breakdown());
  const slept = tabs.metrics();
  // Which page processes are left, and what they belong to.
  const owners = new Map();
  for (const contents of webContents.getAllWebContents()) {
    const pid = contents.getOSProcessId();
    owners.set(pid, [...(owners.get(pid) ?? []), contents.getURL().slice(0, 50) || contents.getType()]);
  }
  for (const metric of app.getAppMetrics().filter((m) => m.type === 'Tab')) {
    console.log(`    left: pid ${metric.pid} ${Math.round(metric.memory.workingSetSize / 1024)} MB  ${(owners.get(metric.pid) ?? ['(no page: worker or spare)']).join(' + ')}`);
  }

  console.log(`fanout with no tabs          ${idle} MB`);
  console.log(`${loaded.live} tabs loaded                ${loaded.totalMB} MB`);
  for (const tab of brand.tabs) {
    console.log(`    ${new URL(tab.homeUrl).hostname.padEnd(22)} ${String(loaded.tabs[tab.id] ?? '-').padStart(5)} MB`);
  }
  console.log(`${slept.live} loaded, ${brand.tabs.length - slept.live} asleep          ${slept.totalMB} MB`);
  console.log(`given back by sleeping       ${loaded.totalMB - slept.totalMB} MB`);
  console.log(`pages that refused to sleep  ${refusals}`);
}

import('../src/main/main.js')
  .then(({ ready }) => ready)
  .then(async (ctx) => {
    await run(ctx);
    ctx.window.close(); // the app's own way out
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
