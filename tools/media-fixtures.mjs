// Real media files for the tests, made on the spot: by the browser engine
// itself (MediaRecorder, WebCodecs, canvas) in a hidden window, or written
// byte by byte here. Nothing is downloaded and nothing large is committed.
//
// Everything made is silent: recordings take their sound from a source turned
// all the way down that is never connected to a speaker, the hidden window is
// muted, and the hand-written sound files hold silence.

import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A hidden window that makes media. It is a file:// page because WebCodecs
 * exists only on secure pages (about:blank has no VideoEncoder).
 */
export async function workshop(dir) {
  const page = path.join(dir, 'workshop.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>media workshop</title>');
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadFile(page);
  return win;
}

const bytesOf = (data) => Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);

/** Whether the engine can record this type (MediaRecorder.isTypeSupported). */
export const canRecord = (win, type) =>
  win.webContents.executeJavaScript(`MediaRecorder.isTypeSupported(${JSON.stringify(type)})`);

/**
 * A recording made with MediaRecorder, in real time: a drawn picture (a
 * coloured card with a running count) and, for types that carry sound, a
 * silent sound track.
 */
export async function record(win, type, { width = 320, height = 568, seconds = 2 } = {}) {
  const data = await win.webContents.executeJavaScript(`(async () => {
    const type = ${JSON.stringify(type)};
    const sound = type.startsWith('audio/') || /mp4a|opus|vorbis/.test(type);
    const tracks = [];
    let timer = null;
    if (!type.startsWith('audio/')) {
      const canvas = document.createElement('canvas');
      canvas.width = ${width};
      canvas.height = ${height};
      const g = canvas.getContext('2d');
      let n = 0;
      const draw = () => {
        g.fillStyle = ['#fb5f89', '#f7d31c', '#ede4d3'][Math.floor(n / 15) % 3];
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#070705';
        g.font = 'bold ' + Math.round(canvas.width / 7) + 'px sans-serif';
        g.fillText('fanout', canvas.width * 0.1, canvas.height * 0.42);
        g.fillText((n / 30).toFixed(1) + ' s', canvas.width * 0.1, canvas.height * 0.58);
        n += 1;
      };
      draw();
      timer = setInterval(draw, 33);
      tracks.push(...canvas.captureStream(30).getVideoTracks());
    }
    let context = null;
    if (sound) {
      context = new AudioContext();
      const tone = context.createOscillator();
      const silence = context.createGain();
      silence.gain.value = 0; // a real sound track holding silence
      const out = context.createMediaStreamDestination(); // never connected to a speaker
      tone.connect(silence).connect(out);
      tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 4_000_000 });
    const parts = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, ${Math.round(seconds * 1000)}));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    tracks.forEach((track) => track.stop());
    await context?.close();
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  })()`);
  return bytesOf(data);
}

/** A picture drawn on a canvas and encoded by the engine ('image/png', 'image/jpeg', 'image/webp'). */
export async function picture(win, type, { width, height, label = `${width} × ${height}` }) {
  const data = await win.webContents.executeJavaScript(`(async () => {
    const canvas = new OffscreenCanvas(${width}, ${height});
    const g = canvas.getContext('2d');
    const fill = g.createLinearGradient(0, 0, ${width}, ${height});
    fill.addColorStop(0, '#fb5f89');
    fill.addColorStop(1, '#f7d31c');
    g.fillStyle = fill;
    g.fillRect(0, 0, ${width}, ${height});
    g.fillStyle = '#070705';
    g.font = 'bold ' + Math.round(${width} / 9) + 'px sans-serif';
    g.fillText(${JSON.stringify(label)}, ${width} * 0.08, ${height} * 0.55);
    const blob = await canvas.convertToBlob({ type: ${JSON.stringify(type)}, quality: 0.85 });
    if (blob.type !== ${JSON.stringify(type)}) throw new Error('the engine cannot write ' + ${JSON.stringify(type)});
    return new Uint8Array(await blob.arrayBuffer());
  })()`);
  return bytesOf(data);
}

/**
 * A VP8 WebM, encoded with WebCodecs (faster than real time) and written by
 * webm() below with its length and an index, so a player can seek in it with
 * one range request. The lower half of every frame is noise, so the file is
 * about `bitrate` / 8 bytes per second: big enough to show that seeking does
 * not read the whole file.
 */
