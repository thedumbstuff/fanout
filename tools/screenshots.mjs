// The README's pictures, made from the real app: npm run screenshots
//
// Boots fanout against a throwaway profile in .smoke/screenshots, with made-up
// brands (Acme Foods, Northwind Travel, Juniper Yoga) and sample folders made
// here: pictures drawn and short clips recorded in a hidden window of this
// tool's own, so nothing is downloaded and nothing of the owner's is used. The
// tabs open public pages of the sites people post to, signed out. Writes
// assets/screenshots/<name>.png.
//
// A page is a native layer above the interface (docs/architecture.md), so a
// capture of the interface alone has holes where the pages are. Each picture
// is put together the way the window is: the interface's capturePage(), then
// every attached page's capturePage() laid over it at that page's rectangle.
// capturePage reads what Chromium drew, not the screen, so the window may be
// under or behind other windows. It is shown without taking the focus, on a
// screen the mouse pointer is not on (a hover would show in the picture).
//
//   npm run screenshots                       every picture
//   npm run screenshots -- main add-brand     only these
//   npm run screenshots -- --check            also test the method on the first shot: compare
//                                             it with the system's own capture of fanout's
//                                             window (that window only, never the screen),
//                                             then cover the window and compose again;
//                                             results in .smoke/screenshots/check
//   npm run screenshots -- --folders          only make the sample folders (no app, no pages)
//
// Pages are loaded and captured, nothing else: no script runs in them and
// nothing is clicked or typed in them (the project's rule). The interface is
// driven through its own bridge and DOM, as tools/smoke.mjs does. Each page's
// own capture is kept in .smoke/screenshots/pages, to look at before using a shot.

import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets', 'screenshots');
const WORK = path.join(ROOT, '.smoke', 'screenshots');
const FOLDERS = path.join(WORK, 'folders');
const PAGES = path.join(WORK, 'pages');
const SIZE = { width: 1440, height: 900 }; // the window's inside, in the interface's pixels

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-') && !arg.endsWith('.mjs'));
const CHECK = process.argv.includes('--check');
const FOLDERS_ONLY = process.argv.includes('--folders');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(PAGES, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
process.env.FANOUT_USER_DATA = path.join(WORK, 'profile');
nativeTheme.themeSource = 'light';

// The app shows its window when it is ready; here it must not take the focus
// from whoever is using the computer.
let windowSeen = false;
app.on('browser-window-created', (_event, window) => {
  if (windowSeen) return;
  windowSeen = true;
  window.show = () => window.showInactive();
});
// A window under other windows counts as hidden to Chromium, which then stops
// drawing it, and capturePage hands back the last frame drawn: a picture of
// the interface as it was, under pages as they are now (seen once). So every
// web contents here keeps drawing while covered. Nothing changes in what a site
// is told about fanout, and nothing runs in a page.
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(150);
  }
  return false;
}

// ------------------------------------------------------------- sample data

// Public pages, signed out. What is on screen in a shot must show no other
// people's posts or photos and nothing about where this computer is, so:
// Google's sign-in is left out (it refuses fanout today; docs/gotchas.md) and
// YouTube is its front page, told the United States (else its logo carries the
// local country code); TikTok's sign-in names the country it is opened from and
// Pinterest's sits on a wall of pins, so those two stay sleeping tabs. Look at
// .smoke/screenshots/pages after a run: sites change their pages.
const SITES = {
  youtube: 'https://www.youtube.com/?gl=US',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  linkedin: 'https://www.linkedin.com/',
  tiktok: 'https://www.tiktok.com/login',
  x: 'https://x.com/',
  threads: 'https://www.threads.com/login',
  pinterest: 'https://www.pinterest.com/login/',
};

