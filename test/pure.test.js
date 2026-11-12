// Tests for the parts of fanout that need no Electron: run with `npm test`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { decode, fileKind, FolderWatcher, listDir, readText, MAX_TEXT_BYTES } from '../src/main/files.js';
import {
  addTab, autoLabel, cleanSettings, createBrand, defaults, deleteBrand, destinations, findTab, focusPane, isBlank, nameFor,
  removeTab, sanitize, setPaneCount, setSplit, showTab, tabLabel, UNNAMED_TAB,
} from '../src/main/model.js';
import { renameText } from '../src/renderer/dom.js';
import { isMarkdownFile, parseMarkdown, plainText, webHref } from '../src/renderer/markdown.js';
import { notesText, whatsNew } from '../src/main/notes.js';
import { notesFor } from '../tools/release.mjs';
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

  showTab(acme, opened.id);
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

test('panes: one to four tabs side by side, each tab in one pane only', () => {
  const data = defaults();
  const brand = createBrand(data, { name: 'Split', urls: ['https://a.example/', 'https://b.example/', 'https://c.example/'] });
  const [a, b, c] = brand.tabs.map((tab) => tab.id);
  assert.deepEqual(brand.panes, [a]);

  setPaneCount(brand, 2);
  assert.deepEqual(brand.panes, [a, b], 'a new pane takes the next tab not on screen');
  assert.equal(brand.activeTabId, a, 'focus stays where it was');

  showTab(brand, b);
  assert.equal(brand.focus, 1, 'a tab already on screen is focused, not duplicated');
  showTab(brand, c);
  assert.deepEqual(brand.panes, [a, c], 'another tab replaces the focused pane');

  setPaneCount(brand, 4);
  assert.deepEqual(brand.panes, [a, c, b, null], 'a pane with no tab left stays empty');
  setPaneCount(brand, 9);
  assert.equal(brand.panes.length, 4, 'four at most');

  focusPane(brand, 3);
  assert.equal(brand.activeTabId, null);
  focusPane(brand, 7);
  assert.equal(brand.focus, 3, 'no such pane');
  focusPane(brand, 2);
  setPaneCount(brand, 1);
  assert.deepEqual(brand.panes, [b], 'shrinking keeps the focused tab');
  assert.equal(brand.focus, 0);

  setPaneCount(brand, 3);
  assert.deepEqual(brand.panes, [b, a, c]);
  removeTab(brand, a);
  assert.deepEqual(brand.panes, [b, null, c], 'no spare tab: the pane empties');
  const d = addTab(brand, { url: 'https://d.example/' }).id;
  removeTab(brand, c);
  assert.deepEqual(brand.panes, [b, null, d], 'a spare tab fills the gap');

  setSplit(brand, { x: 0.05, y: 0.66 });
  assert.deepEqual([brand.splitX, brand.splitY], [0.2, 0.66], 'dividers stay away from the edges');
  setSplit(brand, { x: 'wide' });
  assert.equal(brand.splitX, 0.2);

  const again = sanitize(JSON.parse(JSON.stringify(data))).brands[0];
  assert.deepEqual([again.panes, again.focus, again.splitX, again.splitY], [brand.panes, brand.focus, 0.2, 0.66], 'the layout is saved');
  const damaged = sanitize({ brands: [{ ...JSON.parse(JSON.stringify(brand)), panes: [b, b, 't_ffffffffff', d, d, b], focus: 9 }] }).brands[0];
  assert.deepEqual(damaged.panes, [b, null, null, d], 'no duplicates, no unknown tabs, four at most');
  assert.equal(damaged.focus, 0);
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
  assert.deepEqual(brand.tabs.map((t) => t.id), ['t_0123456789'],
    'the javascript: tab is left blank, and a blank tab in no pane is dropped');
  assert.equal(brand.tabs[0].favicon, '');
  assert.equal(brand.tabs[0].keepAwake, false);
  assert.equal(brand.tabs[0].homeUrl, 'https://x.example/');
  assert.equal(brand.activeTabId, 't_0123456789');
  assert.deepEqual(data.settings, { ...cleanSettings(), sleepAfterMinutes: 0, maxLiveTabs: 50, hidePosted: true });
  assert.deepEqual(data.permissions, { 'b|https://a|media': true });
  assert.deepEqual(data.window, { width: 900, height: 700, x: undefined, y: undefined, maximized: false });
  assert.deepEqual(sanitize(null), defaults());
  assert.deepEqual(sanitize('garbage'), defaults());
});

