// Tests for the parts of fanout that need no Electron: run with `npm test`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { decode, fileKind, FolderWatcher, listDir, readText, MAX_TEXT_BYTES } from '../src/main/files.js';
import {
  addTab, cleanSettings, createBrand, defaults, deleteBrand, destinations, findTab, removeTab, sanitize,
} from '../src/main/model.js';
import { isInside, OutsideFolderError, resolveInside, toRel } from '../src/main/pathjail.js';
import { PostedStore } from '../src/main/posted.js';
import { pickTabsToSleep, UploadActivity } from '../src/main/sleeper.js';
import { JsonStore } from '../src/main/store.js';
import { hostOf, isWebUrl, siteName, toUrl } from '../src/main/urls.js';
import { cleanUserAgent } from '../src/main/useragent.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-test-'));

// ------------------------------------------------------------------- urls

test('address bar: addresses, bare hosts, searches, refused schemes', () => {
  assert.equal(toUrl('https://studio.youtube.com/'), 'https://studio.youtube.com/');
  assert.equal(toUrl('  linkedin.com/feed '), 'https://linkedin.com/feed');
  assert.equal(toUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(toUrl('192.168.1.5'), 'http://192.168.1.5/');
  assert.equal(toUrl('how to post a reel'), 'https://duckduckgo.com/?q=how%20to%20post%20a%20reel');
  assert.equal(toUrl('tiktok'), 'https://duckduckgo.com/?q=tiktok');
  for (const bad of ['', '   ', 'file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
    assert.equal(toUrl(bad), null, bad);
  }
});

test('web urls and site names', () => {
  assert.ok(isWebUrl('http://a.b'));
  assert.ok(!isWebUrl('file:///x'));
  assert.ok(!isWebUrl(undefined));
  assert.equal(hostOf('https://www.tiktok.com/upload'), 'tiktok.com');
  assert.equal(siteName('https://studio.youtube.com/channel'), 'Youtube');
  assert.equal(siteName('https://www.bbc.co.uk/'), 'Bbc');
  assert.equal(siteName('http://localhost:8080'), 'localhost');
  assert.equal(siteName('http://10.0.0.7/'), '10.0.0.7');
  assert.equal(siteName('nonsense'), '');
});

test('user agent loses the app and Electron tokens only', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) fanout/0.1.0 Chrome/140.0.0.0 Electron/45.3.0 Safari/537.36';
  assert.equal(
    cleanUserAgent(ua, 'fanout'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  );
});

// --------------------------------------------------------------- pathjail

test('paths cannot leave the brand folder (Windows and POSIX spellings)', () => {
  const w = path.win32;
  assert.equal(resolveInside('C:\\brand', 'reels/a.mp4', w), 'C:\\brand\\reels\\a.mp4');
  assert.equal(resolveInside('C:\\brand', '', w), 'C:\\brand');
  assert.equal(resolveInside('C:\\brand', '..notes.txt', w), 'C:\\brand\\..notes.txt');
  for (const bad of ['..', '../x', 'a/../../x', 'C:\\Windows', 'D:\\x', '\\\\server\\share', 'a\0b']) {
    assert.throws(() => resolveInside('C:\\brand', bad, w), OutsideFolderError, bad);
  }
  assert.throws(() => resolveInside('C:\\brand', '../brand2/x', w), OutsideFolderError);

  const p = path.posix;
  assert.equal(resolveInside('/home/me/brand', 'a/b.txt', p), '/home/me/brand/a/b.txt');
  for (const bad of ['..', '/etc/passwd', 'a/../../../etc']) {
    assert.throws(() => resolveInside('/home/me/brand', bad, p), OutsideFolderError, bad);
  }
  assert.throws(() => resolveInside('', 'a', p), OutsideFolderError);
  assert.throws(() => resolveInside('relative', 'a', p), OutsideFolderError);
  assert.ok(isInside('/a/b', '/a/b/c', p));
  assert.ok(!isInside('/a/b', '/a/bc', p));
  assert.equal(toRel('C:\\brand', 'C:\\brand\\x\\y.md', w), 'x/y.md');
});

// ---------------------------------------------------------------- sleeper

const vital = (id, minutesAgo, extra = {}) => ({
  id, live: true, visible: false, busy: false, keepAwake: false, lastActive: 1_000_000_000 - minutesAgo * 60_000, ...extra,
});
const policy = (sleepAfterMinutes, maxLive) => ({ now: 1_000_000_000, sleepAfterMs: sleepAfterMinutes * 60_000, maxLive });

test('idle background tabs sleep; visible, busy and keep-awake tabs never do', () => {
  const tabs = [
    vital('fresh', 1),
    vital('old', 30),
    vital('older', 90),
    vital('visible', 500, { visible: true }),
    vital('uploading', 500, { busy: true }),
    vital('pinned', 500, { keepAwake: true }),
    { ...vital('asleep', 500), live: false },
  ];
  assert.deepEqual(pickTabsToSleep(tabs, policy(20, 0)), ['older', 'old']);
  assert.deepEqual(pickTabsToSleep(tabs, policy(0, 0)), [], 'both limits off');
});

test('over the limit, the least recently used tabs go first', () => {
  const tabs = [vital('a', 5), vital('b', 3), vital('c', 9), vital('d', 1), vital('now', 0, { visible: true })];
  assert.deepEqual(pickTabsToSleep(tabs, policy(0, 3)), ['c', 'a']);
  assert.deepEqual(pickTabsToSleep(tabs, policy(8, 3)), ['c', 'a'], 'idle pick counts toward the limit');
  assert.deepEqual(pickTabsToSleep(tabs, policy(0, 5)), []);
  const allBusy = tabs.map((t) => ({ ...t, busy: true }));
  assert.deepEqual(pickTabsToSleep(allBusy, policy(1, 1)), [], 'nothing is forced');
});

test('upload activity: long data requests make a page busy, for a while', () => {
  const up = new UploadActivity({ longMs: 3000, lingerMs: 120_000 });
  up.begin('r1', 7, 'GET', 0);
  up.begin('r2', 7, 'POST', 0);
  assert.equal(up.pending, 1, 'reads are not tracked');
  assert.equal(up.isBusy(7, 1000), false, 'a quick POST is not an upload');
  assert.equal(up.isBusy(7, 5000), true, 'still open after 3s');
  assert.equal(up.isBusy(8, 5000), false, 'another page is unaffected');
  up.end('r2', 9000);
  assert.equal(up.isBusy(7, 60_000), true, 'between chunks');
  assert.equal(up.isBusy(7, 9000 + 120_000), false, 'quiet long enough');

  up.begin('r3', 7, 'POST', 200_000);
  up.end('r3', 200_400);
  assert.equal(up.isBusy(7, 200_500), false, 'short telemetry never counts');

  up.begin('r4', 9, 'PUT', 0);
  up.begin('r5', 9, 'PUT', 0);
  up.end('r5', 10_000);
  up.forget(9);
  assert.equal(up.pending, 0);
  assert.equal(up.isBusy(9, 11_000), false);
  up.begin('r6', null, 'POST', 0);
  assert.equal(up.pending, 0, 'requests without a page are ignored');
});

// ------------------------------------------------------------------ model

test('brands and tabs: create, add, remove, delete', () => {
  const data = defaults();
  const acme = createBrand(data, { name: '  Acme  ', color: '#FB5F89', folder: 'C:\\acme', urls: ['https://a.example/', 'ftp://no'] });
  assert.equal(acme.name, 'Acme');
  assert.equal(acme.color, '#fb5f89');
  assert.equal(data.activeBrandId, acme.id);
  assert.equal(acme.tabs.length, 2);
  assert.equal(acme.tabs[1].url, '', 'a non-web address becomes a blank tab');
  assert.equal(acme.activeTabId, acme.tabs[0].id);

  const opened = addTab(acme, { url: 'https://b.example/', temp: true, afterId: acme.tabs[0].id });
  assert.equal(acme.tabs[1].id, opened.id, 'placed next to its opener');
  assert.deepEqual(destinations(acme).map((t) => t.url), ['https://a.example/'], 'temp and blank tabs are not destinations');
  assert.equal(findTab(data, opened.id).brand.id, acme.id);

  acme.activeTabId = opened.id;
  removeTab(acme, opened.id);
  assert.equal(acme.activeTabId, acme.tabs[1].id, 'right-hand neighbour takes over');
  removeTab(acme, acme.tabs[1].id);
  assert.equal(acme.activeTabId, acme.tabs[0].id, 'else the left one');
  removeTab(acme, acme.tabs[0].id);
  assert.equal(acme.activeTabId, null);

  const beta = createBrand(data, { name: '', color: 'red' });
  assert.equal(beta.name, 'Brand');
  assert.match(beta.color, /^#[0-9a-f]{6}$/);
  deleteBrand(data, beta.id);
  assert.equal(data.activeBrandId, acme.id);
  deleteBrand(data, acme.id);
  assert.equal(data.activeBrandId, null);
});

test('data from disk is repaired, not trusted', () => {
  const data = sanitize({
    activeBrandId: 'b_gone',
    settings: { sleepAfterMinutes: -5, maxLiveTabs: 9999, panelWidth: 'wide', hidePosted: true, evil: 1 },
    brands: [
      { id: 'b_0123456789', name: 'Ok', color: 'nope', folder: 5, activeTabId: 't_missing', tabs: [
        { id: 't_0123456789', url: 'https://x.example/', favicon: 'file:///c/x.ico', keepAwake: 'yes' },
        { id: 't_0123456789', url: 'https://dup.example/' },
        { id: 't_1111111111', url: 'https://temp.example/', temp: true },
        { id: 't_2222222222', url: 'javascript:alert(1)' },
        { id: '../../etc', url: 'https://x.example/' },
        null,
      ] },
      { id: 'not an id', name: 'Bad' },
      'junk',
    ],
    permissions: { 'b|https://a|media': true, other: 'yes' },
    window: { width: 900.4, height: 700, x: 'a' },
  });
  assert.equal(data.brands.length, 1);
  const [brand] = data.brands;
  assert.equal(data.activeBrandId, brand.id);
  assert.equal(brand.folder, '');
  assert.deepEqual(brand.tabs.map((t) => t.id), ['t_0123456789', 't_2222222222']);
  assert.equal(brand.tabs[0].favicon, '');
  assert.equal(brand.tabs[0].keepAwake, false);
  assert.equal(brand.tabs[0].homeUrl, 'https://x.example/');
  assert.equal(brand.tabs[1].url, '');
  assert.equal(brand.activeTabId, 't_0123456789');
  assert.deepEqual(data.settings, { ...cleanSettings(), sleepAfterMinutes: 0, maxLiveTabs: 50, hidePosted: true });
  assert.deepEqual(data.permissions, { 'b|https://a|media': true });
  assert.deepEqual(data.window, { width: 900, height: 700, x: undefined, y: undefined, maximized: false });
  assert.deepEqual(sanitize(null), defaults());
  assert.deepEqual(sanitize('garbage'), defaults());
});

// ------------------------------------------------------------------ store

test('store: saves soon, survives damage, never half-writes', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'data.json');
  const store = new JsonStore(file, { sanitize: (raw) => raw ?? { n: 0 }, delayMs: 5 });
  assert.deepEqual(store.data, { n: 0 });
  store.data.n = 1;
  store.touch();
  store.data.n = 2;
  store.touch();
  await new Promise((r) => setTimeout(r, 40));
  await store.settled();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 });
  assert.ok(!fs.existsSync(`${file}.tmp`));

  store.data.n = 3;
  store.flush();
  assert.equal(new JsonStore(file).data.n, 3);

  fs.writeFileSync(file, '{ broken');
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(new JsonStore(file, { sanitize: (raw) => raw ?? { fresh: true } }).data, { fresh: true });
  } finally {
    console.error = quiet;
  }
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.damaged-')), 'damaged file kept aside');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('posted marks: set, clear, per brand, saved', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'posted.json');
  const posted = new PostedStore(file);
  const when = new Date('2026-11-12T10:00:00Z');
  assert.deepEqual(posted.set('b1', 'reels/a.mp4', 't1', true, when), { t1: when.toISOString() });
  posted.setMany('b1', 'reels/a.mp4', ['t2', 't3'], true, when);
  assert.deepEqual(Object.keys(posted.forBrand('b1')['reels/a.mp4']), ['t1', 't2', 't3']);
  assert.deepEqual(posted.forBrand('b2'), {});
  assert.deepEqual(posted.setMany('b1', 'reels/a.mp4', [], true), posted.forBrand('b1')['reels/a.mp4']);
  posted.set('b1', 'reels/a.mp4', 't1', false);
  posted.setMany('b1', 'reels/a.mp4', ['t2', 't3'], false);
  assert.deepEqual(posted.forBrand('b1'), {}, 'a file with no marks leaves nothing behind');

  posted.set('b1', 'x.png', 't1', true, when);
  posted.set('b2', 'y.png', 't9', true, when);
  posted.dropBrand('b1');
  posted.flush();
  const again = new PostedStore(file);
  assert.deepEqual(again.forBrand('b1'), {});
  assert.deepEqual(again.forBrand('b2'), { 'y.png': { t9: when.toISOString() } });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ files