// `group`: the first four tabs side by side. `shown`: the one tab on screen otherwise.
// Every other tab is loaded once (for its icon and title) and then put to sleep.
const BRANDS = [
  { name: 'Acme Foods', color: '#f2792b', sites: ['youtube', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x'], group: true },
  { name: 'Northwind Travel', color: '#2f6fed', sites: ['threads', 'instagram', 'pinterest'], shown: 'threads' },
  { name: 'Juniper Yoga', color: '#18a36b', sites: ['instagram', 'youtube'], neverShown: true },
];

// What each brand's folder holds. Pictures and clips are drawn by DRAW below
// (scene: food, card, poster, town); text files are written as they are.
const MEDIA = {
  'Acme Foods': {
    'autumn-menu-launch.mp4': { scene: 'food', w: 1280, h: 720, seconds: 8, kicker: 'Acme Foods', title: 'New autumn menu', sub: 'From Monday 3 November' },
    'behind-the-scenes-kitchen.mp4': { scene: 'food', w: 960, h: 540, seconds: 4, soup: ['#f5d36b', '#d9a332', '#b8801f'], kicker: 'Behind the scenes', title: 'Soup, from 6 am', sub: 'Twelve litres before we open' },
    'store-opening-poster.png': { scene: 'poster', w: 1080, h: 1350, title: 'Now open on Mill Street', sub: 'Saturday from 9 am. The first soup is on us.' },
    'menu-card.png': { scene: 'card', w: 1080, h: 1350, title: 'Autumn menu' },
    'thumbnail - autumn menu.png': { scene: 'food', w: 1280, h: 720, kicker: 'Acme Foods', title: 'Autumn menu: first taste', sub: 'Pumpkin soup, apple crumble, chai' },
    'autumn menu/menu-teaser-vertical.mp4': { scene: 'food', w: 540, h: 960, seconds: 5, kicker: 'Acme Foods', title: 'Soup season', sub: 'Back on Monday' },
    'autumn menu/pumpkin-soup-overhead.jpg': { scene: 'food', w: 1080, h: 1080 },
    'autumn menu/apple-crumble.jpg': { scene: 'food', w: 1080, h: 1080, crumble: true },
  },
  'Northwind Travel': {
    'reel - top 5 weekend trips.mp4': { scene: 'town', w: 540, h: 960, seconds: 5, kicker: 'Northwind Travel', title: 'Top 5 weekend trips', sub: 'Number 1 will not surprise you' },
    'newsletter-header.png': { scene: 'town', w: 1200, h: 400, dusk: 0.55, kicker: 'Northwind Travel', title: 'Weekend ideas', band: true },
    'lisbon weekend/tram-28-timelapse.mp4': { scene: 'town', w: 960, h: 540, seconds: 6, tram: true, timelapse: true },
    'lisbon weekend/alfama-rooftops.jpg': { scene: 'town', w: 1600, h: 1067, dusk: 0.2 },
    'kyoto in autumn/maple-path.jpg': { scene: 'town', w: 1600, h: 1067, trees: true, dusk: 0.1 },
    'kyoto in autumn/temple-steps.mp4': { scene: 'town', w: 960, h: 540, seconds: 4, trees: true, dusk: 0.35 },
  },
  'Juniper Yoga': {
    'morning-flow-promo.png': { scene: 'town', w: 1080, h: 1080, trees: true, dusk: 0.6, kicker: 'Juniper Yoga', title: 'Morning flow', band: true },
  },
};

const TEXTS = {
  'Acme Foods': {
    'caption - autumn menu.md': [
      '**Our autumn menu starts Monday 3 November.**',
      '',
      'Pumpkin soup with toasted seeds, apple crumble with oat custard,',
      'and a chai that tastes like a blanket.',
      '',
      'Come in before 11 and the second coffee is on us.',
      '',
      '#acmefoods #autumnmenu #soupseason',
      '',
    ].join('\n'),
    'hashtags.txt': '#acmefoods #autumnmenu #soupseason #millstreet #eatlocal\n',
  },
  'Northwind Travel': {
    'lisbon weekend/caption.md': 'Three days, one tram line, too many custard tarts.\n\n**Lisbon in November**: from 189 per person, flights included.\n\n#northwindtravel #lisbon #weekendaway\n',
    'spring deals 2027 - draft.md': '## Spring deals (draft)\n\n- Kyoto, 7 nights, cherry blossom week\n- Lisbon, long weekend\n- Edinburgh by train\n\nPrices to follow.\n',
  },
  'Juniper Yoga': {
    'class schedule.md': '## This week\n\n- Monday 7 am: morning flow\n- Wednesday 6 pm: slow stretch\n',
  },
};

// Posted marks: file -> the sites it went to. A file sent everywhere is drawn highlighted.
const POSTED = {
  'Acme Foods': {
    'store-opening-poster.png': ['youtube', 'instagram', 'tiktok', 'linkedin', 'x', 'facebook'],
    'autumn-menu-launch.mp4': ['youtube', 'instagram', 'linkedin', 'facebook'],
    'behind-the-scenes-kitchen.mp4': ['instagram', 'tiktok'],
    'menu-card.png': ['instagram', 'facebook'],
    'thumbnail - autumn menu.png': ['youtube'],
    'autumn menu/menu-teaser-vertical.mp4': ['instagram', 'tiktok', 'youtube'],
  },
  'Northwind Travel': {
    'lisbon weekend/alfama-rooftops.jpg': ['threads', 'instagram', 'pinterest'],
    'lisbon weekend/tram-28-timelapse.mp4': ['threads', 'instagram'],
    'kyoto in autumn/maple-path.jpg': ['threads', 'instagram', 'pinterest'],
    'kyoto in autumn/temple-steps.mp4': ['instagram'],
    'reel - top 5 weekend trips.mp4': ['instagram'],
    'newsletter-header.png': ['pinterest'],
  },
};

// Drawing for the sample pictures and clips, run in the tool's own hidden
// window. Two subjects: a bowl of soup on a table (Acme Foods) and a town by
// the water (Northwind Travel). A still is one moment of a scene; a clip is
// several seconds of it, recorded with MediaRecorder.
const DRAW = String.raw`
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, p) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * p).toString(16).padStart(2, '0')).join('');
function disc(g, x, y, r, fill) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); }

function table(g, w, h) {
  const wood = g.createLinearGradient(0, 0, 0, h);
  wood.addColorStop(0, '#8b5b37'); wood.addColorStop(1, '#5b3920');
  g.fillStyle = wood; g.fillRect(0, 0, w, h);
  const s = Math.min(w, h), r = rng(11);
  g.lineWidth = Math.max(1, s * 0.004); g.strokeStyle = 'rgba(35, 18, 6, 0.45)';
  for (let y = s * 0.14; y < h; y += s * 0.2) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.lineWidth = Math.max(1, s * 0.002);
  for (let i = 0; i < 110; i++) {
    const x = r() * w, y = r() * h, l = s * (0.15 + r() * 0.4), d = (r() - 0.5) * s * 0.012;
    g.strokeStyle = r() < 0.5 ? 'rgba(255, 225, 190, 0.07)' : 'rgba(30, 14, 4, 0.13)';
    g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + l / 3, y + d, x + (2 * l) / 3, y - d, x + l, y); g.stroke();
  }
}

function bowl(g, cx, cy, R, t, o) {
  g.save(); g.translate(cx - R * 0.55, cy + R * 0.72); g.rotate(-0.3);
  g.fillStyle = '#efe5d3'; g.fillRect(-R * 0.8, -R * 0.4, R * 1.6, R * 0.8);
  g.fillStyle = 'rgba(201, 92, 52, 0.75)';
  for (let i = -3; i <= 3; i++) g.fillRect(i * R * 0.22 - R * 0.025, -R * 0.4, R * 0.05, R * 0.8);
  g.restore();
  g.save(); g.shadowColor = 'rgba(20, 8, 0, 0.5)'; g.shadowBlur = R * 0.3; g.shadowOffsetY = R * 0.08;
  disc(g, cx, cy, R, '#f7f2ea'); g.restore();
  disc(g, cx, cy, R * 0.9, '#e6ddcf');
  const colours = o.soup ?? (o.crumble ? ['#f0d29a', '#d4a463', '#a8743a'] : ['#ffb855', '#e8732b', '#c85a1e']);
  const soup = g.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.05, cx, cy, R * 0.82);
  soup.addColorStop(0, colours[0]); soup.addColorStop(0.7, colours[1]); soup.addColorStop(1, colours[2]);
  disc(g, cx, cy, R * 0.82, soup);
  const turn = t * 0.35;
  if (o.crumble) {
    const r = rng(5);
    for (let i = 0; i < 320; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * 0.78;
      disc(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.015 + r() * 0.03), r() < 0.5 ? '#f6dfae' : '#b9824a');
    }
    for (let i = 0; i < 5; i++) {
      const a = turn + i * 1.25;
      g.save(); g.translate(cx + Math.cos(a) * R * 0.45, cy + Math.sin(a) * R * 0.45); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, R * 0.16, R * 0.06, 0, 0, Math.PI * 2); g.fillStyle = '#f7ecc8'; g.fill();
      g.lineWidth = R * 0.02; g.strokeStyle = '#b8352b'; g.stroke(); g.restore();
    }
  } else {
    g.strokeStyle = 'rgba(255, 249, 238, 0.95)'; g.lineWidth = R * 0.04; g.lineCap = 'round'; g.beginPath();
    for (let a = 0; a <= Math.PI * 3.4; a += 0.04) {
      const d = R * (0.04 + a * 0.045), x = cx + Math.cos(a + turn) * d, y = cy + Math.sin(a + turn) * d;
      if (a) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    for (let i = 0; i < 11; i++) {
      const a = turn + i * 0.57, d = R * (0.42 + (i % 3) * 0.1);
      g.save(); g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d); g.rotate(a * 2);
      g.beginPath(); g.ellipse(0, 0, R * 0.04, R * 0.02, 0, 0, Math.PI * 2); g.fillStyle = i % 2 ? '#3f5b25' : '#6b8f3a'; g.fill();
      g.restore();
    }
  }
  g.save(); g.translate(cx + R * 1.18, cy + R * 0.05); g.rotate(0.18);
  g.fillStyle = '#c3c8cf'; g.beginPath(); g.roundRect(-R * 0.045, -R * 0.05, R * 0.09, R * 0.95, R * 0.045); g.fill();
  g.beginPath(); g.ellipse(0, -R * 0.2, R * 0.12, R * 0.18, 0, 0, Math.PI * 2); g.fillStyle = '#dde1e6'; g.fill();
  g.restore();
  g.lineWidth = R * 0.035; g.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const x0 = cx + (k - 1) * R * 0.28;
    g.beginPath();
    for (let i = 0; i <= 30; i++) {
      const p = i / 30, y = cy - R * 0.35 - p * R * 0.9, x = x0 + Math.sin(p * 6 + t * 2.2 + k * 2) * R * 0.07;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    const fade = g.createLinearGradient(0, cy - R * 0.35, 0, cy - R * 1.25);
    fade.addColorStop(0, 'rgba(255, 255, 255, 0)'); fade.addColorStop(0.3, 'rgba(255, 255, 255, 0.32)'); fade.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.strokeStyle = fade; g.stroke();
  }
}

function wrap(g, text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (line && g.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
  }
  return line ? [...lines, line] : lines;
}

/** Kicker, title and line under it; in a clip they come in one after another. */
function words(g, w, h, t, o) {
  if (!o.title) return;
  const s = Math.min(w, h), land = w > h * 1.15;
  const step = (at) => ease((t - at) / 0.8);
  let x = land ? w * 0.6 : w * 0.08, y = land ? h * 0.3 : h * 0.07;
  let width = land ? w * 0.36 : w * 0.84;
  g.save(); g.textBaseline = 'top';
  if (o.band) {
    const bh = h * (w / h > 2 ? 0.5 : 0.3);
    g.fillStyle = 'rgba(12, 20, 40, 0.55)'; g.fillRect(0, h - bh, w, bh);
    x = s * 0.08; y = h - bh + bh * 0.16; width = w * 0.8;
  }
  g.shadowColor = 'rgba(0, 0, 0, 0.35)'; g.shadowBlur = s * 0.02;
  const big = o.band && w / h > 2 ? s * 0.2 : s * 0.12;
  if (o.kicker) {
    g.globalAlpha = step(0.2); g.font = '600 ' + s * 0.045 + 'px "Segoe UI", sans-serif'; g.letterSpacing = s * 0.008 + 'px';
    g.fillStyle = '#ffd59a'; g.fillText(o.kicker.toUpperCase(), x, y); y += s * 0.08;
  }
  const k = step(0.6); g.globalAlpha = k; g.letterSpacing = '0px';
  g.font = '700 ' + big + 'px Georgia, serif'; g.fillStyle = '#fff7ea';
  for (const line of wrap(g, o.title, width)) { g.fillText(line, x + (1 - k) * s * 0.08, y); y += big * 1.08; }
  if (o.sub) {
    g.globalAlpha = step(1.4); g.font = '400 ' + s * 0.05 + 'px "Segoe UI", sans-serif'; g.fillStyle = '#f6e3c9'; y += s * 0.02;
    for (const line of wrap(g, o.sub, width)) { g.fillText(line, x, y); y += s * 0.065; }
  }
  g.restore();
}

function food(g, w, h, t, o) {
  table(g, w, h);
  const s = Math.min(w, h), land = w > h * 1.15, portrait = h > w * 1.15;
  const zoom = 1 + 0.025 * Math.sin(t * 0.7);
  const R = s * (land ? 0.36 : portrait ? 0.36 : 0.3) * zoom;
  bowl(g, land ? w * 0.3 : w * 0.5, land ? h * 0.55 : portrait ? h * 0.64 : h * 0.52, R, t, o);
}

function card(g, w, h, t, o) {
  table(g, w, h);
  const m = w * 0.1;
  g.save(); g.shadowColor = 'rgba(0, 0, 0, 0.45)'; g.shadowBlur = w * 0.04; g.shadowOffsetY = w * 0.01;
  g.fillStyle = '#f8f1e3'; g.fillRect(m, m, w - 2 * m, h - 2 * m); g.restore();
  g.strokeStyle = '#c9a77c'; g.lineWidth = w * 0.004; g.strokeRect(m * 1.35, m * 1.35, w - 2.7 * m, h - 2.7 * m);
  g.fillStyle = '#5a3a22'; g.textAlign = 'center'; g.textBaseline = 'top';
  g.font = '600 ' + w * 0.035 + 'px "Segoe UI", sans-serif'; g.letterSpacing = w * 0.006 + 'px';
  g.fillText('ACME FOODS', w / 2, m * 2);
  g.letterSpacing = '0px'; g.font = '700 ' + w * 0.09 + 'px Georgia, serif'; g.fillText(o.title, w / 2, m * 2 + w * 0.07);
  const items = [['Pumpkin soup, toasted seeds', '6.50'], ['Apple crumble, oat custard', '5.00'], ['Leek and potato pie', '9.50'], ['Spiced chai', '3.20'], ['Hot apple cider', '3.50']];
  let y = m * 2 + w * 0.3;
  g.font = '400 ' + w * 0.04 + 'px Georgia, serif';
  for (const [name, price] of items) {
    g.textAlign = 'left'; g.fillText(name, m * 2, y);
    g.textAlign = 'right'; g.fillText(price, w - m * 2, y);
    const from = m * 2 + g.measureText(name).width + w * 0.02, to = w - m * 2 - w * 0.12;
    g.fillStyle = '#b89a76';
    for (let x = from; x < to; x += w * 0.015) disc(g, x, y + w * 0.03, w * 0.003, '#b89a76');
    g.fillStyle = '#5a3a22'; y += w * 0.1;
  }
  g.textAlign = 'center'; g.font = 'italic 400 ' + w * 0.04 + 'px Georgia, serif'; g.fillText('From Monday 3 November', w / 2, h - m * 2.6);
}

function poster(g, w, h, t, o) {
  g.fillStyle = '#f2792b'; g.fillRect(0, 0, w, h);
  disc(g, w * 0.9, h * 0.12, w * 0.38, '#f79a3e'); disc(g, w * 0.05, h * 0.95, w * 0.34, '#e0611f');
  bowl(g, w * 0.46, h * 0.68, w * 0.26, t, o);
  words(g, w, h, 9, { ...o, kicker: 'Acme Foods' });
}

function houses(g, w, h, phase) {
  const r = rng(3), walls = ['#f3e3c7', '#f6d2b0', '#e9b48a', '#f1ece2', '#cfe0e8', '#f5c96b'];
  for (const [base, scale, light] of [[h * 0.74, 0.7, 0.25], [h * 0.9, 1, 0.1], [h * 1.06, 1.3, 0]]) {
    let x = -r() * w * 0.05;
    while (x < w) {
      const bw = w * (0.06 + r() * 0.07) * scale, bh = h * (0.12 + r() * 0.14) * scale;
      const wall = walls[Math.floor(r() * walls.length)];
      g.fillStyle = mix(mix(wall, '#c9d7ea', light), '#6b5a7a', phase * 0.35); g.fillRect(x, base - bh, bw, h);
      g.fillStyle = mix(mix('#b4532d', '#c9d7ea', light), '#5a3a4a', phase * 0.35);
      g.beginPath(); g.moveTo(x - bw * 0.04, base - bh); g.lineTo(x + bw / 2, base - bh * 1.3); g.lineTo(x + bw * 1.04, base - bh); g.fill();
      const cols = Math.max(1, Math.round(bw / (w * 0.028)));
      for (let c = 0; c < cols; c++) {
        for (let row = 0; row < 3; row++) {
          const wy = base - bh + bh * (0.15 + row * 0.27);
          const lit = phase > 0.5 && r() < phase - 0.3;
          g.fillStyle = lit ? '#ffd27a' : 'rgba(40, 52, 70, ' + (0.75 - light) + ')';
          g.fillRect(x + (bw * (c + 0.5)) / cols - bw * 0.05, wy, bw * 0.1, bh * 0.13);
        }
      }
      x += bw + w * 0.004;
    }
  }
}

function maples(g, w, h, t) {
  const r = rng(9), s = Math.min(w, h);
  g.fillStyle = '#6f7d3c'; g.fillRect(0, h * 0.68, w, h);
  g.fillStyle = '#d9c4a0'; g.beginPath();
  g.moveTo(w * 0.46, h * 0.68); g.lineTo(w * 0.54, h * 0.68); g.lineTo(w * 0.8, h); g.lineTo(w * 0.2, h); g.fill();
  g.strokeStyle = 'rgba(120, 90, 60, 0.45)'; g.lineWidth = Math.max(1, h * 0.004);
  for (let i = 1; i < 9; i++) {
    const p = Math.pow(i / 9, 1.6), y = h * 0.68 + p * h * 0.32, half = w * (0.04 + p * 0.26);
    g.beginPath(); g.moveTo(w / 2 - half, y); g.lineTo(w / 2 + half, y); g.stroke();
  }
  const trees = Array.from({ length: 16 }, () => {
    const left = r() < 0.5;
    return { x: left ? r() * w * 0.4 : w * 0.6 + r() * w * 0.4, base: h * (0.7 + r() * 0.28), seed: Math.floor(r() * 1e6) };
  }).sort((a, b) => a.base - b.base);
  for (const tree of trees) {
    const q = rng(tree.seed), size = s * 0.28 * (tree.base / h);
    g.fillStyle = '#4a3326'; g.fillRect(tree.x - size * 0.06, tree.base - size * 1.2, size * 0.12, size * 1.2);
    for (let i = 0; i < 16; i++) {
      const a = q() * Math.PI * 2, d = q() * size * 0.7;
      disc(g, tree.x + Math.cos(a) * d * 1.2, tree.base - size * 1.45 + Math.sin(a) * d * 0.7, size * (0.22 + q() * 0.2),
        ['#d8432b', '#e8662d', '#f29a38', '#b8322a', '#f4b544'][Math.floor(q() * 5)]);
    }
  }
  const leaves = rng(21);
  for (let i = 0; i < 26; i++) {
    const x = (leaves() * w + t * w * 0.04 * (1 + leaves())) % w, y = (leaves() * h + t * h * 0.09) % h;
    g.save(); g.translate(x, y); g.rotate(t * 2 + i);
    g.beginPath(); g.ellipse(0, 0, s * 0.008, s * 0.004, 0, 0, Math.PI * 2); g.fillStyle = '#e8662d'; g.fill(); g.restore();
  }
}

function tram(g, w, h, t, seconds) {
  const tw = w * 0.22, th = h * 0.12, y = h * 0.95 - th, x = -tw + (w + tw) * clamp(t / seconds);
  g.fillStyle = '#7d766c'; g.fillRect(0, h * 0.95, w, h * 0.05);
  g.strokeStyle = '#2b2b2b'; g.lineWidth = Math.max(1, h * 0.003);
  g.beginPath(); g.moveTo(0, y - th * 0.55); g.lineTo(w, y - th * 0.55); g.stroke();
  g.beginPath(); g.moveTo(x + tw * 0.45, y); g.lineTo(x + tw * 0.55, y - th * 0.55); g.stroke();
  g.fillStyle = '#f7c51c'; g.beginPath(); g.roundRect(x, y, tw, th, th * 0.18); g.fill();
  g.fillStyle = '#d9412b'; g.fillRect(x, y + th * 0.74, tw, th * 0.1);
  g.fillStyle = '#3a4656';
  for (let i = 0; i < 4; i++) g.fillRect(x + tw * (0.07 + i * 0.235), y + th * 0.14, tw * 0.17, th * 0.4);
}

function birds(g, w, h, t) {
  const r = rng(4);
  g.strokeStyle = 'rgba(40, 40, 60, 0.6)'; g.lineWidth = Math.max(1, h * 0.003);
  for (let i = 0; i < 5; i++) {
    const x = ((r() + t * 0.03) % 1) * w, y = h * (0.1 + r() * 0.2), s = h * 0.015, flap = Math.sin(t * 6 + i) * s * 0.4;
    g.beginPath(); g.moveTo(x - s, y - flap); g.quadraticCurveTo(x - s * 0.4, y - s * 0.5, x, y);
    g.quadraticCurveTo(x + s * 0.4, y - s * 0.5, x + s, y - flap); g.stroke();
  }
}

function town(g, w, h, t, o) {
  const s = Math.min(w, h), phase = o.timelapse ? clamp(t / o.seconds) * 0.8 : (o.dusk ?? 0.15);
  const sky = g.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, mix('#4f8fe6', '#33407f', phase)); sky.addColorStop(1, mix('#cfe4ff', '#ffab73', phase));
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  const sx = w * 0.72, sy = h * (0.2 + phase * 0.32);
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, s * 0.45);
  glow.addColorStop(0, 'rgba(255, 236, 170, 0.85)'); glow.addColorStop(1, 'rgba(255, 236, 170, 0)');
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  disc(g, sx, sy, s * 0.07, mix('#fff3c4', '#ffd08a', phase));
  g.fillStyle = mix('#8fb0d6', '#6d6b9c', phase); g.beginPath(); g.moveTo(0, h * 0.6);
  for (let x = 0; x <= w; x += w / 40) g.lineTo(x, h * 0.52 - Math.sin(x / w * 5 + 1) * h * 0.04 - Math.sin(x / w * 13) * h * 0.01);
  g.lineTo(w, h * 0.6); g.fill();
  g.fillStyle = mix('#3f7fc2', '#4f4f8f', phase); g.fillRect(0, h * 0.58, w, h * 0.08);
  birds(g, w, h, t);
  if (o.trees) maples(g, w, h, t); else houses(g, w, h, phase);
  if (o.tram) tram(g, w, h, t, o.seconds);
  words(g, w, h, t, o);
}

const SCENES = {
  food: (g, w, h, t, o) => { food(g, w, h, t, o); words(g, w, h, t, o); },
  card, poster, town,
};

function canvas(o) {
  const c = document.createElement('canvas');
  c.width = o.w; c.height = o.h;
  return c;
}

window.still = (o) => {
  const c = canvas(o);
  SCENES[o.scene](c.getContext('2d'), o.w, o.h, 9, o);
  return c.toDataURL(o.type, 0.9);
};

window.clip = (o) => new Promise((resolve, reject) => {
  const c = canvas(o), g = c.getContext('2d');
  const stream = c.captureStream(0);
  const [track] = stream.getVideoTracks();
  const type = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(o.w * o.h * 3) });
  const parts = [];
  recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  recorder.onerror = (e) => reject(new Error(String(e.error ?? 'the recorder failed')));
  recorder.onstop = () => {
    const reader = new FileReader();
    reader.onload = () => resolve({ type, data: reader.result });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob(parts, { type }));
  };
  const fps = 30, frames = Math.round(o.seconds * fps);
  let n = 0;
  SCENES[o.scene](g, o.w, o.h, 0, o);
  recorder.start();
  track.requestFrame();
  const timer = setInterval(() => {
    n += 1;
    if (n > frames) { clearInterval(timer); recorder.stop(); return; }
    SCENES[o.scene](g, o.w, o.h, n / fps, o);
    track.requestFrame();
  }, 1000 / fps);
});
`;

/** Every brand's folder, with real pictures, real clips and caption files. */
async function makeFolders() {
  const painter = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  try {
    await painter.loadURL('data:text/html,<!doctype html><title>painter</title>');
    await painter.webContents.executeJavaScript(`${DRAW};0`);
    const jobs = [];
    for (const [brand, files] of Object.entries(MEDIA)) {
      for (const [rel, spec] of Object.entries(files)) {
        const file = path.join(FOLDERS, brand, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (spec.seconds) {
          jobs.push(painter.webContents.executeJavaScript(`clip(${JSON.stringify(spec)})`).then(({ type, data }) => {
            // The name says .mp4; should this Chromium record only WebM, the file says so instead.
            const target = type.startsWith('video/mp4') ? file : file.replace(/\.mp4$/, '.webm');
            fs.writeFileSync(target, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
          }));
        } else {
          const type = rel.endsWith('.png') ? 'image/png' : 'image/jpeg';
          const data = await painter.webContents.executeJavaScript(`still(${JSON.stringify({ ...spec, type })})`);
          fs.writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
        }
      }
    }
    await Promise.all(jobs);
  } finally {
    painter.destroy();
  }
  for (const [brand, files] of Object.entries(TEXTS)) {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(FOLDERS, brand, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
}

// ------------------------------------------------------------- composition

/**
 * The window's inside as a person sees it: the interface, and each page on
 * screen laid over it at its rectangle, in the order they are stacked.
 */
async function compose(window) {
  const ui = window.webContents;
  const views = window.contentView.children.filter((view) => view.webContents && view.webContents !== ui);
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  // A fresh frame of everything, so no layer is a frame behind the others.
  for (const contents of [ui, ...views.map((view) => view.webContents)]) contents.invalidate();
  await wait(300);
  // A page attached a moment ago may not have drawn its first frame yet.
  const capture = async (contents) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await contents.capturePage();
      } catch (error) {
        if (attempt === 10) throw error;
        await wait(300);
      }
    }
  };
  const [base, ...layers] = await Promise.all([capture(ui), ...views.map((view) => capture(view.webContents))]);
  const { width, height } = base.getSize(scale);
  const pixels = Buffer.from(base.toBitmap({ scaleFactor: scale }));
  const pages = views.map((view, index) => ({ view, bounds: view.getBounds(), image: layers[index], url: view.webContents.getURL() }));
  for (const { bounds, image } of pages) {
    const size = image.getSize(scale);
    const source = image.toBitmap({ scaleFactor: scale });
    const x = Math.round(bounds.x * scale);
    const y = Math.round(bounds.y * scale);
    for (let row = 0; row < size.height; row += 1) {
      const to = y + row;
      if (to < 0 || to >= height) continue;
      const from = Math.max(0, -x);
      const end = Math.min(size.width, width - x);
      if (end > from) source.copy(pixels, (to * width + x + from) * 4, (row * size.width + from) * 4, (row * size.width + end) * 4);
    }
  }
  let image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
  if (scale !== 1) image = image.resize({ width: Math.round(width / scale), height: Math.round(height / scale), quality: 'best' });
  return { image, pages };
}

/** True when a picture is (nearly) one flat colour: a page that drew nothing. */
function looksBlank(image) {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  const colours = new Map();
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const i = (y * width + x) * 4;
      const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
      colours.set(key, (colours.get(key) ?? 0) + 1);
    }
  }
  const total = [...colours.values()].reduce((a, b) => a + b, 0);
  return Math.max(...colours.values()) / total > 0.985;
}

/** A picture's pixels averaged over blocks of k x k (a video frame keeps colour per 2 x 2 block). */
function blocks(image, k) {
  const { width, height } = image.getSize();
  const source = image.toBitmap();
  if (k === 1) return { pixels: source, width, height };
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < k; dy += 1) for (let dx = 0; dx < k; dx += 1) sum += source[((y * k + dy) * width + x * k + dx) * 4 + c];
        pixels[(y * w + x) * 4 + c] = Math.round(sum / (k * k));
      }
    }
  }
  return { pixels, width: w, height: h };
}