export async function encodeWebm(win, { width, height, fps, seconds, bitrate }) {
  const frames = await win.webContents.executeJavaScript(`(async () => {
    const W = ${width}, H = ${height}, FPS = ${fps}, N = ${fps * seconds};
    const frames = [];
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        frames.push({ key: chunk.type === 'key', ms: Math.round(chunk.timestamp / 1000), data });
      },
      error: (e) => { throw e; },
    });
    encoder.configure({ codec: 'vp8', width: W, height: H, bitrate: ${bitrate}, framerate: FPS });
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    const noise = g.createImageData(W, H >> 1);
    const px = new Uint32Array(noise.data.buffer);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < px.length; j++) px[j] = (Math.random() * 0xffffff) | 0xff000000;
      g.putImageData(noise, 0, H >> 1);
      g.fillStyle = 'hsl(' + ((i * 7) % 360) + ' 70% 60%)';
      g.fillRect(0, 0, W, H >> 1);
      g.fillStyle = '#070705';
      g.font = 'bold ' + (H >> 3) + 'px sans-serif';
      g.fillText('long take  ' + (i / FPS).toFixed(1) + ' s', W >> 4, H >> 2);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % FPS === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 4) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
    }
    await encoder.flush();
    encoder.close();
    return frames;
  })()`);
  return webm({ width, height, fps, frames });
}

/** Silent AAC in ADTS frames (a raw .aac file), from WebCodecs; null when the engine cannot encode AAC. */
export async function aacAdts(win, { seconds = 2 } = {}) {
  const data = await win.webContents.executeJavaScript(`(async () => {
    const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000, aac: { format: 'adts' } };
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return null;
    const parts = [];
    const encoder = new AudioEncoder({ output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); parts.push(b); }, error: (e) => { throw e; } });
    encoder.configure(config);
    for (let i = 0; i < Math.ceil(${seconds} * 48000 / 1024); i++) {
      encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 1024, numberOfChannels: 1,
        timestamp: Math.round(i * 1024 * 1e6 / 48000), data: new Float32Array(1024) }));
    }
    await encoder.flush();
    encoder.close();
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  })()`);
  return data ? bytesOf(data) : null;
}

// ------------------------------------------------------------ by hand

/** Silent 16-bit mono PCM in a RIFF WAVE file. */
export function wav({ seconds = 2, rate = 44100 } = {}) {
  const length = Math.round(seconds * rate) * 2;
  const b = Buffer.alloc(44 + length);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + length, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(length, 40);
  return b;
}

/**
 * Silent MP3: MPEG-1 Layer III frames, 128 kbit/s, 44.1 kHz, mono, whose
 * side information is all zero (no audio data: silence). 417 bytes each.
 */
export function mp3({ seconds = 2 } = {}) {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0xc0]);
  return Buffer.concat(Array.from({ length: Math.ceil(seconds * 44100 / 1152) }, () => frame));
}

/** Silent FLAC: 16-bit mono at 44.1 kHz, every block one CONSTANT subframe of 0. */
export function flac({ seconds = 2, rate = 44100 } = {}) {
  const block = 4096;
  const total = Math.round(seconds * rate);
  const crc8 = (bytes) => bytes.reduce((c, byte) => {
    let v = c ^ byte;
    for (let i = 0; i < 8; i++) v = v & 0x80 ? ((v << 1) ^ 0x07) & 0xff : (v << 1) & 0xff;
    return v;
  }, 0);
  const crc16 = (bytes) => bytes.reduce((c, byte) => {
    let v = c ^ (byte << 8);
    for (let i = 0; i < 8; i++) v = v & 0x8000 ? ((v << 1) ^ 0x8005) & 0xffff : (v << 1) & 0xffff;
    return v;
  }, 0);
  const info = Buffer.alloc(34); // STREAMINFO; frame sizes and MD5 left as "unknown" (0)
  info.writeUInt16BE(block, 0);
  info.writeUInt16BE(block, 2);
  info.writeBigUInt64BE((BigInt(rate) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(total), 10);
  const parts = [Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info];
  for (let n = 0; n * block < total; n++) {
    const size = Math.min(block, total - n * block);
    const short = size !== block;
    // Block size 4096 (code 12), or "16 bits at the end of the header" (7); 44.1 kHz (9); mono, 16 bits (0x08).
    const head = [0xff, 0xf8, ((short ? 7 : 12) << 4) | 9, 0x08, ...(n < 128 ? [n] : [0xc0 | (n >> 6), 0x80 | (n & 0x3f)])];
    if (short) head.push((size - 1) >> 8, (size - 1) & 0xff);
    head.push(crc8(head));
    const frame = [...head, 0x00, 0x00, 0x00]; // CONSTANT subframe, value 0
    const crc = crc16(frame);
    parts.push(Buffer.from([...frame, crc >> 8, crc & 0xff]));
  }
  return Buffer.concat(parts);
}

/** A 24-bit BMP, one colour. */
export function bmp(width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * height);
  b.write('BM', 0);
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) b.set([0x89, 0x5f, 0xfb], 54 + y * row + x * 3); // pink, as blue-green-red
  }
  return b;
}

