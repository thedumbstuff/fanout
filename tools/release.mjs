// Build a release, try its update feed locally, publish it.
//
//   node tools/release.mjs build            installer + update feed for this system, in dist/
//   node tools/release.mjs serve [port]     serve dist/ as an update feed (default 8799), to test with
//                                           FANOUT_UPDATE_URL=http://127.0.0.1:8799/
//   node tools/release.mjs publish          shows what would be uploaded, and where
//   node tools/release.mjs publish --yes    uploads it to thedumbstuff.page and makes it current
//
// The version is package.json's. Its notes are that version's section of
// docs/changelog.md; they travel in the feed and are shown after the update.
//
// Publishing goes to FANOUT_SITE (default https://thedumbstuff.page) and needs the
// site's upload token: DOWNLOADS_UPLOAD_TOKEN in the environment, or the one line
// of ~/.tauri/contextwire-downloads.token (the site has one token for all its
// downloads). It is never printed. Every file goes up in parts of 16 MB (the site
// sits behind Cloudflare, which refuses a request over 100 MB); the site puts them
// together and checks the whole before it counts. A run that was cut off is simply
// run again: the site says which parts it has, and a file it has whole is skipped.
// The feed (latest.yml) is not uploaded: the site writes its own from the files it
// holds (thedumbstuff-site docs/installer.md).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SITE = (process.env.FANOUT_SITE ?? 'https://thedumbstuff.page').replace(/\/+$/, '');
export const PART_SIZE = 16 * 1024 * 1024; // one request each, well under Cloudflare's 100 MB
const TRIES = 4; // a part that fails on the way (a dropped connection, a busy site) is sent again
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** The changelog section for a version, without its heading ('' if there is none). */
export function notesFor(changelog, wanted) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+v?${wanted.replaceAll('.', '\\.')}(\\s|$)`).test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  // The changelog is wrapped at a fixed width; the notes are shown in a box of another.
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim().replace(/\n {2,}(?=\S)/g, ' ');
}

/**
 * What a release uploads: every installer the build's feeds name, with its .blockmap when
 * there is one; not the feeds themselves. `feeds` is [{ name, text }], `exists(name)` says
 * whether dist/ has a file. Throws if a feed is of another version.
 */
export function uploadsOf(feeds, wanted, exists) {
  if (!feeds.length) throw new Error('no update feed (latest*.yml) in dist/: build first');
  const files = [];
  for (const { name, text } of feeds) {
    if (!new RegExp(`^version: ['"]?${wanted.replaceAll('.', '\\.')}['"]?\\s*$`, 'm').test(text)) {
      throw new Error(`dist/${name} is not version ${wanted}: build first`);
    }
    for (const [, url] of text.matchAll(/^\s*(?:- )?url: (.+)$/gm)) {
      const file = url.trim().replace(/^['"]|['"]$/g, '');
      for (const one of [file, `${file}.blockmap`]) {
        if ((one === file || exists(one)) && !files.includes(one)) files.push(one);
      }
    }
  }
  return files;
}

/** How a file of `size` bytes is cut into parts: [{ n, start, length }]. */
export function partsOf(size, partSize = PART_SIZE) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`not a file size: ${size}`);
  const parts = [];
  for (let n = 0, start = 0; start < size; n += 1, start += partSize) {
    parts.push({ n, start, length: Math.min(partSize, size - start) });
  }
  return parts;
}

/** The parts still to send, from the site's answer to the announcement ({ same } or { have }). */
export function stillToSend(parts, answer) {
  if (answer?.same) return [];
  const have = new Set(Array.isArray(answer?.have) ? answer.have : []);
  return parts.filter((part) => !have.has(part.n));
}

/** Whether a failed request is worth sending again: no answer at all, or the site was busy. */
export function worthRetrying(status) {
  return status === null || status === 429 || status === 502 || status === 503 || status === 504;
}