/**
 * Share of pixels that differ clearly between two pictures of one size (compared
 * per k x k block), and a picture of where, drawn from the first one.
 */
function difference(a, b, regions = [], k = 1) {
  const sa = a.getSize();
  const sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) return null;
  const { pixels: pa, width, height } = blocks(a, k);
  const { pixels: pb } = blocks(b, k);
  regions = regions.map((r) => ({ ...r, x: Math.floor(r.x / k), y: Math.floor(r.y / k), width: Math.floor(r.width / k), height: Math.floor(r.height / k) }));
  const marks = Buffer.alloc(pa.length);
  const counts = regions.map(() => 0);
  let differ = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
    if (d > 24) {
      differ += 1;
      marks.set([0x89, 0x5f, 0xfb, 255], i);
      const p = i / 4;
      const x = p % width;
      const y = Math.floor(p / width);
      const r = regions.findIndex((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
      if (r !== -1) counts[r] += 1;
    } else {
      const v = 170 + Math.round((pa[i] + pa[i + 1] + pa[i + 2]) / 9);
      marks.set([v, v, v, 255], i);
    }
  }
  return {
    share: differ / (width * height),
    regions: regions.map((rect, r) => ({ ...rect, share: counts[r] / (rect.width * rect.height) })),
    image: nativeImage.createFromBitmap(marks, { width, height }),
  };
}