test('tab names: only text the person changed, that the tab would not show anyway, becomes a name', () => {
  const blank = { name: '', title: '', url: '', homeUrl: '' };
  const insta = { name: '', title: 'Instagram', url: 'https://www.instagram.com/', homeUrl: 'https://www.instagram.com/' };
  const asleep = { name: '', title: '', url: 'https://www.tiktok.com/upload', homeUrl: 'https://www.tiktok.com/upload' };
  assert.equal(tabLabel(blank), UNNAMED_TAB);
  assert.equal(tabLabel(insta), 'Instagram');
  assert.equal(tabLabel(asleep), 'Tiktok', 'no title yet: the site');
  assert.equal(tabLabel({ ...insta, name: 'Acme IG' }), 'Acme IG');
  assert.equal(autoLabel({ ...insta, name: 'Acme IG' }), 'Instagram', 'what it shows without its name');

  // The interface: a box closed with its text unchanged sends nothing.
  assert.equal(renameText(UNNAMED_TAB, UNNAMED_TAB), null);
  assert.equal(renameText('Instagram', '  Instagram '), null, 'spaces are not a change');
  assert.equal(renameText('Instagram', 'Acme IG'), 'Acme IG');
  assert.equal(renameText('Acme IG', '   '), '', 'emptying the box is a change: it clears the name');

  // The main process: a name is kept only if it differs from what the tab shows anyway.
  assert.equal(nameFor(blank, UNNAMED_TAB), '', 'the placeholder is never a name');
  assert.equal(nameFor(insta, UNNAMED_TAB), '');
  assert.equal(nameFor(insta, ' Instagram '), '', 'the page title is not a name of its own');
  assert.equal(nameFor(asleep, 'Tiktok'), '', 'nor is the site');
  assert.equal(nameFor(insta, ''), '', 'empty text clears the name');
  assert.equal(nameFor(insta, '  Acme IG  '), 'Acme IG');
  assert.equal(nameFor({ ...insta, name: 'Acme IG' }, 'Instagram'), '', 'typing the title back undoes a name');
  assert.equal(nameFor(insta, 'x'.repeat(60)).length, 40);
  assert.equal(nameFor(insta, 7), '', 'not text');
});

test('repair on load: a saved "New tab" name and a stray blank tab are dropped', () => {
  // What a build before this fix could save: a blank tab named "New tab" by
  // accident that then loaded Instagram, and a blank tab outside every pane.
  const [brand] = sanitize({ brands: [{
    id: 'b_0123456789', name: 'Acme', panes: ['t_aaaaaaaaaa', 't_bbbbbbbbbb', 't_dddddddddd'], focus: 1,
    tabs: [
      { id: 't_aaaaaaaaaa', name: '', title: 'YouTube', url: 'https://studio.youtube.com/', homeUrl: 'https://studio.youtube.com/' },
      { id: 't_bbbbbbbbbb', name: 'New tab', title: 'Instagram', url: 'https://www.instagram.com/', homeUrl: 'https://www.instagram.com/' },
      { id: 't_cccccccccc', name: '', title: '', url: '', homeUrl: '' },
      { id: 't_dddddddddd', name: '', title: '', url: 'javascript:alert(1)' },
      { id: 't_eeeeeeeeee', name: 'Draft', title: '', url: '' },
    ],
  }] }).brands;
  const insta = brand.tabs.find((tab) => tab.id === 't_bbbbbbbbbb');
  assert.equal(insta.name, '');
  assert.equal(tabLabel(insta), 'Instagram', 'the tab follows its page again');
  assert.deepEqual(brand.tabs.map((tab) => tab.id), ['t_aaaaaaaaaa', 't_bbbbbbbbbb', 't_dddddddddd', 't_eeeeeeeeee'],
    'the blank tab in no pane goes; a blank tab in a pane and a named one stay');
  assert.ok(isBlank(brand.tabs[2]), 'a refused address in a pane leaves a blank tab there');
  assert.deepEqual([brand.panes, brand.focus, brand.activeTabId],
    [['t_aaaaaaaaaa', 't_bbbbbbbbbb', 't_dddddddddd'], 1, 't_bbbbbbbbbb'], 'the layout is untouched');
  const near = sanitize({ brands: [{ id: 'b_0123456789', tabs: [{ id: 't_aaaaaaaaaa', name: 'New tabs' }] }] });
  assert.equal(near.brands[0].tabs[0].name, 'New tabs', 'only the placeholder itself is dropped');
});