/** The SHA-256 of the whole file and of each part, read once. */
function digestsOf(file, parts) {
  const whole = createHash('sha256');
  const each = [];
  const fd = fs.openSync(file, 'r');
  try {
    for (const part of parts) {
      const bytes = readPart(fd, part);
      whole.update(bytes);
      each.push(createHash('sha256').update(bytes).digest('hex'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { whole: whole.digest('hex'), each };
}

function readPart(fd, part) {
  const bytes = Buffer.alloc(part.length);
  let got = 0;
  while (got < part.length) {
    const read = fs.readSync(fd, bytes, got, part.length - got, part.start + got);
    if (read === 0) throw new Error('the file got shorter while it was read');
    got += read;
  }
  return bytes;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function feedsInDist() {
  return fs.readdirSync(DIST).filter((name) => /^latest.*\.yml$/.test(name))
    .map((name) => ({ name, text: fs.readFileSync(path.join(DIST, name), 'utf8') }));
}

/** What a release consists of: every file the feeds name (and its blockmap), not the feeds. */
function releaseFiles() {
  try {
    return uploadsOf(feedsInDist(), version, (name) => fs.existsSync(path.join(DIST, name)));
  } catch (error) {
    return fail(error.message);
  }
}

function build() {
  const notes = notesFor(fs.readFileSync(path.join(ROOT, 'docs', 'changelog.md'), 'utf8'), version);
  if (!notes) fail(`docs/changelog.md has no "## ${version}" section: write what changed first`);
  // electron-builder puts build/release-notes.md into the feed.
  fs.writeFileSync(path.join(ROOT, 'build', 'release-notes.md'), `${notes}\n`);

  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const run = spawnSync(process.execPath, [cli, '--publish', 'never'], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) fail('the build failed');

  console.log(`\nfanout ${version}:`);
  for (const name of [...feedsInDist().map((feed) => feed.name), ...releaseFiles()]) {
    const { size } = fs.statSync(path.join(DIST, name));
    const parts = partsOf(size).length;
    console.log(`  dist/${name}  ${(size / 1048576).toFixed(1)} MB${parts > 1 ? `  (uploaded in ${parts} parts)` : ''}`);
  }
}

function serve(port) {
  http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(DIST, name);
    if (name.includes('..') || path.dirname(file) !== DIST || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return console.log(`404 ${req.method} /${name}`);
    }
    const { size } = fs.statSync(file);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      // The updater fetches only the changed parts of an installer.
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    }
    console.log(`${range ? 206 : 200} ${req.method} /${name}${range ? ` ${range[0]}` : ''}`);
  }).listen(port, '127.0.0.1', () => console.log(`update feed: http://127.0.0.1:${port}/  (fanout ${version}, from dist/)`));
}

function token() {
  if (process.env.DOWNLOADS_UPLOAD_TOKEN) return process.env.DOWNLOADS_UPLOAD_TOKEN.trim();
  const file = path.join(os.homedir(), '.tauri', 'contextwire-downloads.token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return fail(`the upload token is missing: set DOWNLOADS_UPLOAD_TOKEN or put it in ${file}`);
}

/** One request to the site's downloads service; sent again (up to TRIES) when nothing or "busy" came back. */
async function call(method, url, secret, body, type = 'application/octet-stream') {
  const where = `${method} ${url.split('/api/downloads/')[1] ?? url}`;
  for (let attempt = 1; ; attempt += 1) {
    let status = null;
    let text = '';
    try {
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${secret}`, 'content-type': type, 'user-agent': `fanout-release/${version}` },
        body,
        signal: AbortSignal.timeout(600_000),
      });
      status = response.status;
      text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : {};
    } catch (error) {
      text = String(error?.cause?.message ?? error?.message ?? error);
    }
    if (!worthRetrying(status) || attempt >= TRIES) {
      let said = text.slice(0, 300);
      try {
        said = JSON.parse(text).message ?? said;
      } catch {
        if (/cloudflare/i.test(text)) said = 'Cloudflare refused the request before it reached the site (a bot or WAF rule); see thedumbstuff-site docs/installer.md';
      }
      return fail(`${where} -> ${status ?? 'no answer'}: ${said}${status === null ? '\nRun publish --yes again: what reached the site is kept.' : ''}`);
    }
    const wait = attempt * 5;
    console.log(`  ${where} -> ${status ?? 'no answer'}; again in ${wait} s (try ${attempt + 1} of ${TRIES})`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

/** Upload one file in parts: announce it, send the parts the site lacks, let it put them together. */
async function upload(api, secret, name) {
  const file = path.join(DIST, name);
  const size = fs.statSync(file).size;
  const parts = partsOf(size);
  const { whole, each } = digestsOf(file, parts);
  const address = `${api}/${encodeURIComponent(name)}/parts`;
  const announced = await call('POST', address, secret,
    JSON.stringify({ size, sha256: whole, part_size: PART_SIZE, parts: each }), 'application/json');
  const todo = stillToSend(parts, announced);
  if (announced.same) {
    console.log(`  ${name}: already there (sha256 ${whole.slice(0, 12)}…)`);
    return;
  }
  if (todo.length < parts.length) console.log(`  ${name}: ${parts.length - todo.length} of ${parts.length} parts already there`);
  const fd = fs.openSync(file, 'r');
  try {
    for (const part of todo) {
      await call('PUT', `${address}/${part.n}`, secret, readPart(fd, part));
      console.log(`  ${name}: part ${part.n + 1} of ${parts.length} (${(part.length / 1048576).toFixed(1)} MB)`);
    }
  } finally {
    fs.closeSync(fd);
  }
  const done = await call('POST', `${address}/done`, secret, '', 'application/json');
  if (done.sha256 !== whole) fail(`${name}: the site put together something else (SHA-256 ${done.sha256}); nothing was published`);
  console.log(`  ${name}: uploaded, sha256 ${whole.slice(0, 12)}…`);
}

async function publish(really) {
  const files = releaseFiles();
  const notes = notesFor(fs.readFileSync(path.join(ROOT, 'docs', 'changelog.md'), 'utf8'), version);
  if (!notes) fail(`docs/changelog.md has no "## ${version}" section: the notes come from there`);
  console.log(`this uploads fanout ${version} to ${SITE} and makes it the current download:`);
  for (const name of files) {
    const { size } = fs.statSync(path.join(DIST, name));
    console.log(`  ${name}  ${(size / 1048576).toFixed(1)} MB, ${partsOf(size).length} part(s)`);
  }
  console.log(`then ${SITE}/downloads/fanout/current/latest.yml offers it to every installed fanout,`);
  console.log(`and ${SITE}/downloads/fanout/current/fanout-setup.exe is the download.`);
  if (!really) return console.log('\nNothing was uploaded. Add --yes to publish.');

  const secret = token();
  const api = `${SITE}/api/downloads/fanout/${version}`;
  for (const name of files) await upload(api, secret, name);
  const done = await call('POST', `${api}/publish`, secret, JSON.stringify({ notes }), 'application/json');
  console.log(`published ${done.version} for ${(done.systems ?? []).join(', ')}: ${done.feed ?? `${SITE}/downloads/fanout/current/latest.yml`}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'build') build();
  else if (command === 'serve') serve(Number(argument) || 8799);
  else if (command === 'publish') await publish(process.argv.includes('--yes'));
  else fail('usage: node tools/release.mjs build | serve [port] | publish [--yes]');
}