/**
 * fanout's window as the system composes it (on Windows 11 its inside; with a
 * frame, findInside cuts the inside out), through the system's window capture:
 * the same route a screen-sharing app takes. Only
 * this one window is captured, never the screen, so nothing else that is open
 * on the computer can end up in it.
 */
async function fromSystem(window) {
  const page = path.join(WORK, 'grab.html');
  fs.writeFileSync(page, '<!doctype html><title>grab</title>');
  const grabber = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await grabber.loadFile(page);
    const data = await grabber.webContents.executeJavaScript(`(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(window.getMediaSourceId())}, maxWidth: 8000, maxHeight: 8000 } } });
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      for (const track of stream.getTracks()) track.stop();
      return canvas.toDataURL('image/png');
    })()`);
    return nativeImage.createFromDataURL(data);
  } finally {
    grabber.destroy();
  }
}

/** Where the window's inside sits in a capture of the whole window: the offset that fits best. */
function findInside(whole, inside) {
  const W = whole.getSize();
  const I = inside.getSize();
  const a = whole.toBitmap();
  const b = inside.toBitmap();
  let best = null;
  for (let dy = 0; dy <= W.height - I.height; dy += 1) {
    for (let dx = 0; dx <= W.width - I.width; dx += 1) {
      let cost = 0;
      for (let y = 5; y < I.height; y += 37) {
        for (let x = 3; x < I.width; x += 29) {
          const i = (y * I.width + x) * 4;
          const j = ((y + dy) * W.width + x + dx) * 4;
          cost += Math.abs(a[j] - b[i]) + Math.abs(a[j + 1] - b[i + 1]) + Math.abs(a[j + 2] - b[i + 2]);
        }
      }
      if (!best || cost < best.cost) best = { cost, x: dx, y: dy };
    }
  }
  return best && whole.crop({ x: best.x, y: best.y, width: I.width, height: I.height });
}