test('blank tabs live only in panes: one that loses its pane is removed', () => {
  const data = defaults();
  const brand = createBrand(data, { name: 'Blank', urls: ['https://a.example/', 'https://b.example/'] });
  const [a, b] = brand.tabs.map((tab) => tab.id);
  const ids = () => brand.tabs.map((tab) => tab.id);
  const consistent = () => {
    const placed = brand.panes.filter(Boolean);
    assert.ok(placed.every((id) => ids().includes(id)), 'every pane holds a tab of the brand, or nothing');
    assert.equal(new Set(placed).size, placed.length, 'a tab is in one pane at most');
    assert.equal(brand.activeTabId, brand.panes[brand.focus], 'activeTabId is the focused pane');
  };

  const blank = addTab(brand).id; // the new-tab button: a blank tab in the focused pane
  showTab(brand, blank);
  assert.deepEqual(brand.panes, [blank]);
  showTab(brand, b);
  assert.deepEqual(ids(), [a, b], 'another tab took its pane: no stray "New tab" in the strip');
  consistent();

  const first = addTab(brand).id;
  showTab(brand, first);
  const second = addTab(brand).id;
  showTab(brand, second);
  assert.deepEqual(ids(), [a, b, second], 'two new tabs in a row do not pile up');
  consistent();

  setPaneCount(brand, 3);
  assert.deepEqual(brand.panes, [second, a, b]);
  showTab(brand, b);
  focusPane(brand, 1);
  assert.ok(ids().includes(second), 'a blank tab on screen stays while other panes are used');
  setPaneCount(brand, 1);
  assert.deepEqual([brand.panes, ids()], [[a], [a, b]], 'fewer panes: the blank tab that lost its pane is removed');
  consistent();

  setPaneCount(brand, 2);
  removeTab(brand, b);
  assert.deepEqual(brand.panes, [a, null]);
  focusPane(brand, 1);
  const here = addTab(brand); // "Open a new tab here" in the empty pane
  showTab(brand, here.id);
  focusPane(brand, 0);
  assert.deepEqual(brand.panes, [a, here.id], 'focusing another pane moves nothing');
  here.url = here.homeUrl = 'https://c.example/'; // what navigating does
  setPaneCount(brand, 1);
  assert.ok(brand.tabs.includes(here), 'a tab that got an address is kept');

  const named = addTab(brand);
  showTab(brand, named.id);
  named.name = 'Later';
  showTab(brand, a);
  assert.ok(brand.tabs.includes(named), 'a blank tab the person named is kept');
  consistent();
});

// --------------------------------------------------------------- markdown

/** A short written form of parsed Markdown, to compare against. Tight list items show no <p>, as drawn. */
function show(nodes, tight = false) {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.text;
      case 'break': return '<br>';
      case 'codespan': return `<code>${n.text}</code>`;
      case 'link': return n.href ? `<a ${n.href}>${show(n.children)}</a>` : `<inert ${n.target}>${show(n.children)}</inert>`;
      case 'image': return `<picture ${n.alt}>`;
      case 'heading': return `<h${n.level}>${show(n.children)}</h${n.level}>`;
      case 'paragraph': return tight ? show(n.children) : `<p>${show(n.children)}</p>`;
      case 'code': return `<pre${n.lang ? ` ${n.lang}` : ''}>${n.text}</pre>`;
      case 'quote': return `<quote>${show(n.children)}</quote>`;
      case 'hr': return '<hr>';
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const items = n.items.map((item) =>
          `<li${item.task === null ? '' : item.task ? ' [x]' : ' [ ]'}>${show(item.children, n.tight)}</li>`).join('');
        return `<${tag}${n.ordered && n.start !== 1 ? ` ${n.start}` : ''}${n.tight ? '' : ' loose'}>${items}</${tag}>`;
      }
      case 'table': {
        const row = (cells, tag) =>
          `<tr>${cells.map((cell, c) => `<${tag}${n.align[c] ? ` ${n.align[c]}` : ''}>${show(cell)}</${tag}>`).join('')}</tr>`;
        return `<table>${row(n.head, 'th')}${n.rows.map((r) => row(r, 'td')).join('')}</table>`;
      }
      default: return `<${n.type}>${show(n.children)}</${n.type}>`;
    }
  }).join('');
}
const md = (source) => show(parseMarkdown(source).children);

