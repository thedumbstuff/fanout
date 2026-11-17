// End-to-end check of the real app against a throwaway profile and a local
// web server: `npm run smoke`. It drives the interface through the same
// bridge a person's clicks use, and saves screenshots to .smoke/shots.
//
// Simulated typing and scripted page calls appear only here, on the test's
// own local pages. The app itself never does either.

// The media viewer's scheme has to be registered before the app is ready, and
// main.js is loaded only later (after the throwaway profile is chosen).
import '../src/main/mediaprotocol.js';
import { app, clipboard, Menu } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tabMenuTemplate } from '../src/main/menus.js';
import { sanitize, tabLabel, UNNAMED_TAB } from '../src/main/model.js';
import { JsonStore } from '../src/main/store.js';
import { mediaUrl } from '../src/renderer/viewer.js';
import { encodeWebm, picture, record, wav, workshop } from './media-fixtures.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.smoke');
const SHOTS = path.join(WORK, 'shots');
const FOLDER = path.join(WORK, 'brand folder');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.join(FOLDER, 'reels'), { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'launch clip.mp4'), Buffer.alloc(2048));
fs.writeFileSync(path.join(FOLDER, 'cover.png'), Buffer.alloc(512));
// A caption as people write them: Markdown, and a line of hashtags (not a heading).
const CAPTION = 'Big news today.\n\nWe are **live** in three cities.\n#launch #acme\n';
fs.writeFileSync(path.join(FOLDER, 'caption.md'), CAPTION);
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
  // Pages for the tab drags: one address each, so a page tells which tab it is.
  ...Object.fromEntries(['c', 'd', 'e', 'f', 'g', 'h'].map((x) => [`/${x}`,
    `<title>Site ${x.toUpperCase()}</title><body style="font:20px sans-serif;padding:40px;background:#ffd"><h1>Site ${x.toUpperCase()}</h1>`])),
  '/draft': `<title>Draft</title><body style="margin:0"><textarea id="t" style="width:100vw;height:100vh"></textarea>
    <script>t.addEventListener('input', () => { window.onbeforeunload = (e) => { e.preventDefault(); return 'x'; }; });</script>`,
};