// ------------------------------------------------------------------ shots

// Each shot arranges the app; the harness then waits for the pages on screen
// to settle, composes the picture and writes assets/screenshots/<name>.png.
// `after` puts back what the shot changed for the next one.
const SHOTS = [
  {
    name: 'main',
    theme: 'light',
    async arrange(kit) {
      const acme = kit.brand('Acme Foods');
      await kit.bridge('selectBrand', acme.id);
      kit.ctx.tabs.focusPane(acme.id, 0);
      await kit.files({ open: ['autumn menu'], preview: 'caption - autumn menu.md' });
    },
  },
  {
    name: 'on-its-own',
    theme: 'light',
    async arrange(kit) {
      const acme = kit.brand('Acme Foods');
      await kit.bridge('selectTab', kit.tab(acme, 'x').id);
      await kit.files({ open: ['autumn menu'], preview: null });
    },
    async after(kit) {
      const acme = kit.brand('Acme Foods');
      kit.ctx.tabs.focusPane(acme.id, 0);
      kit.ctx.tabs.sleep(kit.tab(acme, 'x').id, { auto: true });
    },
  },
  {
    name: 'add-brand',
    theme: 'light',
    async arrange(kit) {
      // The folder picker is the system's own dialog; here it answers with a made-up folder.
      ipcMain.removeHandler('brand:choose-folder');
      ipcMain.handle('brand:choose-folder', () => 'D:\\Brands\\Brightside Books');
      const dialog = 'document.querySelector("dialog.dialog")';
      await kit.dom('document.getElementById("add-brand").click()');
      await until(() => kit.dom(`Boolean(${dialog})`));
      await kit.dom(`(() => {
        const dialog = ${dialog};
        dialog.querySelector('input[type=text]').value = 'Brightside Books';
        dialog.querySelector('.swatch[aria-label="#fb5f89"]').click();
        for (const chip of dialog.querySelectorAll('.chips .chip')) {
          if (['Instagram', 'TikTok', 'YouTube', 'Pinterest'].includes(chip.textContent)) chip.click();
        }
        [...dialog.querySelectorAll('button')].find((b) => b.textContent.startsWith('Choose folder')).click();
        document.activeElement?.blur();
      })()`);
      await until(() => kit.dom(`${dialog}.querySelector('.folder-path').textContent.includes('Brightside')`));
    },
    async after(kit) {
      await kit.dom('[...document.querySelectorAll("dialog.dialog button")].find((b) => b.textContent === "Cancel").click()');
    },
  },
  {
    name: 'posted-dark',
    theme: 'dark',
    async arrange(kit) {
      const northwind = kit.brand('Northwind Travel');
      await kit.bridge('selectBrand', northwind.id);
      const page = kit.tab(northwind, 'threads');
      await kit.bridge('selectTab', page.id);
      // A page reads the colour scheme as it loads; loading it again shows it dark.
      kit.ctx.tabs.act(page.id, 'reload');
      await kit.files({ open: ['kyoto in autumn', 'lisbon weekend'], preview: null, select: 'lisbon weekend/tram-28-timelapse.mp4' });
    },
  },
  // Next: 'viewer', the media viewer's large view on 'autumn-menu-launch.mp4' (Acme Foods),
  // once the viewer is on main. The clip is already in the sample folder.
];