test('file kinds and text decoding', () => {
  assert.equal(fileKind('Caption.MD'), 'text');
  assert.equal(fileKind('clip.final.mp4'), 'video');
  assert.equal(fileKind('cover.JPEG'), 'image');
  assert.equal(fileKind('voice.m4a'), 'audio');
  assert.equal(fileKind('deck.pdf'), 'other');
  assert.equal(fileKind('.gitignore'), 'other');
  assert.equal(fileKind('README'), 'other');

  assert.deepEqual(decode(Buffer.from('héllo #tag')), { text: 'héllo #tag', binary: false });
  assert.equal(decode(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])).text, 'hi', 'UTF-8 BOM dropped');
  assert.equal(decode(Buffer.from('\ufeffनमस्ते', 'utf16le')).text, 'नमस्ते', 'UTF-16 from Notepad');
  assert.deepEqual(decode(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])), { text: '', binary: true });
  const cut = Buffer.from('añ').subarray(0, 2); // half of the ñ
  assert.equal(decode(cut).text, 'a', 'a character cut in half is dropped');
});

test('listing: folders first, natural order, hidden files skipped, links cannot escape', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'brand');
  fs.mkdirSync(path.join(root, 'reels'), { recursive: true });
  for (const name of ['clip10.mp4', 'clip2.mp4', 'Caption.txt', '.hidden', 'desktop.ini']) {
    fs.writeFileSync(path.join(root, name), 'x');
  }
  fs.writeFileSync(path.join(root, 'reels', 'a.mov'), 'xx');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');

  const { entries, truncated } = await listDir(root, '');
  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => e.name), ['reels', 'Caption.txt', 'clip2.mp4', 'clip10.mp4']);
  assert.deepEqual(entries.map((e) => e.kind), ['dir', 'text', 'video', 'video']);
  const inner = await listDir(root, 'reels');
  assert.deepEqual(inner.entries.map((e) => [e.rel, e.size]), [['reels/a.mov', 2]]);

  await assert.rejects(listDir(root, '..'), OutsideFolderError);
  await assert.rejects(readText(root, '../secret.txt'), OutsideFolderError);
  await assert.rejects(listDir(root, 'nope'), { code: 'ENOENT' });

  let linked = false;
  try {
    fs.symlinkSync(dir, path.join(root, 'way-out'), 'junction');
    linked = true;
  } catch { /* links not permitted here */ }
  if (linked) {
    await assert.rejects(listDir(root, 'way-out'), OutsideFolderError);
    await assert.rejects(readText(root, 'way-out/secret.txt'), OutsideFolderError);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('text preview reads only the start of a big file', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'small.md'), '# Title\n\nBody #one #two\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'a'.repeat(MAX_TEXT_BYTES + 5000));
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');

  assert.deepEqual(await readText(dir, 'small.md'), {
    size: 24, truncated: false, text: '# Title\n\nBody #one #two\n', binary: false,
  });
  const big = await readText(dir, 'big.txt');
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, MAX_TEXT_BYTES);
  assert.deepEqual(await readText(dir, 'empty.txt'), { size: 0, truncated: false, text: '', binary: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watcher: reports a changed folder once, and lets go of closed ones', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  const seen = [];
  const watcher = new FolderWatcher((brandId, rel) => seen.push(`${brandId}:${rel}`), { quietMs: 40 });
  watcher.set('b1', dir, ['', 'sub', '../outside', 'missing']);
  assert.equal(watcher.size, 2, 'only real folders inside the root are watched');

  fs.writeFileSync(path.join(dir, 'sub', 'one.txt'), '1');
  fs.writeFileSync(path.join(dir, 'sub', 'two.txt'), '2');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(seen.filter((s) => s === 'b1:sub').length, 1, 'a burst is one report');

  watcher.set('b1', dir, ['']);
  assert.equal(watcher.size, 1);
  watcher.closeAll();
  assert.equal(watcher.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