/** The classic smallest GIF: 1 × 1. */
export function gif() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
}

/** An uncompressed RGB TIFF, one colour (Chromium does not decode TIFF; this proves the message). */
export function tiff(width, height) {
  const entries = [
    [256, 3, 1, width], [257, 3, 1, height], [258, 3, 3, 0], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, 0], [277, 3, 1, 3], [278, 3, 1, height], [279, 4, 1, width * height * 3],
  ];
  const ifd = 8;
  const bits = ifd + 2 + entries.length * 12 + 4; // the three 8s of BitsPerSample
  const pixels = bits + 6;
  entries[2][3] = bits;
  entries[5][3] = pixels;
  const b = Buffer.alloc(pixels + width * height * 3);
  b.write('II', 0);
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(ifd, 4);
  b.writeUInt16LE(entries.length, ifd);
  entries.forEach(([tag, type, count, value], i) => {
    const at = ifd + 2 + i * 12;
    b.writeUInt16LE(tag, at);
    b.writeUInt16LE(type, at + 2);
    b.writeUInt32LE(count, at + 4);
    if (type === 3 && count === 1) b.writeUInt16LE(value, at + 8);
    else b.writeUInt32LE(value, at + 8);
  });
  b.writeUInt16LE(8, bits);
  b.writeUInt16LE(8, bits + 2);
  b.writeUInt16LE(8, bits + 4);
  for (let i = 0; i < width * height; i++) b.set([0xfb, 0x5f, 0x89], pixels + i * 3);
  return b;
}

// --------------------------------------------------------------- WebM

const ebmlId = (n) => {
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return Buffer.from(out);
};
const ebmlSize = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(0x0100000000000000n | BigInt(n)); // always 8 bytes: sizes are known before positions
  return b;
};
const el = (id, ...parts) => {
  const data = Buffer.concat(parts);
  return Buffer.concat([ebmlId(id), ebmlSize(data.length), data]);
};
const uint = (id, value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return el(id, b);
};
const float = (id, value) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value);
  return el(id, b);
};
const text = (id, value) => el(id, Buffer.from(value, 'ascii'));

/**
 * A WebM file of VP8 frames ({ key, ms, data } in order), with its length
 * and a Cues index before the clusters (one cluster per key frame).
 */
export function webm({ width, height, fps, frames }) {
  const header = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8),
    text(0x4282, 'webm'), uint(0x4287, 2), uint(0x4285, 2));
  const clusters = [];
  for (const frame of frames) {
    if (frame.key || !clusters.length) clusters.push({ ms: frame.ms, blocks: [] });
    const cluster = clusters.at(-1);
    const head = Buffer.alloc(4);
    head[0] = 0x81; // track 1
    head.writeInt16BE(frame.ms - cluster.ms, 1);
    head[3] = frame.key ? 0x80 : 0;
    cluster.blocks.push(el(0xa3, head, bytesOf(frame.data)));
  }
  const clusterBytes = clusters.map((c) => el(0x1f43b675, uint(0xe7, c.ms), ...c.blocks));
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), text(0x4d80, 'fanout test'), text(0x5741, 'fanout test'),
    float(0x4489, frames.at(-1).ms + 1000 / fps));
  const tracks = el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), text(0x86, 'V_VP8'), uint(0x9c, 0),
    el(0xe0, uint(0xb0, width), uint(0xba, height))));
  const seek = (id, at) => el(0x4dbb, el(0x53ab, ebmlId(id)), uint(0x53ac, at));
  const seekHead = (a, b, c) => el(0x114d9b74, seek(0x1549a966, a), seek(0x1654ae6b, b), seek(0x1c53bb6b, c));
  const cues = (at) => el(0x1c53bb6b, ...clusters.map((c, i) => el(0xbb, uint(0xb3, c.ms), el(0xb7, uint(0xf7, 1), uint(0xf1, at[i])))));
  const atInfo = seekHead(0, 0, 0).length;
  const atTracks = atInfo + info.length;
  const atCues = atTracks + tracks.length;
  let at = atCues + cues(clusters.map(() => 0)).length;
  const positions = clusterBytes.map((bytes) => {
    const here = at;
    at += bytes.length;
    return here;
  });
  return Buffer.concat([header, el(0x18538067, seekHead(atInfo, atTracks, atCues), info, tracks, cues(positions), ...clusterBytes)]);
}