// -------------------------------------------------------------------- run

async function run(ctx) {
  const ui = ctx.window.webContents;
  /** Run an expression in the interface; a failure says which expression and why. */
  const inInterface = async (expression) => {
    const result = await ui.executeJavaScript(
      `(async () => { try { return { value: await (${expression}) }; } catch (e) { return { error: String(e?.stack ?? e) }; } })()`);
    if (result.error) throw new Error(`${result.error}\n    in the interface: ${expression.slice(0, 300)}`);
    return result.value;
  };
  const kit = {
    ctx,
    bridge: (method, ...params) => inInterface(`window.fanout.${method}(...${JSON.stringify(params)})`),
    dom: inInterface,
    brand: (name) => ctx.store.data.brands.find((brand) => brand.name === name),
    tab: (brand, site) => brand.tabs.find((tab) => tab.homeUrl === SITES[site]),
    /** Open folders in the file panel, show a file in the preview (null closes it), select a file. */
    async files({ open = [], preview, select }) {
      const row = (rel) => `document.querySelector(${JSON.stringify(`#tree .row[data-rel="${rel}"]`)})`;
      const there = (rel) => until(() => kit.dom(`Boolean(${row(rel)})`));
      for (const rel of open) {
        await there(rel);
        if (!(await kit.dom(`${row(rel)}.classList.contains('is-open')`))) await kit.dom(`${row(rel)}.click()`);
        await until(() => kit.dom(`Boolean(document.querySelector(${JSON.stringify(`#tree .row[data-rel^="${rel}/"]`)}))`));
      }
      if (preview) {
        await there(preview);
        await kit.dom(`${row(preview)}.click()`);
        await until(() => kit.dom(`Boolean(document.querySelector('#preview:not([hidden]) :is(.preview-md, .preview-text)'))`));
      } else if (preview === null) {
        await kit.dom(`document.querySelector('#preview:not([hidden]) .tool[title="Close"]')?.click()`);
      }
      if (select) {
        await there(select);
        await kit.dom(`${row(select)}.click()`);
      }
      await kit.dom('(getSelection().removeAllRanges(), document.activeElement?.blur())');
    },
  };

  // The window: a fixed size, on a screen the pointer is not on.
  ctx.window.setContentSize(SIZE.width, SIZE.height);
  const pointer = screen.getCursorScreenPoint();
  const within = (point, r) => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height;
  const display = screen.getAllDisplays().find((d) => !within(pointer, d.bounds)) ?? screen.getPrimaryDisplay();
  const outer = ctx.window.getBounds();
  ctx.window.setPosition(
    display.workArea.x + Math.max(0, Math.round((display.workArea.width - outer.width) / 2)),
    display.workArea.y + Math.max(0, Math.round((display.workArea.height - outer.height) / 2)));

  console.log('drawing the sample folders...');
  await makeFolders();

  // Brands, with every tab loaded once (a tab that has been open has its icon and title).
  const live = (tab) => ctx.tabs.runtime(tab.id).live;
  const settled = (tab) => live(tab) && !ctx.tabs.runtime(tab.id).loading;
  const loadAll = async (brand) => {
    for (const tab of brand.tabs) {
      if (!live(tab)) await kit.bridge('selectTab', tab.id);
      await until(() => settled(tab) && Boolean(tab.favicon), 30000);
      // What each page drew, kept to look at (a page can change what it shows at any time).
      await wait(2500);
      const { pages } = await compose(ctx.window).catch(() => ({ pages: [] }));
      for (const page of pages) {
        const name = `loaded-${brand.name}-${new URL(page.url || 'about:blank').hostname}-${page.bounds.width}x${page.bounds.height}.png`;
        fs.writeFileSync(path.join(PAGES, name), page.image.toPNG());
      }
    }
  };
  // The tool decides what sleeps: a page the memory policy put to sleep would load
  // again from its current address, which can differ from the one asked for.
  await kit.bridge('updateSettings', { maxLiveTabs: 0, sleepAfterMinutes: 0 });
  for (const spec of BRANDS) {
    const folder = path.join(FOLDERS, spec.name);
    const urls = spec.sites.map((site) => SITES[site]);
    if (spec.neverShown) {
      const id = await kit.bridge('createBrand', { name: spec.name, color: spec.color, folder, urls: [] });
      for (const url of urls) ctx.tabs.open(id, { url, background: true });
      continue;
    }
    const id = await kit.bridge('createBrand', { name: spec.name, color: spec.color, folder, urls, together: spec.group === true });
    console.log(`loading ${spec.name}'s pages...`);
    const brand = ctx.store.data.brands.find((b) => b.id === id);
    await loadAll(brand);
    if (spec.group) ctx.tabs.focusPane(id, 0);
    else await kit.bridge('selectTab', kit.tab(brand, spec.shown).id);
    const keep = new Set(spec.group ? brand.panes : [kit.tab(brand, spec.shown).id]);
    for (const tab of brand.tabs) if (!keep.has(tab.id)) ctx.tabs.sleep(tab.id, { auto: true });
  }
  // Posted marks, as if set by hand over the last weeks.
  for (const [name, files] of Object.entries(POSTED)) {
    const brand = kit.brand(name);
    let day = 2;
    for (const [rel, sites] of Object.entries(files)) {
      for (const site of sites) {
        ctx.posted.set(brand.id, rel, kit.tab(brand, site).id, true, new Date(Date.UTC(2026, 10, day, 9 + sites.indexOf(site))));
      }
      day += 1;
    }
  }

  const wanted = args.length ? SHOTS.filter((shot) => args.includes(shot.name)) : SHOTS;
  for (const name of args.filter((n) => !SHOTS.some((shot) => shot.name === n))) console.log(`no shot called ${name}`);
  for (const shot of wanted) {
    nativeTheme.themeSource = shot.theme;
    await shot.arrange(kit);
    // Wait for the pages on screen to finish loading, then for late drawing (fonts, banners).
    const brand = ctx.store.data.brands.find((b) => b.id === ctx.store.data.activeBrandId);
    const onScreen = (brand.solo ? [brand.solo] : brand.panes).map((id) => brand.tabs.find((tab) => tab.id === id)).filter(Boolean);
    await until(() => onScreen.every((tab) => settled(tab)), 30000);
    await wait(6000);

    const { image, pages } = await compose(ctx.window);
    const file = path.join(OUT, `${shot.name}.png`);
    fs.writeFileSync(file, image.toPNG());
    const { width, height } = image.getSize();
    console.log(`${shot.name}.png  ${width}x${height}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
    for (const [index, page] of pages.entries()) {
      const host = new URL(page.url || 'about:blank').hostname || 'blank';
      fs.writeFileSync(path.join(PAGES, `${shot.name}-${index + 1}-${host}.png`), page.image.toPNG());
      const tab = brand.tabs.find((t) => ctx.tabs.runtime(t.id).live && page.url && t.url === page.url);
      const runtime = tab ? ctx.tabs.runtime(tab.id) : {};
      const problem = looksBlank(page.image) ? 'looks blank' : runtime.error ? `did not load: ${runtime.error.description}` : runtime.answer ? `site answered ${runtime.answer}` : '';
      console.log(`    page ${index + 1}  ${page.url}  ${page.bounds.width}x${page.bounds.height}${problem ? `  CHECK: ${problem}` : ''}`);
    }
    if (CHECK && shot === wanted[0]) await check(ctx, pages);
    await shot.after?.(kit);
  }
  console.log(`done: ${wanted.length} pictures in assets/screenshots, page captures in .smoke/screenshots/pages`);
}

/**
 * Is a composed picture true? (1) Capture fanout's window the way the system
 * composes it and compare. (2) Cover the window with another one, change the
 * interface, compose: the picture must show the change, the same as without
 * the cover. A capture is written to disk only when it matches, and the
 * difference picture is drawn from the composed side.
 */
async function check(ctx, pages) {
  const window = ctx.window;
  const dir = path.join(WORK, 'check');
  fs.mkdirSync(dir, { recursive: true });
  const regions = pages.map(({ bounds, url }) => ({ ...bounds, name: new URL(url).hostname }));
  const report = (label, result) => {
    if (!result) return console.log(`check ${label}: no picture of the same size to compare`);
    console.log(`check ${label}: ${(result.share * 100).toFixed(2)}% of pixels differ clearly`);
    for (const r of result.regions) console.log(`    ${r.name.padEnd(22)} ${(r.share * 100).toFixed(2)}%`);
  };

  const { image: composed } = await compose(window);
  const whole = await fromSystem(window).catch((error) => {
    console.log(`check: the system's capture of the window failed: ${error.message}`);
    return null;
  });
  const seen = whole && findInside(whole, composed);
  fs.writeFileSync(path.join(dir, 'composed.png'), composed.toPNG());
  // Pixel by pixel, and per 2 x 2 block: the capture is a video frame, which keeps
  // colour once per 2 x 2 pixels, so sharp coloured edges differ pixel by pixel.
  const exact = seen && difference(composed, seen, regions);
  const system = seen && difference(composed, seen, regions, 2);
  if (system && system.share < 0.1) fs.writeFileSync(path.join(dir, 'system-vs-composed.png'), system.image.toPNG());
  if (system && system.share < 0.01) fs.writeFileSync(path.join(dir, 'system.png'), seen.toPNG());
  else if (system) console.log('check: the capture does not match closely, so it is not kept');
  const size = whole ? `${whole.getSize().width}x${whole.getSize().height}` : 'none';
  report(`the system's capture of the window (${size}) vs composed, pixel by pixel`, exact);
  report('the same, per 2 x 2 block', system);

  const cover = new BrowserWindow({
    ...window.getBounds(),
    frame: false,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#7f7f7f',
  });
  cover.showInactive();
  await wait(3000);
  // Chromium's own word that the window is covered: allowed to throttle for a
  // moment, the interface reports itself hidden.
  const ui = window.webContents;
  ui.setBackgroundThrottling(true);
  await wait(1500);
  const seenAs = await ui.executeJavaScript('document.visibilityState');
  ui.setBackgroundThrottling(false);
  await wait(1500);
  console.log(`check while covered: the interface reports itself "${seenAs}" when allowed to`);
  // Change what the interface shows while it is covered (the preview to Source and
  // back afterwards): the picture taken under the cover must show the change.
  const source = `document.querySelector('#preview:not([hidden]) [data-act="source"]')?.click()`;
  await ui.executeJavaScript(source);
  await wait(1500);
  const { image: covered } = await compose(window);
  cover.destroy();
  await wait(1500);
  const { image: uncovered } = await compose(window);
  await ui.executeJavaScript(source);
  fs.writeFileSync(path.join(dir, 'covered.png'), covered.toPNG());
  const under = difference(uncovered, covered, regions);
  if (under) fs.writeFileSync(path.join(dir, 'covered-vs-uncovered.png'), under.image.toPNG());
  report('changed while covered, composed under the cover vs after it', under);
  const change = difference(composed, uncovered);
  console.log(`check the change itself: ${((change?.share ?? 0) * 100).toFixed(2)}% of pixels (must not be 0)`);
}

let context = null;
if (FOLDERS_ONLY) {
  // The app is not started, so Electron's own exit is safe here.
  app.setPath('userData', process.env.FANOUT_USER_DATA);
  app.whenReady()
    .then(makeFolders)
    .then(() => console.log(`sample folders in ${FOLDERS}`), (error) => { console.error(error); process.exitCode = 1; })
    .finally(() => app.exit(process.exitCode ?? 0));
} else import('../src/main/main.js')
  .then(({ ready }) => ready)
  .then(async (ctx) => {
    if (!ctx) throw new Error('fanout did not start (is another copy using this profile?)');
    context = ctx;
    await run(ctx);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // The app's own way out (docs/gotchas.md): closing the window saves and ends the process.
    if (context && !context.window.isDestroyed()) context.window.close();
    else setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);
  });
