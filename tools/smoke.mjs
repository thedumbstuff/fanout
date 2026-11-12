// End-to-end check of the real app against a throwaway profile and a local
// web server: `npm run smoke`. It drives the interface through the same
// bridge a person's clicks use, and saves screenshots to .smoke/shots.
//
// Simulated typing and scripted page calls appear only here, on the test's
// own local pages. The app itself never does either.

import { app, clipboard } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.smoke');
const SHOTS = path.join(WORK, 'shots');
const FOLDER = path.join(WORK, 'brand folder');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.join(FOLDER, 'reels'), { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'launch clip.mp4'), Buffer.alloc(2048));
fs.writeFileSync(path.join(FOLDER, 'cover.png'), Buffer.alloc(512));
fs.writeFileSync(path.join(FOLDER, 'caption.md'), 'Big news today.\n\nWe are live in three cities. #launch #acme\n');
fs.writeFileSync(path.join(FOLDER, 'reels', 'teaser.mov'), Buffer.alloc(1024));
fs.writeFileSync(path.join(WORK, 'secret.txt'), 'must stay unreadable');
process.env.FANOUT_USER_DATA = path.join(WORK, 'profile');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(100);
  }
  console.log(`     timed out waiting for: ${label}`);
  return false;
}

const PAGES = {
  '/a': '<title>Site A</title><body style="font:20px sans-serif;padding:40px;background:#dff"><h1>Site A upload page</h1><a id="l" href="/b" target="_blank">open B in a new tab</a>',
  '/b': '<title>Site B</title><body style="font:20px sans-serif;padding:40px;background:#fdf"><h1>Site B</h1>',
  '/draft': `<title>Draft</title><body style="margin:0"><textarea id="t" style="width:100vw;height:100vh"></textarea>
    <script>t.addEventListener('input', () => { window.onbeforeunload = (e) => { e.preventDefault(); return 'x'; }; });</script>`,
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[new URL(req.url, 'http://x').pathname];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? 'not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function run(ctx) {
  const server = await serve();
  const site = `http://127.0.0.1:${server.address().port}`;
  const ui = ctx.window.webContents;
  /** Call the bridge from inside the interface, as its own scripts do. */
  const bridge = (method, ...args) =>
    ui.executeJavaScript(`window.fanout.${method}(...${JSON.stringify(args)})`);
  const dom = (expression) => ui.executeJavaScript(expression);
  const shot = async (name, contents = ui) =>
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await contents.capturePage()).toPNG());
  const brand = () => ctx.store.data.brands[0];
  const live = (tab) => ctx.tabs.runtime(tab.id).live;
  const idle = (tab) => live(tab) && !ctx.tabs.runtime(tab.id).loading;

  ctx.window.show();
  await wait(600);

  // ---- first run
  check('starts with no brands', ctx.store.data.brands.length === 0);
  check('welcome screen is shown', await dom(`document.querySelector('#page h1')?.textContent.includes('Every account')`));
  await shot('01-welcome');

  // ---- a brand with two tabs: only the selected one loads
  await bridge('createBrand', { name: 'Acme Foods', color: '#fb5f89', folder: FOLDER, urls: [`${site}/a`, `${site}/b`] });
  const [a, b] = brand().tabs;
  await until(() => idle(a), 'tab A loaded');
  check('selected tab loads', live(a));
  check('other tab stays asleep until opened', !live(b));
  const agent = await ctx.tabs.activeContents().executeJavaScript('navigator.userAgent');
  check('pages see a plain Chrome user agent', /Chrome\//.test(agent) && !/Electron|fanout/i.test(agent), agent.slice(-40));
  await until(() => dom(`document.querySelectorAll('#tree .row').length >= 4`), 'file tree');
  await wait(400);
  await shot('02-brand');
  await shot('02-brand-page', ctx.tabs.activeContents());

  // ---- files: listing, jail, preview, select-to-copy
  const listing = await bridge('listFiles', brand().id, '');
  check('folder is listed, folders first', listing.entries?.map((e) => e.name).join() === 'reels,caption.md,cover.png,launch clip.mp4', listing.entries?.map((e) => e.name).join());
  check('paths outside the folder are refused', (await bridge('readFile', brand().id, '../secret.txt')).error === 'outside');
  check('absolute paths are refused', (await bridge('readFile', brand().id, path.join(WORK, 'secret.txt'))).error === 'outside');

  await dom(`document.querySelector('#tree [data-name="caption.md"]').click()`);
  await until(() => dom(`Boolean(document.querySelector('.preview-text'))`), 'preview');
  check('text file opens in the preview', (await dom(`document.querySelector('.preview-text').textContent`)).startsWith('Big news today.'));
  await clipboard.writeText('');
  await dom(`(() => {
    const node = document.querySelector('.preview-text').firstChild;
    const range = document.createRange();
    range.setStart(node, 17); range.setEnd(node, 59);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    document.querySelector('.preview-text').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await until(async () => (await clipboard.readText()).length > 0, 'clipboard');
  const copied = await clipboard.readText();
  check('selecting text copies it', copied === 'We are live in three cities. #launch #acme', JSON.stringify(copied));

  // ---- posted tracker
  await dom(`document.querySelector('#tree [data-name="launch clip.mp4"] .mark').click()`);
  await until(() => dom(`document.querySelectorAll('#tree [data-name="launch clip.mp4"] .mark.is-on').length === 1`), 'first mark');
  check('a mark is saved for the tab', Boolean(ctx.posted.forBrand(brand().id)['launch clip.mp4']?.[a.id]));
  check('text files carry no marks', await dom(`document.querySelector('#tree [data-name="caption.md"] .mark') === null`));
  await bridge('setPosted', brand().id, 'launch clip.mp4', b.id, true);
  ctx.send('posted:changed', brand().id, 'launch clip.mp4', ctx.posted.forBrand(brand().id)['launch clip.mp4']);
  await until(() => dom(`Boolean(document.querySelector('#tree [data-name="launch clip.mp4"].is-done'))`), 'done row');
  check('posted everywhere is highlighted', await dom(`Boolean(document.querySelector('#tree [data-name="launch clip.mp4"].is-done'))`));
  await dom(`document.querySelector('#tree [data-name="reels"]').click()`);
  await until(() => dom(`Boolean(document.querySelector('#tree [data-name="teaser.mov"]'))`), 'subfolder');
  check('a subfolder opens on demand', ctx.watcher.size === 2, `${ctx.watcher.size} folders watched`);
  await wait(300);
  await shot('03-files-posted');

  // ---- memory: limit of one loaded tab
  await bridge('selectTab', b.id);
  await until(() => idle(b), 'tab B loaded');
  check('both tabs loaded', live(a) && live(b));
  await bridge('updateSettings', { maxLiveTabs: 1 });
  await until(() => !live(a), 'tab A asleep');
  check('over the limit, the background tab sleeps', !live(a) && live(b));
  check('its address is kept', a.url === `${site}/a`);
  const afterSleep = ctx.tabs.metrics();
  check('memory is reported', afterSleep.totalMB > 0 && afterSleep.live === 1, `${afterSleep.totalMB} MB, ${afterSleep.live} loaded`);

  // ---- unsaved work keeps a tab awake
  await bridge('updateSettings', { maxLiveTabs: 6 });
  await bridge('selectTab', a.id);
  await until(() => idle(a), 'tab A awake again');
  check('a sleeping tab loads again when opened', live(a));
  await bridge('navigate', a.id, `${site}/draft`);
  await until(() => idle(a) && a.url.endsWith('/draft'), 'draft page');
  const draft = ctx.tabs.activeContents();
  draft.focus();
  draft.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 });
  draft.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 });
  for (const ch of 'half a caption') draft.sendInputEvent({ type: 'char', keyCode: ch });
  await until(() => draft.executeJavaScript('t.value.length > 5 && Boolean(window.onbeforeunload)'), 'typed text');
  await bridge('selectTab', b.id);
  await bridge('updateSettings', { maxLiveTabs: 1 });
  await until(() => ctx.tabs.runtime(a.id).holding, 'refusal', 6000);
  check('a tab with unsaved typing refuses to sleep', live(a) && ctx.tabs.runtime(a.id).holding);
  await bridge('updateSettings', { maxLiveTabs: 6 });

  // ---- a page asks for a new tab
  await bridge('navigate', b.id, `${site}/a`);
  await until(() => idle(b) && b.url.endsWith('/a'), 'page A in tab B');
  await ctx.tabs.activeContents().executeJavaScript(`document.getElementById('l').click()`, true);
  await until(() => brand().tabs.length === 3, 'third tab');
  const opened = brand().tabs.find((tab) => tab.temp);
  check('a link to a new tab opens next to its opener', brand().tabs.indexOf(opened) === brand().tabs.indexOf(b) + 1);
  check('that tab is not a posting destination', await dom(`document.querySelectorAll('#tree [data-name="cover.png"] .mark').length === 2`));
  await until(() => idle(opened), 'opened tab loaded');
  await bridge('closeTab', opened.id);
  await until(() => brand().tabs.length === 2, 'tab closed');
  check('closing a tab removes it', brand().tabs.length === 2 && !live(opened));

  // ---- refused and failed addresses
  check('file: addresses are refused', (await bridge('navigate', b.id, 'file:///C:/Windows/win.ini')) === false);
  await bridge('navigate', b.id, 'http://127.0.0.1:9/');
  await until(() => Boolean(ctx.tabs.runtime(b.id).error), 'load error');
  await wait(300);
  check('a page that will not load says so', await dom(`document.querySelector('#page h1')?.textContent === 'This page did not load.'`));
  await shot('04-load-error');
  await bridge('navigate', b.id, `${site}/b`);
  await until(() => idle(b) && !ctx.tabs.runtime(b.id).error && b.url.endsWith('/b'), 'recovery');
  check('and recovers when a good address is opened', !ctx.tabs.runtime(b.id).error && b.title === 'Site B', b.title);

  // ---- dialogs hide the page layer
  await dom(`document.getElementById('open-settings').click()`);
  await wait(300);
  check('settings dialog opens', await dom(`Boolean(document.querySelector('dialog[open]'))`));
  await shot('05-settings');
  await dom(`document.querySelector('dialog[open] .primary').click()`);

  // ---- saving and deleting
  ctx.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.FANOUT_USER_DATA, 'fanout.json'), 'utf8'));
  check('brands and tabs are saved', saved.brands[0]?.name === 'Acme Foods' && saved.brands[0].tabs.length === 2);
  check('nothing was written outside the profile and folder', !fs.existsSync(path.join(FOLDER, 'fanout.json')));
  await ctx.deleteBrand(brand().id, { ask: false });
  await wait(500);
  check('deleting a brand closes its pages', ctx.store.data.brands.length === 0 && ctx.tabs.metrics().live === 0);

  server.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed. Screenshots: ${SHOTS}`);
  return failed ? 1 : 0;
}

import('../src/main/main.js')
  .then(({ ready }) => ready)
  .then((ctx) => run(ctx))
  .then((code) => app.exit(code))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