test('markdown: a caption stays a caption - hashtag lines are text, line breaks are kept', () => {
  assert.equal(md('Big news today.\n\nWe are **live** in three cities.\n#launch #acme\n'),
    '<p>Big news today.</p><p>We are <strong>live</strong> in three cities.<br>#launch #acme</p>');
  assert.equal(md('#launch #acme #behind_the_scenes'), '<p>#launch #acme #behind_the_scenes</p>',
    'no space after #: hashtags, not a heading; underscores inside words are not italics');
  assert.equal(md('# Launch #acme'), '<h1>Launch #acme</h1>');
  assert.equal(md('## Closed ##'), '<h2>Closed</h2>');
  assert.equal(md('####### seven'), '<p>####### seven</p>');
  const lines = parseMarkdown('Line one  \nLine two\\\nLine three\r\nLine four').children[0].children;
  assert.equal(show(lines), 'Line one<br>Line two<br>Line three<br>Line four', 'trailing spaces, backslashes and CRLF are plain breaks');
  assert.equal(plainText(lines), 'Line one\nLine two\nLine three\nLine four');
  assert.ok(isMarkdownFile('Caption.MD') && isMarkdownFile('notes.markdown'));
  assert.ok(!isMarkdownFile('caption.txt') && !isMarkdownFile('subtitles.srt') && !isMarkdownFile('md'));
});

