// Build a release, try its update feed locally, publish it.
//
//   node tools/release.mjs build            installer + update feed for this system, in dist/
//   node tools/release.mjs serve [port]     serve dist/ as an update feed (default 8799), to test with
//                                           FANOUT_UPDATE_URL=http://127.0.0.1:8799/
//   node tools/release.mjs publish --yes    upload dist/ to thedumbstuff.page and make it current
//
// The version is package.json's. Its notes are that version's section of
// docs/changelog.md; they travel in the feed and are shown after the update.
//
// Publishing needs the site's upload token: DOWNLOADS_UPLOAD_TOKEN in the
// environment, or the one line of ~/.tauri/contextwire-downloads.token (the
// site has one token for all its downloads). It is never printed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SITE = process.env.FANOUT_SITE ?? 'https://thedumbstuff.page';
const MAX_UPLOAD = 100 * 1024 * 1024; // Cloudflare refuses a larger request
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

/** What a release consists of: the feed files and every file they name. */
function releaseFiles() {
  const feeds = fs.readdirSync(DIST).filter((name) => /^latest.*\.yml$/.test(name));
  const files = new Set(feeds);
  for (const feed of feeds) {
    const text = fs.readFileSync(path.join(DIST, feed), 'utf8');
    if (!text.includes(`version: ${version}`)) fail(`dist/${feed} is not version ${version}: build first`);
    for (const [, name] of text.matchAll(/^\s*(?:- )?url: (.+)$/gm)) {
      files.add(name.trim());
      if (fs.existsSync(path.join(DIST, `${name.trim()}.blockmap`))) files.add(`${name.trim()}.blockmap`);
    }
  }
  if (!feeds.length) fail('no update feed (latest*.yml) in dist/: build first');
  return [...files];
}

function fail(message) {
  console.error(message);
  process.exit(1);
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
  for (const name of releaseFiles()) {
    const { size } = fs.statSync(path.join(DIST, name));
    const tooBig = size > MAX_UPLOAD ? '   <- over 100 MB: the site cannot take it in one upload' : '';
    console.log(`  dist/${name}  ${(size / 1048576).toFixed(1)} MB${tooBig}`);
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

async function call(method, url, secret, body, type = 'application/octet-stream') {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': type, 'user-agent': `fanout-release/${version}` },
    body,
    signal: AbortSignal.timeout(600_000),
  });
  const text = await response.text();
  if (!response.ok) fail(`${method} ${url.split('/api/')[1]} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function publish(really) {
  const files = releaseFiles();
  const sizes = files.map((name) => fs.statSync(path.join(DIST, name)).size);
  console.log(`fanout ${version} -> ${SITE}`);
  files.forEach((name, i) => console.log(`  ${name}  ${(sizes[i] / 1048576).toFixed(1)} MB`));
  const tooBig = files.filter((_, i) => sizes[i] > MAX_UPLOAD);
  if (tooBig.length) fail(`over 100 MB, which the site cannot take in one upload: ${tooBig.join(', ')}`);
  if (!really) return console.log('\nNothing was uploaded. Add --yes to publish.');

  const secret = token();
  const api = `${SITE}/api/downloads/fanout/${version}`;
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(DIST, name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const answer = await call('PUT', `${api}/${encodeURIComponent(name)}`, secret, bytes);
    console.log(`  uploaded ${name}  sha256 ${sha256.slice(0, 12)}…${answer.skipped ? ' (already there)' : ''}`);
  }
  const notes = fs.readFileSync(path.join(ROOT, 'build', 'release-notes.md'), 'utf8');
  const done = await call('POST', `${api}/publish`, secret, JSON.stringify({ notes }), 'application/json');
  console.log(`published: ${done.feed ?? `${SITE}/downloads/fanout/current/`}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'build') build();
  else if (command === 'serve') serve(Number(argument) || 8799);
  else if (command === 'publish') await publish(process.argv.includes('--yes'));
  else fail('usage: node tools/release.mjs build | serve [port] | publish [--yes]');
}
