// Which media formats the viewer shows on this machine, found out rather
// than assumed:  node node_modules/electron/cli.js tools/media-formats.mjs
//
// Makes one real file of every format it can (tools/media-fixtures.mjs: the
// engine's own recorder and encoders, or bytes written by hand), puts them in
// a throwaway brand folder, clicks each in the real file panel and reports
// what the viewer did: shown with its facts (and, for video and sound, played
// for a moment, muted), or "cannot be ..." with the default-app action.
// Formats nothing here can write are listed with what the engine claims.
// Opens a window; nothing is heard. Re-run after upgrading Electron and
// update the list in docs/architecture.md.

import '../src/main/mediaprotocol.js'; // before the app is ready
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { aacAdts, bmp, canRecord, encodeWebm, flac, gif, mp3, picture, record, tiff, wav, workshop } from './media-fixtures.mjs';

const WORK = path.join(import.meta.dirname, '..', '.smoke', 'formats');
const FOLDER = path.join(WORK, 'folder');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });
process.env.FANOUT_USER_DATA = path.join(WORK, 'profile');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// [file name, recorder type, what it is]
const RECORDED = [
  ['h264.mp4', 'video/mp4;codecs=avc1.42E01E', 'MP4, H.264'],
  ['h264 aac.mp4', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'MP4, H.264 + AAC sound'],
  ['hevc.mp4', 'video/mp4;codecs=hvc1.1.6.L93.B0', 'MP4, HEVC (H.265), as phones record'],
  ['av1.mp4', 'video/mp4;codecs=av01.0.04M.08', 'MP4, AV1'],
  ['vp9.webm', 'video/webm;codecs=vp9', 'WebM, VP9'],
  ['av1.webm', 'video/webm;codecs=av1', 'WebM, AV1'],
  ['h264.mkv', 'video/x-matroska;codecs=avc1', 'MKV, H.264'],
  ['aac.m4a', 'audio/mp4;codecs=mp4a.40.2', 'M4A, AAC'],
];
// The same bytes under another name: what the extension (and the type served for it) changes.
const RENAMED = [
  ['h264.mov', 'h264.mp4', 'MOV name, H.264 (served as video/quicktime)'],
  ['h264.m4v', 'h264.mp4', 'M4V name, H.264'],
  ['hevc.mov', 'hevc.mp4', 'MOV name, HEVC (an iPhone video)'],
  ['h264.3gp', 'h264.mp4', '3GP name, H.264 (real 3GP files usually hold H.263/AMR)'],
];
const UNTESTED = [
  ['video/x-msvideo', 'AVI'], ['video/x-ms-wmv', 'WMV'], ['video/mpeg', 'MPG / MPEG'], ['video/3gpp; codecs="s263, samr"', '3GP with H.263 + AMR'],
  ['audio/ogg; codecs="opus"', 'Ogg Opus (.ogg, .opus)'], ['audio/ogg; codecs="vorbis"', 'Ogg Vorbis'],
];

async function makeFiles() {
  const shop = await workshop(WORK);
  const made = [];
  const put = (name, bytes, what) => {
    fs.writeFileSync(path.join(FOLDER, name), bytes);
    made.push([name, what]);
  };
  for (const [name, type, what] of RECORDED) {
    if (await canRecord(shop, type)) put(name, await record(shop, type, { seconds: 1.5 }), what);
    else console.log(`(this machine cannot record ${what}; not tested)`);
  }
  for (const [name, from, what] of RENAMED) {
    if (fs.existsSync(path.join(FOLDER, from))) put(name, fs.readFileSync(path.join(FOLDER, from)), what);
  }
  put('vp8.webm', await encodeWebm(shop, { width: 320, height: 180, fps: 10, seconds: 2, bitrate: 500_000 }), 'WebM, VP8, with an index');
  const adts = await aacAdts(shop);
  if (adts) put('adts.aac', adts, 'AAC, raw ADTS');
  else console.log('(this machine cannot encode AAC with WebCodecs, so raw .aac is not tested)');
  put('silence.mp3', mp3(), 'MP3');
  put('silence.wav', wav(), 'WAV, PCM');
  put('silence.flac', flac(), 'FLAC');
  put('picture.jpg', await picture(shop, 'image/jpeg', { width: 1080, height: 1350 }), 'JPEG');
  put('picture.png', await picture(shop, 'image/png', { width: 1080, height: 1080 }), 'PNG');
  put('picture.webp', await picture(shop, 'image/webp', { width: 1200, height: 628 }), 'WebP');
  put('tiny.gif', gif(), 'GIF');
  put('picture.bmp', bmp(64, 48), 'BMP');
  put('picture.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fb5f89"/></svg>', 'SVG');
  put('picture.tif', tiff(64, 48), 'TIFF, uncompressed');
  shop.destroy();
  return made;
}

async function run(ctx) {
  const ui = ctx.window.webContents;
  ui.setAudioMuted(true);
  ctx.window.show();
  await wait(600);
  const made = await makeFiles();
  await ui.executeJavaScript(`window.fanout.createBrand(${JSON.stringify({ name: 'Formats', color: '#2f6fed', folder: FOLDER, urls: [] })})`);
  const dom = (code) => ui.executeJavaScript(code, true);
  for (let i = 0; i < 100 && !(await dom(`document.querySelectorAll('#tree .row').length >= ${made.length}`)); i++) await wait(100);

  const rows = [];
  for (const [name, what] of made) {
    await dom(`document.querySelector('#tree [data-name="${name}"]').click()`);
    let state = null;
    for (let i = 0; i < 100; i++) {
      state = await dom(`(() => { const p = document.getElementById('preview');
        return p.querySelector('.preview-name')?.textContent === ${JSON.stringify(name)} ? p.dataset.ready ?? null : null; })()`);
      if (state) break;
      await wait(100);
    }
    let result;
    if (state === '1') {
      // Shown. For video and sound, play a moment (muted) to see that it really decodes.
      const played = await dom(`(async () => {
        const m = document.querySelector('#preview video, #preview audio');
        if (!m) return '';
        m.muted = true;
        await m.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 700));
        const ok = m.currentTime > 0.2 && (m.tagName === 'AUDIO' || m.webkitDecodedFrameCount > 0);
        m.pause();
        return ok ? ', played' : ', DID NOT PLAY';
      })()`);
      result = `shown: ${await dom(`document.querySelector('#preview .media-facts').textContent`)}${played}`;
    } else if (state === 'failed') {
      result = `not shown: "${await dom(`document.querySelector('#preview .media-problem-title').textContent`)}" + "${await dom(`document.querySelector('#preview [data-act="open"]').textContent`)}"`;
    } else {
      result = 'NO ANSWER (a viewer left waiting: a bug)';
    }
    rows.push([what, name, result]);
  }
  await dom(`document.querySelector('#preview [data-act="close"]')?.click()`);

  console.log(`\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform} ${process.getSystemVersion()}\n`);
  for (const [what, name, result] of rows) console.log(`${what.padEnd(58)} ${name.padEnd(14)} ${result}`);
  console.log('\nNot tested with a file (nothing here can write one); what the engine says it plays:');
  for (const [type, what] of UNTESTED) {
    const answer = await dom(`document.createElement('video').canPlayType(${JSON.stringify(type)})`);
    console.log(`${what.padEnd(58)} ${answer || 'no'}`);
  }
  console.log(`${'AVIF and HEIC pictures'.padEnd(58)} (no engine answer for pictures; nothing here writes them)`);
  console.log(`open media streams at the end: ${ctx.media.openStreams}`);
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