test('markdown: emphasis, strikethrough, code and escapes', () => {
  assert.equal(md('**bold**, *italic*, _also_, ***both***, ~~gone~~, `a *b*`'),
    '<p><strong>bold</strong>, <em>italic</em>, <em>also</em>, <em><strong>both</strong></em>, <del>gone</del>, <code>a *b*</code></p>');
  assert.equal(md('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
  assert.equal(md('\\*not italic\\*, 5 * 3 * 2, a*b, **unclosed and *half'),
    '<p>*not italic*, 5 * 3 * 2, a*b, **unclosed and *half</p>');
  assert.equal(md('~one tilde~ and ~~~three~~~'), '<p>~one tilde~ and ~~~three~~~</p>', 'only ~~ strikes through');
  assert.equal(md('``code with ` inside`` and `` ` ``'), '<p><code>code with ` inside</code> and <code>`</code></p>');
  assert.equal(md('`unclosed code'), '<p>`unclosed code</p>');
});

test('markdown: lists nest, keep their numbers and carry task boxes', () => {
  assert.equal(md('- one\n- two\n  - two a\n  - two b\n    1. deep\n- three'),
    '<ul><li>one</li><li>two<ul><li>two a</li><li>two b<ol><li>deep</li></ol></li></ul></li><li>three</li></ul>');
  assert.equal(md('3. third\n4. fourth\n\n- [ ] draft caption\n- [x] post reel\n- [X] also done\n- [link](https://a.example/)'),
    '<ol 3><li>third</li><li>fourth</li></ol>' +
    '<ul><li [ ]>draft caption</li><li [x]>post reel</li><li [x]>also done</li><li><a https://a.example/>link</a></li></ul>');
  assert.equal(md('- a\n\n- b'), '<ul loose><li><p>a</p></li><li><p>b</p></li></ul>', 'a blank line between items: loose');
  assert.equal(md('- item\ngoes on\n- next'), '<ul><li>item<br>goes on</li><li>next</li></ul>', 'unindented text continues an item');
  assert.equal(md('1) a\n2) b\n1. c'), '<ol><li>a</li><li>b</li></ol><ol><li>c</li></ol>', 'another delimiter: another list');
  assert.equal(md('Top three:\n1. Fast\n2. Cheap\n\nIn 2024. we grew'),
    '<p>Top three:</p><ol><li>Fast</li><li>Cheap</li></ol><p>In 2024. we grew</p>');
  assert.equal(md('* * *\n- - -'), '<hr><hr>', 'a rule is not a list');
});

test('markdown: tables, with alignment and escaped pipes', () => {
  assert.equal(md('| Site | Posts | Note |\n| :--- | ---: | :-: |\n| TikTok | **3** | a \\| b |\n| X |'),
    '<table><tr><th left>Site</th><th right>Posts</th><th center>Note</th></tr>' +
    '<tr><td left>TikTok</td><td right><strong>3</strong></td><td center>a | b</td></tr>' +
    '<tr><td left>X</td><td right></td><td center></td></tr></table>');
  assert.equal(md('Intro\na | b\n--- | ---\n1 | 2\n\nAfter'),
    '<p>Intro</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><p>After</p>');
  assert.equal(md('| a | b |\n| --- |'), '<p>| a | b |<br>| --- |</p>', 'cell counts differ: not a table');
});

test('markdown: code blocks, quotes, rules and underlined headings', () => {
  assert.equal(
    md('```js\nconst a = "<b>";\n  *not* emphasis\n```\n\n    indented code\n\n> quoted **text**\nlazy line\n> > nested\n\n---\n\nTitle\n===\nSub\n---\n~~~\nunclosed'),
    '<pre js>const a = "<b>";\n  *not* emphasis</pre><pre>indented code</pre>' +
    '<quote><p>quoted <strong>text</strong><br>lazy line</p><quote><p>nested</p></quote></quote>' +
    '<hr><h1>Title</h1><h2>Sub</h2><pre>unclosed</pre>');
});

test('markdown: raw HTML stays text, only web links are live, pictures keep only their description', () => {
  assert.deepEqual(parseMarkdown('<script>alert(1)</script>\n<b onclick="steal()">bold</b>').children, [{
    type: 'paragraph',
    children: [{ type: 'text', text: '<script>alert(1)</script>' }, { type: 'break' }, { type: 'text', text: '<b onclick="steal()">bold</b>' }],
  }]);
  const links = parseMarkdown('[ok](https://a.example/x "Title") [js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) ' +
    '[mail](mailto:a@b.example) [file](file:///C:/x) [here](./notes.md) <javascript:alert(2)> <https://b.example/> ' +
    'see https://c.example/path?q=(1).')
    .children[0].children.filter((n) => n.type === 'link');
  assert.deepEqual(links.map((link) => link.href),
    ['https://a.example/x', null, null, null, null, null, null, 'https://b.example/', 'https://c.example/path?q=(1)']);
  assert.equal(links[1].target, 'javascript:alert(1)', 'an inert link still says where it pointed');
  assert.equal(md('See [the site][s] and [s].\n\n[s]: https://s.example/ "Title"\n[unused]: https://u.example/'),
    '<p>See <a https://s.example/>the site</a> and <a https://s.example/>s</a>.</p>');
  assert.equal(md('[no such reference] and [text](<no end'), '<p>[no such reference] and [text](<no end</p>');
  assert.equal(md('[![badge](https://img.example/b.svg)](https://a.example/)'),
    '<p><a https://a.example/><picture badge></a></p>', 'a picture inside a link');
  assert.equal(md('![Our *logo*](https://a.example/logo.png) ![](pixel.gif)'), '<p><picture Our logo> <picture ></p>');
  assert.equal(webHref(' https://a.example '), 'https://a.example/');
  for (const bad of ['javascript:alert(1)', 'http:/x', 'ftp://a.example', 'data:text/html,x', '//a.example', '', null]) {
    assert.equal(webHref(bad), null, String(bad));
  }
});

test('markdown: hostile files are read quickly, without deep recursion', () => {
  const size = 200_000;
  const hostile = {
    stars: 'a*'.repeat(size / 2),
    underscores: '_a'.repeat(size / 2),
    brackets: '[a]('.repeat(size / 4),
    backticks: Array.from({ length: 600 }, (_, k) => `${'`'.repeat(k + 1)}x`).join(''),
    angles: '<http:'.repeat(size / 6),
    quotes: '>'.repeat(size),
    indents: Array.from({ length: 2000 }, (_, k) => `${' '.repeat(k * 2)}- item`).join('\n'),
    deepEmphasis: `${'*a '.repeat(3000)}b${' c*'.repeat(3000)}`,
  };
  /** Nodes in a tree, counted without recursion (the tree may be thousands of levels deep). */
  const nodes = (root) => {
    let count = 0;
    const stack = [root];
    while (stack.length) {
      const value = stack.pop();
      if (Array.isArray(value)) for (const v of value) stack.push(v);
      else if (value && typeof value === 'object') {
        count += 1;
        for (const v of Object.values(value)) stack.push(v);
      }
    }
    return count;
  };
  for (const [name, text] of Object.entries(hostile)) {
    const started = Date.now();
    const doc = parseMarkdown(text);
    const ms = Date.now() - started;
    assert.ok(ms < 1500, `${name}: ${ms} ms`);
    assert.ok(nodes(doc) > 1, name);
  }
  const deep = parseMarkdown(hostile.deepEmphasis).children[0].children;
  assert.equal(plainText(deep), hostile.deepEmphasis.replace(/\*/g, ''), 'plain text of a very deep tree, without recursion');
});

// ---------------------------------------------------------------- updates

test('release notes: plain text from whatever the feed carries', () => {
  assert.equal(notesText('- one\n- two'), '- one\n- two');
  assert.equal(notesText('<ul><li>Faster &amp; smaller</li><li>Fixes</li></ul>'), '- Faster & smaller\n- Fixes');
  assert.equal(notesText([{ version: '0.2.1', note: 'b' }, { version: '0.2.0', note: 'a' }]), 'b\n\na');
  assert.equal(notesText(null), '');
  assert.equal(notesText('x'.repeat(30_000)).length, 20_000);
});

test('what is new is offered once, on the first start after an update', () => {
  const notes = { version: '0.2.1', text: 'better' };
  assert.equal(whatsNew('', '0.2.1', notes), null, 'a fresh install has nothing to announce');
  assert.equal(whatsNew('0.2.1', '0.2.1', notes), null, 'same version as last time');
  assert.deepEqual(whatsNew('0.2.0', '0.2.1', notes), { version: '0.2.1', text: 'better' });
  assert.deepEqual(whatsNew('0.2.0', '0.2.1', { version: '0.1.9', text: 'old' }), { version: '0.2.1', text: '' },
    'notes of another version are not shown');
  assert.deepEqual(whatsNew('0.2.0', '0.2.1', null), { version: '0.2.1', text: '' });
});

test('changelog sections become release notes', () => {
  const log = '# Changelog\n\nintro\n\n## 0.2.0 - 2026-11-12\n\n- updates\n- smaller\n\n## 0.1.0 - 2026-11-12\n\nFirst.\n';
  assert.equal(notesFor(log, '0.2.0'), '- updates\n- smaller');
  assert.equal(notesFor(log, '0.1.0'), 'First.');
  assert.equal(notesFor(log, '0.2'), '', 'a prefix of a version is not that version');
  assert.equal(notesFor(log, '9.9.9'), '');
  assert.equal(notesFor('## 1.0.0\n- a long\n  wrapped item\n- next', '1.0.0'), '- a long wrapped item\n- next');
});

test('update settings survive a save and a damaged file', () => {
  assert.equal(defaults().settings.autoUpdate, true);
  const data = sanitize({ settings: { autoUpdate: false }, lastVersion: '0.2.0', releaseNotes: { version: '0.2.1', text: 'n' } });
  assert.equal(data.settings.autoUpdate, false);
  assert.equal(data.lastVersion, '0.2.0');
  assert.deepEqual(data.releaseNotes, { version: '0.2.1', text: 'n' });
  assert.equal(sanitize({ lastVersion: 7, releaseNotes: { version: 1 } }).releaseNotes, null);
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