const ICON = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));
const requested = []; // every path the test server was asked for
const received = new Map(); // path -> the request headers it last came with

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://x');
      requested.push(pathname);
      received.set(pathname, req.headers);
      // A site refusing a browser it does not like, the quiet way: an error and no text.
      if (pathname === '/refuse') {
        res.writeHead(403);
        return res.end();
      }
      // A real icon, as every site has: a tab then shows it as a picture, and
      // a picture is what a system drag would start from.
      if (pathname === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(ICON);
      }
      const body = PAGES[pathname];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? 'not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function run(ctx) {
  const server = await serve();
  const site = `http://127.0.0.1:${server.address().port}`;
  // Markdown that tries to reach out: a link, a javascript: link, a picture, raw HTML.
  fs.writeFileSync(path.join(FOLDER, 'reels', 'links.md'), [
    '## Where to post',
    '',
    `- [Site B](${site}/b)`,
    '- [Not a web page](javascript:alert(1))',
    `- ![Our logo](${site}/logo.png)`,
    '- <b onclick="alert(1)">raw html</b>',
    '',
    '| Site | Posts |',
    '| --- | ---: |',
    '| B | 3 |',
    '',
  ].join('\n'));
  const ui = ctx.window.webContents;
  /** Call the bridge from inside the interface, as its own scripts do. */
  const bridge = (method, ...args) =>
    ui.executeJavaScript(`window.fanout.${method}(...${JSON.stringify(args)})`);
  const dom = (expression) => ui.executeJavaScript(expression);
  // A screenshot is for a person to look at; a window that cannot be captured
  // right now (minimised, screen locked) must not fail the checks.
  const shot = async (name, contents = ui) => {
    try {
      // capturePage gives the last frame drawn, which can be one step behind: ask for a fresh one.
      contents.invalidate();
      await wait(250);
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await contents.capturePage()).toPNG());
    } catch (error) {
      console.log(`     no screenshot ${name}: ${error.message}`);
    }
  };
  const brand = () => ctx.store.data.brands[0];
  const live = (tab) => ctx.tabs.runtime(tab.id).live;
  const idle = (tab) => live(tab) && !ctx.tabs.runtime(tab.id).loading;
  /** The pages attached to the window right now, with where they sit. */
  const attached = () => ctx.window.contentView.children.filter((view) => view.webContents && view.webContents !== ui);

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
  // What a site is told fanout is: Electron's own user agent, unchanged, the same in the
  // request and in the page. Its product token is the app's name and version: "fanout/0.2.0"
  // when installed or started with `electron .`, "Electron/45.3.0" in this source run.
  const told = await ctx.tabs.activeContents().executeJavaScript(`({ agent: navigator.userAgent,
    brands: (navigator.userAgentData?.brands ?? []).map((b) => b.brand + ' ' + b.version) })`);
  const sent = received.get('/a') ?? {};
  // Client hint headers, if Chromium sends any, must name the same brands the page reports.
  const hinted = sent['sec-ch-ua'] ? [...sent['sec-ch-ua'].matchAll(/"([^"]+)";v="([^"]+)"/g)].map(([, b, v]) => `${b} ${v}`) : null;
  const chromium = `Chromium ${process.versions.chrome.split('.')[0]}`;
  check('sites see fanout as it is: its own user agent, the same in the request and the page; brands untouched',
    sent['user-agent'] === told.agent && told.agent === app.userAgentFallback &&
    told.agent.includes(` ${app.getName()}/${app.getVersion()} `) && told.agent.includes(` Electron/${process.versions.electron} `) &&
    told.agent.includes(` Chrome/${process.versions.chrome} `) && told.brands.includes(chromium) &&
    !told.brands.some((brand) => brand.startsWith('Google Chrome')) &&
    (hinted === null || hinted.toSorted().join() === told.brands.toSorted().join()),
    `header ${sent['user-agent']}; Sec-CH-UA ${sent['sec-ch-ua'] ?? 'not sent'}; page brands ${told.brands.join(', ')}`);
  await until(() => dom(`document.querySelectorAll('#tree .row').length >= 4`), 'file tree');
  await wait(400);
  await shot('02-brand');
  await shot('02-brand-page', ctx.tabs.activeContents());

  // ---- files: listing, jail, preview, select-to-copy
  const listing = await bridge('listFiles', brand().id, '');
  check('folder is listed, folders first', listing.entries?.map((e) => e.name).join() === 'reels,caption.md,cover.png,launch clip.mp4', listing.entries?.map((e) => e.name).join());
  check('paths outside the folder are refused', (await bridge('readFile', brand().id, '../secret.txt')).error === 'outside');
  check('absolute paths are refused', (await bridge('readFile', brand().id, path.join(WORK, 'secret.txt'))).error === 'outside');

  // ---- text preview: Markdown shown formatted, or as written (Source); select-to-copy in both
  /** Select in the preview as a drag would (`range` is set up by the script), then let go of the mouse. */
  const selectIn = (script) => dom(`(() => {
    const range = document.createRange();
    ${script}
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    document.getElementById('preview').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  /** What is on the clipboard after doing something. */
  const copiedAfter = async (act) => {
    await clipboard.writeText('');
    await act();
    await until(async () => (await clipboard.readText()).length > 0, 'clipboard');
    return (await clipboard.readText()).replace(/\r\n/g, '\n');
  };
  const previewButton = (act) => `document.querySelector('#preview [data-act="${act}"]')`;

  await dom(`document.querySelector('#tree [data-name="caption.md"]').click()`);
  await until(() => dom(`Boolean(document.querySelector('.preview-md'))`), 'preview');
  check('text file opens in the preview', (await dom(`document.querySelector('.preview-md').textContent`)).startsWith('Big news today.'));
  const formatted = await dom(`(() => {
    const md = document.querySelector('.preview-md');
    return { bold: md.querySelector('strong')?.textContent, headings: md.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
      paragraphs: [...md.querySelectorAll('p')].map((p) => p.innerText) };
  })()`);
  check('a Markdown file is shown formatted; its hashtag line stays text', formatted.bold === 'live' && formatted.headings === 0 &&
    formatted.paragraphs.join('|') === 'Big news today.|We are live in three cities.\n#launch #acme', JSON.stringify(formatted));
  const selected = await copiedAfter(() => selectIn(`range.selectNodeContents(document.querySelectorAll('.preview-md p')[1]);`));
  check('selecting formatted text copies it without Markdown signs', selected === 'We are live in three cities.\n#launch #acme',
    JSON.stringify(selected));
  const readsTitle = await dom(`${previewButton('copy-all')}.title`);
  const reads = await copiedAfter(() => dom(`${previewButton('copy-all')}.click()`));
  check('copying the whole formatted file copies it as it reads, and says so',
    reads === 'Big news today.\n\nWe are live in three cities.\n#launch #acme' && /without the Markdown/.test(readsTitle), JSON.stringify(reads));
  await shot('03-markdown-formatted');

  await dom(`${previewButton('source')}.click()`);
  await until(() => dom(`Boolean(document.querySelector('#preview .preview-text'))`), 'source view');
  const [from, to] = [CAPTION.indexOf('We are'), CAPTION.indexOf('#acme') + '#acme'.length];
  const raw = await copiedAfter(() => selectIn(`
    const node = document.querySelector('.preview-text').firstChild;
    range.setStart(node, ${from}); range.setEnd(node, ${to});`));
  check('Source shows the file as it is written; selecting there copies the Markdown',
    await dom(`document.querySelector('.preview-text').textContent`) === CAPTION && raw === CAPTION.slice(from, to) &&
    await dom(`${previewButton('source')}.getAttribute('aria-pressed') === 'true'`), JSON.stringify(raw));
  const writtenTitle = await dom(`${previewButton('copy-all')}.title`);
  const written = await copiedAfter(() => dom(`${previewButton('copy-all')}.click()`));
  check('copying the whole file in Source copies it exactly as written, and says so',
    written === CAPTION && /as it is written/.test(writtenTitle), JSON.stringify(written));
  await dom(`document.querySelector('#preview .tool[title="Close"]').click()`);
  await dom(`document.querySelector('#tree [data-name="caption.md"]').click()`);
  await until(() => dom(`Boolean(document.querySelector('#preview .preview-text'))`), 'the file again');
  check('the Source choice is kept for the next file opened', await dom(`${previewButton('source')}?.getAttribute('aria-pressed') === 'true'`));
  await dom(`${previewButton('source')}.click()`);
  await until(() => dom(`Boolean(document.querySelector('#preview .preview-md'))`), 'formatted again');

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

  // ---- Markdown cannot reach out: no picture is fetched, HTML is text, only web links open
  await dom(`document.querySelector('#tree [data-name="links.md"]').click()`);
  await until(() => dom(`Boolean(document.querySelector('#preview .md-link'))`), 'links file');
  await wait(300);
  const safe = await dom(`(() => {
    const md = document.querySelector('.preview-md');
    return { images: md.querySelectorAll('img').length, picture: md.querySelector('.md-picture')?.textContent,
      bold: md.querySelectorAll('b').length, html: md.textContent.includes('<b onclick="alert(1)">raw html</b>'),
      heading: md.querySelector('h2')?.textContent, cells: [...md.querySelectorAll('th, td')].map((c) => c.textContent).join(),
      right: md.querySelector('td.is-right')?.textContent };
  })()`);
  check('pictures are not fetched, raw HTML is text, a table is drawn',
    safe.images === 0 && safe.picture === 'Our logo' && safe.bold === 0 && safe.html && safe.heading === 'Where to post' &&
    safe.cells === 'Site,Posts,B,3' && safe.right === '3' && !requested.includes('/logo.png'), JSON.stringify(safe));
  await shot('03-markdown-links');
  const tabsBefore = brand().tabs.length;
  await dom(`getSelection().removeAllRanges(); document.querySelector('#preview .md-link-off').click()`);
  await wait(400);
  const inert = brand().tabs.length === tabsBefore && await dom(`document.querySelector('#preview .md-link-off').tagName === 'SPAN'`);
  await dom(`getSelection().removeAllRanges(); document.querySelector('#preview .md-link').click()`);
  await until(() => brand().tabs.length === tabsBefore + 1, 'a tab from the link');
  const fromLink = brand().tabs.at(-1);
  check('a web link opens as a new tab of the brand; a javascript: link does nothing',
    inert && fromLink?.url === `${site}/b` && brand().activeTabId === fromLink?.id, fromLink?.url);
  await bridge('closeTab', fromLink.id);
  await until(() => brand().tabs.length === tabsBefore, 'that tab closed');
  await bridge('selectTab', a.id);

  // ---- media viewer: videos, pictures and sounds, streamed in byte ranges, only to the interface
  ui.setAudioMuted(true); // the owner is at this PC: nothing this test plays is heard
  // Chromium pauses a silent video on a page it thinks is hidden, and a window covered by
  // another counts as hidden. The owner works while this runs, so for these checks the
  // interface stays "visible" (this also keeps its screenshots current). Restored below.
  ui.setBackgroundThrottling(false);
  const interfaceMB = () => {
    const metric = app.getAppMetrics().find((m) => m.pid === ui.getOSProcessId());
    return Math.round((metric?.memory.privateBytes ?? metric?.memory.workingSetSize ?? 0) / 1024);
  };
  const memoryBefore = interfaceMB();
  const CLIPS = path.join(FOLDER, 'clips');
  fs.mkdirSync(CLIPS);
  const shop = await workshop(WORK);
  const made = Date.now();
  fs.writeFileSync(path.join(CLIPS, 'launch reel.mp4'),
    await record(shop, 'video/mp4;codecs=avc1.640028', { width: 1080, height: 1920, seconds: 2 })); // H.264 High 4.0: phone size
  fs.writeFileSync(path.join(CLIPS, 'long take.webm'),
    await encodeWebm(shop, { width: 640, height: 360, fps: 10, seconds: 24, bitrate: 8_000_000 }));
  fs.writeFileSync(path.join(CLIPS, 'poster.jpg'), await picture(shop, 'image/jpeg', { width: 1080, height: 1350 }));
  fs.writeFileSync(path.join(CLIPS, 'voice.wav'), wav({ seconds: 3 }));
  // A picture with a script in it, which must never run (it is shown as an image, never inlined).
  fs.writeFileSync(path.join(CLIPS, 'badge.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="600" height="600" fill="#f7d31c"/><circle cx="300" cy="300" r="200" fill="#fb5f89"/>
    <script>fetch('${site}/svg-script-ran')</script></svg>`);
  shop.destroy();
  const longTake = fs.statSync(path.join(CLIPS, 'long take.webm')).size;
  console.log(`     test media made in ${Date.now() - made} ms (long take ${(longTake / 1048576).toFixed(1)} MB)`);

  await until(() => dom(`Boolean(document.querySelector('#tree [data-name="clips"]'))`), 'the clips folder in the tree');
  await dom(`document.querySelector('#tree [data-name="clips"]').click()`);
  await until(() => dom(`document.querySelectorAll('#tree [data-rel^="clips/"]').length === 5`), 'the clips listed');
  ctx.media.trace = [];
  const viewer = () => dom(`(() => {
    const p = document.getElementById('preview');
    const v = p.querySelector('video, audio');
    const img = p.querySelector('img.media-picture');
    return { ready: p.dataset.ready ?? null, name: p.querySelector('.preview-name')?.textContent ?? null,
      facts: p.querySelector('.media-facts')?.textContent ?? null, large: p.classList.contains('is-large'),
      paused: v ? v.paused : null, time: v ? v.currentTime : null, width: v?.videoWidth ?? img?.naturalWidth ?? null,
      media: document.querySelectorAll('video, audio').length, pictures: p.querySelectorAll('img').length,
      problem: p.querySelector('.media-problem-title')?.textContent ?? null,
      open: p.querySelector('[data-act="open"]')?.textContent ?? null, hidden: p.hidden,
      stray: [...p.childNodes].some((node) => node.nodeType === Node.TEXT_NODE) }; // e.g. a "null" written by mistake
  })()`);
  const showFile = async (name) => {
    await dom(`document.querySelector('#tree [data-name="${name}"]').click()`);
    await until(async () => { const v = await viewer(); return v.name === name && v.ready !== null; }, `${name} in the viewer`);
    return viewer();
  };

  const reel = await showFile('launch reel.mp4');
  const reelControls = await dom(`(() => { const v = document.querySelector('#preview video');
    return { controls: v.controls, preload: v.preload, pip: v.disablePictureInPicture }; })()`);
  check('a video opens in the viewer with its size, shape, length and file size; nothing plays by itself',
    reel.ready === '1' && /^1080 × 1920, vertical 9:16 · 0:0[12]\.\d · [\d.]+ (KB|MB)$/.test(reel.facts) && reel.paused &&
    reel.time === 0 && reel.media === 1 && reelControls.preload === 'metadata' && !reelControls.controls && reelControls.pip,
    `${reel.facts}; ${JSON.stringify(reelControls)}`);
  await dom(`document.querySelector('#preview [data-act="play"]').click()`);
  const played = await until(async () => (await viewer()).time > 0.5, 'the video playing', 6000);
  const playing = await dom(`({ label: document.querySelector('#preview [data-act="play"]').ariaLabel,
    clock: document.querySelector('.media-time').textContent, visibility: document.visibilityState })`);
  await shot('11-video-in-panel');
  await dom(`document.querySelector('#preview [data-act="play"]').click()`);
  await wait(200);
  check('it plays (the test window is muted) and pauses with its own button',
    played && playing.label === 'Pause' && /^0:0\d \/ 0:0[12]$/.test(playing.clock) && (await viewer()).paused, JSON.stringify(playing));

  // A larger file: seeking far into it must ask for that part of the file, not read it all.
  ctx.media.trace = [];
  const long = await showFile('long take.webm');
  const sought = await dom(`(() => {
    const v = document.querySelector('#preview video');
    const slider = document.querySelector('#preview .media-seek');
    return new Promise((resolve) => {
      v.addEventListener('seeked', () => setTimeout(() => resolve({ t: v.currentTime, d: v.duration, state: v.readyState }), 300), { once: true });
      slider.value = String(v.duration * 0.9);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`);
  await wait(300);
  const asked = ctx.media.trace.filter((entry) => entry.rel === 'clips/long take.webm');
  const read = asked.reduce((sum, entry) => sum + entry.bytes, 0);
  const far = asked.find((entry) => entry.status === 206 && entry.start > longTake * 0.8);
  await shot('12-seeked');
  check('seeking to 90% of a 23 MB video asks for that part of the file in byte ranges; most of it is never read',
    long.facts === `640 × 360, horizontal 16:9 · 0:24.0 · ${(longTake / 1048576).toFixed(1)} MB` &&
    Math.abs(sought.t - sought.d * 0.9) < 1.5 && sought.state >= 2 && Boolean(far) && read < longTake * 0.6 &&
    asked.every((entry) => entry.origin === 'file://'),
    `${long.facts}; at ${sought.t.toFixed(1)} s; ${asked.length} requests, first far one "${far?.range}"; ` +
    `${(read / 1048576).toFixed(1)} of ${(longTake / 1048576).toFixed(1)} MB read`);

  // The large view: over the tab strip, toolbar and pages, which are hidden; arrows step; Esc comes back.
  const pagesBefore = attached().length;
  await dom(`document.querySelector('#preview [data-act="large"]').click()`);
  await until(() => attached().length === 0, 'the pages hidden');
  await wait(300);
  const over = await dom(`(() => {
    const view = document.getElementById('preview').getBoundingClientRect();
    const page = document.getElementById('page').getBoundingClientRect();
    const strip = document.getElementById('tabstrip').getBoundingClientRect();
    return { covers: view.left <= page.left + 1 && view.right >= page.right - 1 && view.top <= strip.top && view.bottom >= page.bottom - 1,
      focused: document.activeElement?.classList.contains('media-stage') ?? false, back: document.querySelector('#preview [data-act="small"]')?.textContent };
  })()`);
  await shot('13-large-video');
  await dom(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await until(async () => (await viewer()).name === 'poster.jpg' && (await viewer()).ready === '1', 'the next file, large');
  const poster = await viewer();
  const selectedRow = await dom(`document.querySelector('#tree .row.is-selected')?.dataset.name`);
  await shot('14-large-picture');
  const stillHidden = attached().length === 0;
  await dom(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => attached().length === pagesBefore, 'the pages back');
  const after = await viewer();
  check('the larger view covers the page area and hides the pages; the arrow key shows the next file; Esc brings the pages back',
    pagesBefore >= 1 && over.covers && over.focused && over.back === 'Back to the pages' && poster.large && stillHidden &&
    selectedRow === 'poster.jpg' && !after.large && attached().length === pagesBefore && !ctx.tabs.runtime(a.id).error,
    `${JSON.stringify(over)}; pages ${pagesBefore} -> 0 -> ${attached().length}`);
  check('a picture shows its size, shape and file size, and nothing stray under it',
    /^1080 × 1350, vertical 4:5 · \d+ KB$/.test(poster.facts) && poster.pictures === 1 && poster.media === 0 && !poster.stray,
    poster.facts);

  const badge = await showFile('badge.svg');
  await wait(500);
  check('an SVG is shown as a picture; the script inside it never runs',
    badge.ready === '1' && badge.width === 600 && !requested.includes('/svg-script-ran'), `${badge.facts}`);
  const voice = await showFile('voice.wav');
  check('a sound file opens with its length and play controls, no picture',
    voice.ready === '1' && /^0:03\.0 · 258 KB$/.test(voice.facts) && voice.media === 1 && voice.pictures === 0 &&
    await dom(`Boolean(document.querySelector('#preview [data-act="play"]')) && !document.querySelector('#preview video')`), voice.facts);

  // A file the player cannot read (the folder's "launch clip.mp4" is 2 KB of zeros).
  const broken = await showFile('launch clip.mp4');
  await shot('15-cannot-play');
  check('a video that cannot be played says so in words and offers the default app; no empty box, no element left',
    broken.ready === 'failed' && broken.problem === 'This video cannot be played here.' &&
    broken.open === 'Open in the default app' && broken.media === 0 && !broken.stray && ctx.media.openStreams === 0,
    JSON.stringify(broken));

  // Pages in tabs cannot reach the address: their sessions have no such scheme.
  ctx.media.trace = [];
  const mediaAddress = mediaUrl(brand().id, 'clips/launch reel.mp4');
  const fromPage = await ctx.tabs.activeContents().executeJavaScript(`(async () => {
    const tryElement = (tag) => new Promise((resolve) => {
      const el = document.createElement(tag);
      el.onerror = () => resolve('refused');
      el.onload = el.onloadedmetadata = () => resolve('LOADED');
      setTimeout(() => resolve('no answer'), 4000);
      el.src = ${JSON.stringify(mediaAddress)};
      document.body.append(el);
    });
    let fetched;
    try { await fetch(${JSON.stringify(mediaAddress)}); fetched = 'LOADED'; } catch { fetched = 'refused'; }
    return { video: await tryElement('video'), img: await tryElement('img'), fetched };
  })()`);
  check('a page in a tab cannot load a media address; nothing it tries reaches the media server',
    fromPage.video === 'refused' && fromPage.img === 'refused' && fromPage.fetched === 'refused' && ctx.media.trace.length === 0,
    `${JSON.stringify(fromPage)}; ${ctx.media.trace.length} requests reached the server`);

  // Closing lets go of everything: no element, no open file, memory back down.
  await showFile('long take.webm');
  await dom(`document.querySelector('#preview [data-act="play"]').click()`);
  await until(async () => (await viewer()).time > 1, 'the long take playing', 6000);
  const memoryPlaying = interfaceMB();
  const streamsPlaying = ctx.media.openStreams;
  await dom(`document.querySelector('#preview [data-act="close"]').click()`);
  const closed = await until(async () => ctx.media.openStreams === 0 && (await viewer()).hidden, 'everything let go', 5000);
  const left = await viewer();
  await wait(2000);
  const memoryAfter = interfaceMB();
  check('closing the viewer leaves no media element and no open file',
    closed && left.media === 0 && left.pictures === 0 && ctx.media.openStreams === 0,
    `streams ${streamsPlaying} while playing, ${ctx.media.openStreams} after; interface memory ${memoryBefore} MB before, ` +
    `${memoryPlaying} MB playing, ${memoryAfter} MB 2 s after closing`);

  // The file disappears while it is shown: the viewer closes.
  fs.copyFileSync(path.join(CLIPS, 'launch reel.mp4'), path.join(CLIPS, 'gone soon.mp4'));
  await until(() => dom(`Boolean(document.querySelector('#tree [data-name="gone soon.mp4"]'))`), 'the copy listed');
  await showFile('gone soon.mp4');
  fs.rmSync(path.join(CLIPS, 'gone soon.mp4'));
  const vanished = await until(async () => (await viewer()).hidden, 'the viewer closing', 5000);
  check('a file deleted while it is shown closes the viewer and its file',
    vanished && (await viewer()).media === 0 && ctx.media.openStreams === 0);
  await dom(`document.querySelector('#tree [data-name="clips"]').click()`); // close the folder again
  ui.setBackgroundThrottling(true);
  await wait(300);

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

  // A site that refuses fanout with an error and no text: the page stays empty, so the
  // address bar says what the site answered.
  await bridge('navigate', b.id, `${site}/refuse`);
  await until(() => idle(b) && ctx.tabs.runtime(b.id).answer, 'the refusal');
  await wait(300);
  const refused = await dom(`(() => { const el = document.getElementById('answer'); return el.hidden ? null : el.textContent; })()`);
  await shot('04-refused');
  await bridge('navigate', b.id, `${site}/b`);
  await until(() => idle(b) && !ctx.tabs.runtime(b.id).answer, 'the page again');
  await wait(300);
  check('a site that refuses a page without a word is not silent: the address bar says what it answered',
    refused === 'Site answered 403 Forbidden' && await dom(`document.getElementById('answer').hidden`), String(refused));

  // ---- split view: pages side by side, remembered per brand
  await bridge('selectTab', a.id);
  await bridge('setLayout', brand().id, { count: 2 });
  await until(() => idle(a) && idle(b), 'both panes loaded');
  check('two panes show two tabs at once', brand().panes.join() === [a.id, b.id].join() && live(a) && live(b));
  await until(() => dom(`document.querySelectorAll('#page .pane').length === 2`), 'pane boxes');
  const rects = await dom(`[...document.querySelectorAll('#page .pane-body')].map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)]; })`);
  check('panes sit side by side', rects.length === 2 && rects[1][0] > rects[0][0] + rects[0][1] - 1, JSON.stringify(rects));
  await bridge('setLayout', brand().id, { x: 0.7 });
  await wait(300);
  const wider = await dom(`Math.round(document.querySelector('#page .pane-body').getBoundingClientRect().width)`);
  check('the divider resizes them', wider > rects[0][1] + 50, `${rects[0][1]}px -> ${wider}px`);
  await bridge('focusPane', brand().id, 1);
  check('focusing a pane points the address bar at its tab', brand().activeTabId === b.id);
  await bridge('setLayout', brand().id, { count: 4 });
  await wait(300);
  check('four panes, the spare ones empty', brand().panes.length === 4 && brand().panes[2] === null &&
    await dom(`document.querySelectorAll('#page .pane').length === 4`));
  await shot('05-four-panes');
  await bridge('updateSettings', { maxLiveTabs: 1 });
  await wait(1500);
  check('tabs on screen are never put to sleep', live(a) && live(b));
  await bridge('updateSettings', { maxLiveTabs: 6 });
  await bridge('setLayout', brand().id, { count: 2 });

  // ---- dialogs hide the page layer
  await dom(`document.getElementById('open-settings').click()`);
  await wait(300);
  check('settings dialog opens', await dom(`Boolean(document.querySelector('dialog[open]'))`));
  await shot('06-settings');
  await dom(`document.querySelector('dialog[open] .primary').click()`);

  // ---- saving and deleting
  ctx.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.FANOUT_USER_DATA, 'fanout.json'), 'utf8'));
  check('brands and tabs are saved', saved.brands[0]?.name === 'Acme Foods' && saved.brands[0].tabs.length === 2);
  check('the layout is saved with the brand', saved.brands[0].panes.length === 2 && saved.brands[0].splitX === 0.7 &&
    saved.brands[0].tabs.every((tab) => tab.url.startsWith(site)));
  check('nothing was written outside the profile and folder', !fs.existsSync(path.join(FOLDER, 'fanout.json')));
  // ---- a brand added "side by side" opens its starter tabs in panes
  await bridge('createBrand', { name: 'Together', color: '#2f6fed', folder: '', together: true, urls: [`${site}/a`, `${site}/b`, `${site}/a`, `${site}/b`, `${site}/a`] });
  const together = ctx.store.data.brands[1];
  await until(() => together.panes.every((id) => idle({ id })), 'four panes loaded');
  check('side by side: four of five starter tabs on screen, the fifth waits', together.panes.length === 4 &&
    together.panes.every((id) => live({ id })) && !live(together.tabs[4]));
  await bridge('selectBrand', together.id);
  await wait(400);
  check('the tabs on screen are one group in the tab strip, the waiting tab outside it',
    await dom(`document.querySelectorAll('#tab-group .tab').length === 4 && document.querySelectorAll('#tab-rest .tab').length === 1 && !document.getElementById('tab-group').hidden`));
  const gap = await dom(`(() => {
    const last = [...document.querySelectorAll('#tabs .tab')].pop().getBoundingClientRect();
    return Math.round(document.getElementById('new-tab').getBoundingClientRect().left - last.right);
  })()`);
  check('the new-tab button sits right after the last tab', gap >= 0 && gap <= 16, `${gap}px apart`);
  const tabWidth = await dom(`Math.round(document.querySelector('#tab-group .tab').getBoundingClientRect().width)`);
  check('grouped tabs keep their full width when there is room', tabWidth >= 140, `${tabWidth}px`);
  await shot('07-added-side-by-side');

  // ---- the group stays as arranged: a tab outside it is shown on its own, in front of it
  const layoutOf = (b) => JSON.stringify([b.panes, b.splitX, b.splitY]);
  const arranged = layoutOf(together);
  const groupIds = [...together.panes];
  /** What the interface shows: boxes in the page area, the group in the strip, the lit layout button. */
  const screen = () => dom(`({
    boxes: [...document.querySelectorAll('#page .pane')].map((el) => el.dataset.tab),
    grouped: document.querySelectorAll('#tab-group .tab').length,
    waiting: document.getElementById('tab-group').classList.contains('is-waiting'),
    active: [...document.querySelectorAll('#tabs .tab.is-active')].map((el) => el.dataset.id).join(),
    groupLit: document.querySelectorAll('#tab-group .tab:is(.is-active, .is-shown)').length,
    focused: document.querySelector('#page .pane.is-focused')?.dataset.tab ?? null,
    head: document.querySelector('#page .pane-title')?.textContent ?? null,
    back: Boolean(document.querySelector('#page .pane-back')),
    starter: document.querySelector('#page h1')?.textContent ?? null,
    lit: [...document.querySelectorAll('#layouts .is-on')].map((el) => el.dataset.count).join(),
    marked: [...document.querySelectorAll('#layouts .is-waiting')].map((el) => el.dataset.count).join(),
    address: document.getElementById('address').value,
  })`);
  const fifth = together.tabs[4].id; // the starter tab that did not fit in the group
  check('the group starts as four live pages on the window', attached().length === 4);

  const plus = await bridge('createTab', together.id);
  await wait(500);
  const alone = await screen();
  check('+ in split view leaves the four panes untouched and shows the new tab alone',
    layoutOf(together) === arranged && together.solo === plus && together.activeTabId === plus &&
    alone.boxes.join() === plus && alone.grouped === 4 && alone.waiting && alone.active === plus && alone.groupLit === 0 &&
    alone.starter === 'Where does Together post?' && alone.back && alone.lit === '1' && alone.marked === '4' &&
    attached().length === 0, JSON.stringify(alone));
  await shot('09-solo-new-tab');

  await bridge('navigate', plus, `${site}/b`);
  await until(() => idle({ id: plus }), 'the new tab loads on its own');
  await wait(500);
  const zoom = ui.getZoomFactor();
  const body = await dom(`(() => { const r = document.querySelector('#page .pane-body').getBoundingClientRect();
    return { width: r.width, height: r.height, page: document.getElementById('page').getBoundingClientRect().width }; })()`);
  const views = attached();
  const fills = views.length === 1 && views[0].webContents === ctx.tabs.activeContents() &&
    Math.abs(views[0].getBounds().width - Math.round(body.width * zoom)) <= 1 && Math.abs(body.width - body.page) <= 1;
  const named = await screen();
  check('given an address it stays on its own, filling the whole page area, named over it and in the address bar',
    fills && together.solo === plus && layoutOf(together) === arranged && named.head === 'Site B' &&
    named.address === `${site}/b`, `${JSON.stringify(views.map((v) => v.getBounds()))} ${JSON.stringify(body)}`);
  await shot('09-solo-page');

  await bridge('selectTab', groupIds[2]);
  await until(() => groupIds.every((id) => idle({ id })) && attached().length === 4, 'the group back');
  await wait(400);
  const back = await screen();
  check('clicking a tab of the group brings the whole group back as it was, that pane focused',
    together.solo === null && layoutOf(together) === arranged && together.focus === 2 && back.boxes.join() === groupIds.join() &&
    !back.waiting && back.focused === groupIds[2] && back.lit === '4' && back.marked === '' &&
    together.tabs.some((tab) => tab.id === plus) && !back.boxes.includes(plus), JSON.stringify(back));
  await shot('10-group-back');

  // Ctrl+Tab from the last pane goes on to the first tab outside the group, through the menu's own entry.
  await bridge('focusPane', together.id, 3);
  const lastPage = ctx.tabs.activeContents();
  const nextTab = Menu.getApplicationMenu().items.find((item) => item.label === 'View').submenu.items
    .find((item) => item.label === 'Next tab');
  nextTab.click();
  await until(() => idle({ id: fifth }), 'the fifth tab on its own');
  lastPage.focus(); // a page of the group behind it takes the focus: the group must stay behind
  await wait(500);
  check('Ctrl+Tab past the group shows the next tab on its own; a hidden group page taking focus changes nothing',
    together.solo === fifth && layoutOf(together) === arranged && together.focus === 3 && attached().length === 1,
    `${together.solo === fifth} ${together.focus}`);

  // Putting a tab in the group is deliberate: the tab menu, through the code a click runs.
  const menuItem = (tabId, start) => tabMenuTemplate(ctx, tabId).find((item) => item.label?.startsWith(start));
  const replaced = together.tabs.find((tab) => tab.id === together.panes[3]);
  const put = menuItem(fifth, 'Put in the group');
  const putLabel = put?.label;
  put?.click();
  await until(() => idle({ id: fifth }) && attached().length === 4, 'the group with the fifth tab');
  await wait(300);
  const joined = await screen();
  check('the tab menu puts a tab in the group, in place of the focused pane\'s tab, and says which',
    putLabel === `Put in the group, in place of "${tabLabel(replaced)}"` && together.panes[3] === fifth &&
    together.panes.slice(0, 3).join() === groupIds.slice(0, 3).join() && together.solo === null && together.focus === 3 &&
    joined.boxes.join() === together.panes.join() && together.tabs.includes(replaced) &&
    await dom(`Boolean(document.querySelector('#tab-rest [data-id="${replaced.id}"]'))`), putLabel);
  menuItem(fifth, 'Take out of the group').click();
  await wait(300);
  const shrunk = together.panes.join() === groupIds.slice(0, 3).join() && together.tabs.some((tab) => tab.id === fifth) &&
    (await screen()).boxes.join() === groupIds.slice(0, 3).join();
  const putBack = menuItem(replaced.id, 'Put in the group');
  const putBackLabel = putBack?.label;
  putBack?.click();
  await wait(300);
  check('Take out of the group takes its pane away; the next tab put in gets a new pane at the end, replacing nothing',
    shrunk && putBackLabel === 'Put in the group' && together.panes.join() === groupIds.join() && together.focus === 3, putBackLabel);

  // Memory: the solo tab is on screen; the group behind it is not.
  await bridge('selectTab', plus);
  await until(() => idle({ id: plus }) && attached().length === 1, 'the solo tab again');
  await bridge('updateSettings', { maxLiveTabs: 1 });
  await until(() => groupIds.every((id) => !live({ id })), 'the group behind asleep');
  check('a solo tab is never put to sleep; the group waiting behind it can be',
    live({ id: plus }) && groupIds.every((id) => !live({ id })) && together.solo === plus);
  await bridge('updateSettings', { maxLiveTabs: 6 });
  await bridge('selectTab', groupIds[0]);
  await until(() => groupIds.every((id) => idle({ id })) && attached().length === 4, 'the group awake');
  // Pages that wake together each grab the focus once as they get ready; the pane clicked keeps it.
  await wait(500);
  check("the group's pages load again when it comes back, and the pane clicked keeps the focus",
    groupIds.every((id) => live({ id })) && together.focus === 0 && together.activeTabId === groupIds[0],
    `live ${groupIds.map((id) => live({ id })).join()}, pane ${together.focus}, keyboard in it ${ctx.tabs.activeContents()?.isFocused()}`);

  // The solo tab is part of what a brand remembers: save, then load the file the way a start does.
  await bridge('selectTab', plus);
  await bridge('selectBrand', brand().id);
  await bridge('selectBrand', together.id);
  await wait(400);
  const switched = together.solo === plus && layoutOf(together) === arranged && attached().length === 1 &&
    (await screen()).boxes.join() === plus;
  ctx.store.flush();
  const file = path.join(process.env.FANOUT_USER_DATA, 'fanout.json');
  ctx.store.data = new JsonStore(file, { sanitize }).data;
  ctx.tabs.refresh();
  await wait(600);
  const loaded = ctx.store.data.brands.find((b) => b.id === together.id);
  const reloaded = await screen();
  check('switching brands and back, and saving and loading the profile, keep the solo tab in front of the group',
    switched && loaded.solo === plus && loaded.activeTabId === plus && layoutOf(loaded) === arranged &&
    reloaded.boxes.join() === plus && reloaded.waiting && reloaded.head === 'Site B' && attached().length === 1,
    JSON.stringify(reloaded));
  await ctx.deleteBrand(together.id, { ask: false });
  await bridge('createBrand', { name: 'Apart', color: '#18a36b', folder: '', together: false, urls: [`${site}/a`, `${site}/b`] });
  check('separate tabs: one page on screen', ctx.store.data.brands[1].panes.length === 1);
  await ctx.deleteBrand(ctx.store.data.brands[1].id, { ask: false });

  // ---- dragging tabs in the tab strip
  // Real pointer input sent to fanout's own interface (never to a page): press,
  // move in steps, look at what the interface shows, let go. The interface keeps
  // drawing while the owner's other windows cover it (a crowded strip scrolls on
  // animation frames; see gotchas, "A covered window pauses a silent video").
  ui.setBackgroundThrottling(false);
  const site6 = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${site}/${x}`);
  await bridge('createBrand', { name: 'Drag', color: '#2f6fed', folder: '', together: false, urls: site6 });
  const dragged = ctx.store.data.brands[1];
  const [A, B, C, D, E, F] = dragged.tabs.map((tab) => tab.id);
  const letter = Object.fromEntries(dragged.tabs.map((tab, i) => [tab.id, 'ABCDEF'[i]]));
  const order = () => dragged.panes.map((id) => letter[id] ?? (id ? '+' : '_')).join('');
  // Each tab shown once, so each has its page's icon (a picture) in the strip; then A again.
  for (const id of [B, C, D, E, F, A]) {
    await bridge('selectTab', id);
    await until(() => idle({ id }), `tab ${letter[id]} loaded`);
  }
  await until(() => dom(`document.querySelectorAll('#tabs img.favicon').length === 6`), 'six icons in the strip', 5000);
  await dom(`window.__drags = { started: 0, allowed: 0 };
    addEventListener('dragstart', (e) => { __drags.started += 1; if (!e.defaultPrevented) __drags.allowed += 1; })`);

  const centre = (selector, fx = 0.5, fy = 0.5) => dom(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.x + r.width * ${fx}), y: Math.round(r.y + r.height * ${fy}) }; })()`);
  const onTabAt = (id, fx = 0.5) => centre(`#tabs .tab[data-id="${id}"]`, fx);
  const press = ({ x, y }, button = 'left', clickCount = 1) => {
    ui.sendInputEvent({ type: 'mouseMove', x, y });
    ui.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
  };
  const letGo = ({ x, y }, button = 'left', clickCount = 1) => ui.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  const click = async (at, button = 'left') => {
    press(at, button);
    letGo(at, button);
    await wait(400);
  };
  /** What the interface shows of a drag going on. */
  const look = () => dom(`(() => {
    const outline = document.getElementById('tab-group');
    return {
      dragging: document.body.classList.contains('is-dragging-tab'),
      refused: document.body.classList.contains('is-drop-refused'),
      lifted: document.querySelector('#tabs .tab.is-lifted')?.dataset.id ?? null,
      says: document.querySelector('.tab-ghost-does')?.textContent ?? null,
      marker: Boolean(document.querySelector('.drop-marker:not([hidden])')),
      outline: ['is-drop-zone', 'is-drop-target', 'is-refused'].filter((c) => outline.classList.contains(c)).join(),
      target: document.querySelector('#tabs .tab.is-drop-target')?.dataset.id ?? null,
      pane: document.querySelector('#page .pane.is-drop-target')?.dataset.index ?? null,
    }; })()`);
  /** Press at `from`, move to `to` in steps, look, then (unless `hold`) let go there. */
  const drag = async (from, to, { hold = false, during } = {}) => {
    press(from);
    for (let i = 1; i <= 10; i += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / 10);
      const y = Math.round(from.y + ((to.y - from.y) * i) / 10);
      ui.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftbuttondown'] });
      await wait(15);
    }
    await wait(250); // the main process's answer about the place under the pointer
    if (during) await during();
    const seen = await look();
    if (!hold) {
      letGo(to);
      await wait(400);
    }
    return seen;
  };
  /** Each page on the window sits exactly on the box of the pane its tab is in. */
  const aligned = async () => {
    await wait(300);
    const zoom = ui.getZoomFactor();
    const boxes = await dom(`Object.fromEntries([...document.querySelectorAll('#page .pane')].map((p) => {
      const r = p.querySelector('.pane-body').getBoundingClientRect(); return [p.dataset.tab, [r.x, r.y, r.width, r.height]]; }))`);
    const views = attached();
    const placed = views.filter((view) => {
      const tab = dragged.tabs.find((t) => t.url === view.webContents.getURL());
      const box = tab && boxes[tab.id];
      const { x, y, width, height } = view.getBounds();
      return box && [x, y, width, height].every((n, i) => Math.abs(n - Math.round(box[i] * zoom)) <= 1);
    });
    const shown = onScreenIds(dragged).filter((id) => dragged.tabs.find((t) => t.id === id)?.url);
    return placed.length === views.length && views.length === shown.length;
  };
  const onScreenIds = (b) => (b.solo ? [b.solo] : b.panes.filter(Boolean));

  // No group yet: B dropped on C's left half, pressed on B's icon.
  const pairSeen = await drag(await centre(`#tabs .tab[data-id="${B}"] img.favicon`), await onTabAt(C, 0.25));
  await until(() => attached().length === 2, 'two pages side by side');
  const pairShown = await screen();
  check('a tab dropped on another makes a group of two side by side, the dragged one first (left half), its pane focused',
    order() === 'BC' && dragged.focus === 0 && dragged.activeTabId === B && pairShown.grouped === 2 &&
    pairSeen.dragging && pairSeen.lifted === B && pairSeen.target === C && pairSeen.marker && pairSeen.says === 'Side by side' &&
    await aligned(), `${order()} ${JSON.stringify(pairSeen)}`);
  const drags = await dom('window.__drags');
  check('pressing on a tab\'s icon and dragging starts no system drag, so nothing reaches a page', drags.allowed === 0,
    `${drags.started} drag start(s), ${drags.allowed} not stopped`);
  await shot('11-drag-pair');

  // D onto the outline's own space, past its last tab. Its tab is drawn anew mid-drag (its name
  // changes, as when a title arrives or a page starts loading): the drag must not lose it.
  const outlineEnd = await centre('#tab-group', 0.995);
  const joinSeen = await drag(await onTabAt(D), outlineEnd, {
    during: async () => {
      await dom(`document.querySelector('#tabs .tab[data-id="${D}"]').__before = true`);
      await bridge('renameTab', D, 'Dee');
      await until(() => dom(`!document.querySelector('#tabs .tab[data-id="${D}"]').__before`), 'D redrawn', 3000);
    },
  });
  const redrawn = await dom(`document.querySelector('#tabs .tab[data-id="${D}"]').__before === undefined`);
  await bridge('renameTab', D, '');
  await until(() => attached().length === 3, 'three pages');
  check('a tab dropped on the group\'s outline joins at its end; the drag survives the tab being redrawn under it',
    order() === 'BCD' && dragged.focus === 2 && joinSeen.lifted === D && joinSeen.outline.includes('is-drop-target') &&
    joinSeen.says === 'Add to the group' && redrawn && await aligned(), `${order()} ${JSON.stringify(joinSeen)}`);

  // A, the tab outside, onto B's left half: four. While it is dragged the outline says it is the place.
  const fourSeen = await drag(await onTabAt(A), await onTabAt(B, 0.2));
  await until(() => attached().length === 4, 'four pages');
  check('a third tab dropped on a tab of the group joins before it: four pages',
    order() === 'ABCD' && dragged.focus === 0 && fourSeen.outline.includes('is-drop-zone') && fourSeen.marker &&
    await aligned(), `${order()} ${JSON.stringify(fourSeen)}`);
  await shot('12-drag-four');

  // A fifth: refused, said while hovering and after letting go.
  const fullSeen = await drag(await onTabAt(E), await onTabAt(C, 0.7));
  const said = await dom(`document.getElementById('note').textContent`);
  check('a fifth tab is refused: the outline and the pointer say so while it hovers, the status bar says why after',
    order() === 'ABCD' && dragged.tabs.length === 6 && fullSeen.refused && fullSeen.outline.includes('is-refused') &&
    !fullSeen.marker && fullSeen.says.includes('four') && said.includes('four pages'), `${JSON.stringify(fullSeen)} ${said}`);
  await shot('13-drag-full');

  // Inside the group: A after D.
  const moveSeen = await drag(await onTabAt(A), await onTabAt(D, 0.8));
  check('a tab of the group dropped inside it moves there; the panes reorder',
    order() === 'BCDA' && dragged.focus === 3 && dragged.activeTabId === A && moveSeen.says === 'Move here' && await aligned(),
    `${order()} ${JSON.stringify(moveSeen)}`);
  const kept = order();
  await drag(await onTabAt(C), await onTabAt(D, 0.2));
  check('dropped where it already is, nothing changes', order() === kept, order());

  // Out of the group, onto the strip beyond its outline.
  const outSeen = await drag(await onTabAt(C), await onTabAt(F, 0.5));
  await until(() => attached().length === 3, 'three pages again');
  check('a tab of the group dropped outside its outline leaves it, taking its pane: four become three',
    order() === 'BDA' && dragged.tabs.some((tab) => tab.id === C) && outSeen.says === 'Take out of the group' &&
    await dom(`Boolean(document.querySelector('#tab-rest [data-id="${C}"]'))`) && await aligned(), `${order()} ${JSON.stringify(outSeen)}`);

  // Escape: no drop, and letting go over a tab afterwards is no click on it.
  const before = JSON.stringify([dragged.panes, dragged.focus, dragged.solo]);
  await drag(await onTabAt(D), await onTabAt(E), { hold: true });
  ui.focus(); // pressing on the strip gives the interface the keyboard; here the last drop gave it to a page
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(150);
  const cancelled = await look();
  letGo(await onTabAt(E));
  await wait(400);
  check('Escape cancels a drag: nothing changes, and letting go over a tab does not select it',
    JSON.stringify([dragged.panes, dragged.focus, dragged.solo]) === before && !cancelled.dragging && !cancelled.lifted &&
    dragged.activeTabId !== E, `${order()} ${JSON.stringify(cancelled)}`);

  // An outside tab onto another outside tab while there is a group: not a drop.
  const strayOrder = order();
  const straySeen = await drag(await onTabAt(E), await onTabAt(F, 0.3));
  check('a tab outside the group dropped on another outside it changes nothing; the outline shows where to drop instead',
    order() === strayOrder && dragged.solo === null && !straySeen.marker && straySeen.target === null &&
    straySeen.outline.includes('is-drop-zone'), JSON.stringify(straySeen));

  // Ordinary clicks still do what they did: a click selects, a middle click closes, a double click renames.
  await click(await onTabAt(F));
  const clicked = dragged.solo === F && dragged.activeTabId === F;
  await click(await onTabAt(E), 'middle');
  await until(() => !dragged.tabs.some((tab) => tab.id === E), 'E closed', 3000);
  const middle = !dragged.tabs.some((tab) => tab.id === E);
  const nameAt = await onTabAt(C);
  await click(nameAt);
  press(nameAt, 'left', 2);
  letGo(nameAt, 'left', 2);
  await wait(300);
  const renaming = await dom(`Boolean(document.querySelector('#tabs .tab-rename'))`);
  const duringRename = order();
  await drag(nameAt, await onTabAt(B, 0.3));
  const noDrag = order() === duringRename && await dom(`Boolean(document.querySelector('#tabs .tab-rename'))`);
  await dom(`document.querySelector('#tabs .tab-rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(200);
  check('after all that, a click still selects, a middle click still closes, a double click still renames, and no drag starts while renaming',
    clicked && middle && renaming && noDrag && dragged.tabs.find((tab) => tab.id === C)?.name === '',
    `${clicked} ${middle} ${renaming} ${noDrag}`);

  // Closing a tab of the group takes its pane with it.
  await bridge('selectTab', B);
  await bridge('closeTab', D);
  await until(() => !dragged.tabs.some((tab) => tab.id === D), 'D closed');
  await until(() => attached().length === 2, 'two pages');
  check('closing a tab of the group takes its pane away: three become two', order() === 'BA' && await aligned(), order());

  // ---- empty panes: a layout button with more panes than tabs
  for (const id of [C, F]) await bridge('closeTab', id);
  await until(() => dragged.tabs.length === 2, 'two tabs left');
  await bridge('setLayout', dragged.id, { count: 3 });
  await wait(400);
  const emptyNote = await dom(`document.querySelector('#page .pane[data-index="2"] .page-note p')?.textContent ?? ''`);
  check('an empty pane says a tab can be dragged there, and offers a new tab', order() === 'BA_' &&
    emptyNote.startsWith('Drag a tab here') &&
    await dom(`document.querySelector('#page .pane[data-index="2"] .page-note .primary')?.textContent === 'Open a new tab here'`), emptyNote);
  await dom(`document.querySelector('#page .pane[data-index="2"] .page-note .primary').click()`);
  await until(() => dragged.panes[2], 'a new tab in pane 3');
  const here = dragged.panes[2];
  await wait(300);
  const inPane = dragged.solo === null && dragged.focus === 2 && dragged.activeTabId === here &&
    await dom(`document.querySelector('#page .pane[data-index="2"] h1')?.textContent === 'Where does Drag post?'`);
  await bridge('closeTab', here);
  await wait(300);
  check('Open a new tab here puts a new tab in that pane; closing it takes the pane away', inPane && order() === 'BA', order());

  await bridge('setLayout', dragged.id, { count: 3 });
  const G = ctx.tabs.open(dragged.id, { url: `${site}/g`, background: true }).id; // in the strip, not loaded
  letter[G] = 'G';
  await wait(400);
  const paneSeen = await drag(await onTabAt(G), await centre('#page .pane[data-index="2"] .pane-body'));
  await until(() => attached().length === 3, 'three pages');
  check('a tab dropped on an empty pane goes into that pane; the pane shows it is the place while the tab is over it',
    order() === 'BAG' && dragged.focus === 2 && paneSeen.pane === '2' && paneSeen.says === 'Show it in this pane' &&
    await aligned(), `${order()} ${JSON.stringify(paneSeen)}`);
  await shot('14-drag-pane');

  // ---- a crowded strip scrolls while a tab is held at its end, and the drag goes on
  for (let i = 0; i < 16; i += 1) ctx.tabs.open(dragged.id, { url: `${site}/h?${i}`, background: true });
  await wait(500);
  // Measured now: a strip with room to spare ends where its last tab ends, a crowded one at the + button.
  const strip = await dom(`(() => { const t = document.getElementById('tabs'); const r = t.getBoundingClientRect();
    return { right: Math.round(r.right), y: Math.round(r.y + r.height / 2), over: t.scrollWidth - t.clientWidth }; })()`);
  const end = { x: strip.right - 6, y: strip.y };
  await drag(await onTabAt(B), end, { hold: true });
  await wait(700);
  const scrolled = await dom(`document.getElementById('tabs').scrollLeft`);
  const frame = await dom(`new Promise((done) => { requestAnimationFrame(() => done('drawing')); setTimeout(() => done('no frame in 300 ms'), 300); })`);
  letGo(end);
  await wait(400);
  check('a strip too crowded to show every tab scrolls while a dragged tab is held at its end; letting go there takes it out',
    strip.over > 50 && scrolled > 0 && order() === 'AG',
    `${strip.over}px hidden, held at x ${end.x} of ${strip.right}, scrolled ${scrolled}px, ${order()}, window ${frame}`);
  check('no drag left anything behind: no label, marker, look or listener of a drag',
    await dom(`!document.querySelector('.tab-ghost, .drop-marker, .is-lifted, .is-drop-target, .is-drop-zone, #tab-group.is-refused') &&
      !document.body.classList.contains('is-dragging-tab')`));
  ui.setBackgroundThrottling(true);
  await ctx.deleteBrand(dragged.id, { ask: false });
  await bridge('selectBrand', brand().id);

  // ---- new tabs: named by their page, not by a rename box left as it was
  const tabOf = (id) => brand().tabs.find((tab) => tab.id === id);
  /** The tab's label in the strip and over its box in the page area. */
  const labels = async (id) => (await dom(`[document.querySelector('#tabs [data-id="${id}"] .tab-label')?.textContent,
    document.querySelector('#page .pane[data-tab="${id}"] .pane-title')?.textContent]`)).join(' / ');
  /** Open a tab's rename box as a double-click does, type (or not), press Enter. Returns what the box opened with. */
  const rename = (id, typed = null) => dom(`(() => {
    document.querySelector('#tabs [data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const box = document.querySelector('#tabs .tab-rename');
    const opened = box.value;
    const typed = ${JSON.stringify(typed)};
    if (typed !== null) box.value = typed;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return opened;
  })()`);

  // Acme still shows two pages side by side, so a new tab comes up on its own, in front of them.
  const fresh = await bridge('createTab', brand().id);
  await until(() => dom(`Boolean(document.querySelector('#tabs [data-id="${fresh}"]'))`), 'new tab in the strip');
  const boxText = await rename(fresh);
  await wait(300);
  const untouched = await labels(fresh);
  check("a new tab's rename box closed unchanged saves no name, and goes away",
    boxText === UNNAMED_TAB && tabOf(fresh).name === '' && untouched === `${UNNAMED_TAB} / ${UNNAMED_TAB}` &&
    await dom(`document.querySelector('.tab-rename') === null`), untouched);
  await bridge('navigate', fresh, `${site}/b`);
  await until(() => tabOf(fresh).title === 'Site B', 'new tab has its page title');
  await wait(300);
  const titled = await labels(fresh);
  const address = await dom(`document.getElementById('address').value`);
  check('given an address, it goes by its page title in the strip and over its pane',
    titled === 'Site B / Site B' && address === `${site}/b`, `${titled}; ${address}`);
  await rename(fresh, '  Acme reels ');
  await until(async () => (await labels(fresh)) === 'Acme reels / Acme reels', 'typed name shown');
  const typedName = tabOf(fresh).name;
  await shot('08-tab-names');
  await rename(fresh, '');
  await until(async () => (await labels(fresh)) === 'Site B / Site B', 'name cleared');
  check('a typed name is kept; emptying the box gives the page title back',
    typedName === 'Acme reels' && tabOf(fresh).name === '', await labels(fresh));

  // ---- a blank tab lives only on screen
  const stray = await bridge('createTab', brand().id);
  await bridge('createBrand', { name: 'Elsewhere', color: '#8a4fff', folder: '', urls: [] });
  const awayWhile = ctx.store.data.activeBrandId !== brand().id && brand().solo === stray;
  await ctx.deleteBrand(ctx.store.data.brands[1].id, { ask: false });
  check('a blank tab stays on screen while another brand is shown', awayWhile && Boolean(tabOf(stray)));
  await bridge('selectTab', b.id);
  await wait(300);
  check('a blank tab that leaves the screen (the group came back) is removed; a tab with a page stays',
    !tabOf(stray) && Boolean(tabOf(fresh)) && brand().panes.join() === [a.id, b.id].join() &&
    await dom(`document.querySelector('#tabs [data-id="${stray}"]') === null`), brand().tabs.map((tab) => tab.title || 'blank').join());
  await bridge('closeTab', fresh);
  await until(() => !tabOf(fresh), 'extra tab closed');

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
