// Markdown for the text preview: a file's text becomes a plain tree of
// objects, which preview.js turns into elements. Pure (no DOM, no HTML
// strings), so `npm test` covers it, and nothing in a file can become markup:
// raw HTML stays text, a picture keeps only its description, and only web
// addresses (http, https) are links that do anything.
//
// What it reads, as GitHub does: headings (# and underlined), paragraphs,
// bold, italic, strikethrough (~~), inline code, fenced and indented code,
// lists (nested, numbered, task boxes), block quotes, rules, links (inline,
// <autolinks>, bare web addresses, [references]), pictures, tables.
// One difference, on purpose: every line break inside a paragraph is kept,
// because the lines of a caption are part of the caption.
//
// The tree:
//   blocks   heading {level, children} | paragraph {children} | code {lang, text}
//            | quote {children} | list {ordered, start, tight, items: [{task, children}]}
//            | table {align, head: [cell], rows: [[cell]]} | hr
//            (task: null, or true/false for a ticked/empty box; a cell is a list of inlines)
//   inlines  text {text} | break | codespan {text} | strong/em/del {children}
//            | link {href, target, children} | image {alt, target}
//            (href is a checked http(s) address, or null when the link must stay inert)

const MAX_BLOCK_DEPTH = 16; // quotes and lists inside each other; deeper is plain text
const MAX_INLINE_DEPTH = 8; // pictures inside link text inside ...
const MAX_DELIMITER_RUN = 12; // a longer run of * or _ is plain text
const SCAN_LIMIT = 2048; // longest (address "title") after a link's text that is looked at

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK = /^\[([ xX])\][ \t]+(?=\S)/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*(?:<([^>\n]*)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const SPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
// Sticky (y): tried at one position of the text, without copying any of it.
const SCHEME_LINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/iy;
const BARE_URL = /https?:\/\/[^\s<]+/iy;

/** True for the files the preview shows formatted. */
export function isMarkdownFile(name) {
  return /\.(md|markdown)$/i.test(String(name));
}

/** A link's target as an address a tab may open (http or https), or null. */
export function webHref(target) {
  const text = String(target ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The text of inline nodes as a person reads it: no Markdown signs, pictures by their description. */
export function plainText(nodes) {
  let out = '';
  const stack = [...nodes].reverse(); // not recursive: nesting depth is up to the file
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'text' || node.type === 'codespan') out += node.text;
    else if (node.type === 'break') out += '\n';
    else if (node.type === 'image') out += node.alt;
    else if (node.children) for (let k = node.children.length - 1; k >= 0; k -= 1) stack.push(node.children[k]);
  }
  return out;
}

/** Parse a whole file. */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  const defs = new Map(); // [reference] -> address, filled while the blocks are read
  const blocks = readBlocks(lines, defs, 0);
  return { type: 'doc', children: blocks.map((block) => finish(block, defs)) };
}

// ------------------------------------------------------------------ blocks
//
// First pass: lines into blocks. Text that will hold inline formatting is kept
// raw until every [reference] definition in the file is known.

const blank = (line) => !line.trim();
const indentOf = (line) => /^ */.exec(line)[0].length;

/** Leading tabs as spaces (to the next multiple of four), so indents can be counted. */
function expandTabs(line) {
  const lead = /^[ \t]+/.exec(line)?.[0];
  if (!lead?.includes('\t')) return line;
  let width = 0;
  for (const ch of lead) width = ch === '\t' ? width + 4 - (width % 4) : width + 1;
  return ' '.repeat(width) + line.slice(lead.length);
}

function fenceOf(line) {
  const m = FENCE.exec(line);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return { indent: m[1].length, char: m[2][0], size: m[2].length, lang: m[3].trim().split(/\s+/)[0] };
}

function closesFence(line, fence) {
  const m = FENCE_CLOSE.exec(line);
  return Boolean(m) && m[1][0] === fence.char && m[1].length >= fence.size;
}

function listMarker(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const [, indent, marker, gap = '', rest = ''] = m;
  const ordered = /\d/.test(marker[0]);
  const empty = !rest.trim();
  // Five or more spaces after the marker make the item's text indented code,
  // which starts one space after the marker.
  const wide = !empty && gap.length >= 5;
  return {
    ordered,
    kind: ordered ? marker.at(-1) : marker,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    width: indent.length + marker.length + (empty || wide ? 1 : gap.length),
    first: empty ? '' : (wide ? ' '.repeat(gap.length - 1) : '') + rest,
    empty,
  };
}

/** Lines that end a paragraph without a blank line before them. */
function interrupts(line) {
  if (ATX.test(line) || RULE.test(line) || QUOTE.test(line) || fenceOf(line)) return true;
  const item = listMarker(line);
  return Boolean(item && !item.empty && (!item.ordered || item.start === 1));
}

/** Table cells of one row; a pipe written as \| stays in its cell. */
function splitCells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && i + 1 < row.length) {
      cell += row[i] + row[i + 1];
      i += 1;
    } else if (row[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** A table starts with a row of cells and a row of dashes with as many cells. */
function tableAt(lines, i) {
  const head = lines[i];
  const rule = lines[i + 1];
  if (rule === undefined || !head.includes('|') || !rule.includes('|') || !DELIMITER_ROW.test(rule)) return null;
  const cells = splitCells(head);
  const marks = splitCells(rule);
  if (cells.length !== marks.length) return null;
  const align = marks.map((m) => (m.startsWith(':') ? (m.endsWith(':') ? 'center' : 'left') : m.endsWith(':') ? 'right' : null));
  return { cells, align };
}

const labelKey = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
const unescape = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function readBlocks(lines, defs, depth) {
  if (depth > MAX_BLOCK_DEPTH) {
    const text = lines.map((line) => line.trim()).filter(Boolean).join('\n');
    return text ? [{ type: 'paragraph', raw: text }] : [];
  }
  const blocks = [];
  let gap = false; // a blank line came before the next block (for loose lists)
  const add = (block) => {
    block.gap = gap && blocks.length > 0;
    gap = false;
    blocks.push(block);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      gap = true;
      i += 1;
      continue;
    }

    const fence = fenceOf(line);
    if (fence) {
      const body = [];
      for (i += 1; i < lines.length && !closesFence(lines[i], fence); i += 1) {
        body.push(lines[i].slice(Math.min(fence.indent, indentOf(lines[i]))));
      }
      i += 1; // the closing fence, or past the end
      add({ type: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }

    if (indentOf(line) >= 4) {
      const body = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || blank(lines[i]))) body.push(lines[i++].slice(4));
      while (body.length && blank(body.at(-1))) body.pop();
      add({ type: 'code', lang: '', text: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      add({ type: 'hr' });
      i += 1;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const raw = (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
      add({ type: 'heading', level: atx[1].length, raw });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        const next = lines[i];
        if (QUOTE.test(next)) inner.push(next.replace(QUOTE, ''));
        // A line without ">" that just goes on with the quote's text belongs to it.
        else if (!blank(next) && inner.length && !blank(inner.at(-1)) && !interrupts(next)) inner.push(next);
        else break;
        i += 1;
      }
      add({ type: 'quote', children: readBlocks(inner, defs, depth + 1) });
      continue;
    }

    if (listMarker(line)) {
      i = readList(lines, i, defs, depth, add);
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      const rows = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && !interrupts(lines[i]); i += 1) {
        const cells = splitCells(lines[i]);
        rows.push(table.cells.map((_, c) => cells[c] ?? ''));
      }
      add({ type: 'table', align: table.align, head: table.cells, rows });
      continue;
    }

    const def = DEFINITION.exec(line);
    if (def) {
      const key = labelKey(def[1]);
      if (!defs.has(key)) defs.set(key, unescape(def[2] ?? def[3]));
      i += 1;
      continue;
    }

    // A paragraph, or a heading underlined with === or ---.
    const text = [];
    let level = 0;
    while (i < lines.length) {
      const next = lines[i];
      if (blank(next)) break;
      if (text.length) {
        const setext = SETEXT.exec(next);
        if (setext) {
          level = setext[1][0] === '=' ? 1 : 2;
          i += 1;
          break;
        }
        if (interrupts(next) || tableAt(lines, i)) break;
      }
      text.push(next.trim());
      i += 1;
    }
    add(level ? { type: 'heading', level, raw: text.join('\n') } : { type: 'paragraph', raw: text.join('\n') });
  }
  return blocks;
}

/** Read one list (its items, and what is nested in them) from line i; returns the line after it. */
function readList(lines, i, defs, depth, add) {
  const first = listMarker(lines[i]);
  const items = [];
  let tight = true;
  for (;;) {
    const item = listMarker(lines[i]);
    const body = [item.first];
    for (i += 1; i < lines.length; i += 1) {
      const next = lines[i];
      if (blank(next)) body.push('');
      else if (indentOf(next) >= item.width) body.push(next.slice(item.width));
      // Unindented text straight after the item's text goes on with it.
      else if (!blank(body.at(-1)) && !interrupts(next) && !listMarker(next)) body.push(next);
      else break;
    }
    // Blank lines at the end belong between this item and whatever follows.
    let trailing = 0;
    while (body.length > 1 && blank(body.at(-1))) {
      body.pop();
      trailing += 1;
    }
    i -= trailing;

    let task = null;
    const box = TASK.exec(body[0]);
    if (box) {
      task = box[1] !== ' ';
      body[0] = body[0].slice(box[0].length);
    }
    const children = readBlocks(body, defs, depth + 1);
    if (children.some((block, k) => k > 0 && block.gap)) tight = false;
    items.push({ task, children });

    let j = i;
    while (j < lines.length && blank(lines[j])) j += 1;
    const next = j < lines.length && !RULE.test(lines[j]) ? listMarker(lines[j]) : null;
    if (!next || next.ordered !== first.ordered || next.kind !== first.kind) break;
    if (j > i) tight = false;
    i = j;
  }
  add({ type: 'list', ordered: first.ordered, start: first.start, tight, items });
  return i;
}

/** Second pass: raw text into inline nodes, now that every reference is known. */
function finish(block, defs) {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return { type: block.type, ...(block.level ? { level: block.level } : {}), children: inline(block.raw, defs, 0) };
    case 'quote':
      return { type: 'quote', children: block.children.map((child) => finish(child, defs)) };
    case 'list':
      return {
        type: 'list',
        ordered: block.ordered,
        start: block.start,
        tight: block.tight,
        items: block.items.map((item) => ({ task: item.task, children: item.children.map((child) => finish(child, defs)) })),
      };
    case 'table':
      return {
        type: 'table',
        align: block.align,
        head: block.head.map((cell) => inline(cell, defs, 0)),
        rows: block.rows.map((row) => row.map((cell) => inline(cell, defs, 0))),
      };
    case 'code':
      return { type: 'code', lang: block.lang, text: block.text };
    default:
      return { type: block.type };
  }
}

// ----------------------------------------------------------------- inlines
//
// Code spans, links and escapes are read left to right into tokens; runs of
// * _ ~~ become delimiter tokens, which are then paired the way CommonMark
// pairs them (the "delimiter stack"). Every search is either indexed or
// bounded, so a 512 KB file full of unmatched signs is still read quickly.

const runOf = (src, i) => {
  let end = i;
  while (src[end] === src[i]) end += 1;
  return end - i;
};

/** Where each run of backticks starts, by its length. */
function backtickRuns(src) {
  const runs = new Map();
  for (let i = src.indexOf('`'); i !== -1;) {
    const size = runOf(src, i);
    if (!runs.has(size)) runs.set(size, []);
    runs.get(size).push(i);
    i = src.indexOf('`', i + size);
  }
  return runs;
}

/** A `code span` starting at i (it ends at the next run of as many backticks), or null. */
function codeSpan(src, i, runs) {
  const size = runOf(src, i);
  const starts = runs.get(size) ?? [];
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < i + size) lo = mid + 1;
    else hi = mid;
  }
  const close = starts[lo];
  if (close === undefined) return null;
  let text = src.slice(i + size, close).replace(/\n/g, ' ');
  if (text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
  return { text, end: close + size };
}

/** Which [ pairs with which ], ignoring escaped ones and those inside code spans. */
function matchBrackets(src, runs) {
  const pairs = new Map();
  const open = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '`') {
      const span = codeSpan(src, i, runs);
      i = (span ? span.end : i + runOf(src, i)) - 1;
    } else if (c === '[') {
      open.push(i);
    } else if (c === ']' && open.length) {
      pairs.set(open.pop(), i);
    }
  }
  return pairs;
}

/** Index of ch in src between from and end, or -1. */
function findBefore(src, ch, from, end) {
  for (let k = from; k < end; k += 1) if (src[k] === ch) return k;
  return -1;
}

/** The (destination "title") after a link's text, starting just inside the "(". */
function destination(src, k) {
  const end = Math.min(src.length, k + SCAN_LIMIT);
  const skipSpace = () => { while (k < end && /[ \t\n]/.test(src[k])) k += 1; };
  skipSpace();
  let target;
  if (src[k] === '<') {
    const close = findBefore(src, '>', k + 1, end);
    if (close === -1 || src.slice(k + 1, close).includes('\n')) return null;
    target = src.slice(k + 1, close);
    k = close + 1;
  } else {
    const from = k;
    let depth = 0;
    for (; k < end; k += 1) {
      const code = src.charCodeAt(k);
      if (code === 92) k += 1; // a backslash escapes the next character
      else if (code <= 32) break; // a space or control character ends the address
      else if (code === 40) depth += 1;
      else if (code === 41) {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    target = src.slice(from, k);
  }
  skipSpace();
  if (src[k] === '"' || src[k] === "'" || src[k] === '(') {
    const close = findBefore(src, src[k] === '(' ? ')' : src[k], k + 1, end);
    if (close === -1) return null;
    k = close + 1;
    skipSpace();
  }
  return src[k] === ')' ? { target: unescape(target), end: k + 1 } : null;
}

/** A sticky pattern tried at position i. */
function matchAt(pattern, src, i) {
  pattern.lastIndex = i;
  return pattern.exec(src);
}

/** A link (or a picture's brackets) starting at the "[" at i: [text](address), [text][ref], [ref]. */
function linkAt(src, i, brackets, defs) {
  const close = brackets.get(i);
  if (close === undefined) return null;
  const label = src.slice(i + 1, close);
  if (src[close + 1] === '(') {
    const dest = destination(src, close + 2);
    if (dest) return { label, target: dest.target, end: dest.end };
  }
  if (src[close + 1] === '[') {
    const end = brackets.get(close + 1);
    const target = end === undefined ? undefined : defs.get(labelKey(src.slice(close + 2, end) || label));
    if (target !== undefined) return { label, target, end: end + 1 };
  }
  const target = defs.get(labelKey(label));
  return target === undefined ? null : { label, target, end: close + 1 };
}

/** A web address written as it is, without the punctuation of the sentence around it. */
function bareUrl(src, i) {
  let url = matchAt(BARE_URL, src, i)?.[0];
  if (!url) return null;
  const count = (ch) => url.split(ch).length - 1;
  for (;;) {
    const last = url.at(-1);
    if (/[?!.,:;*_~'"]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && count('(') < count(')')) url = url.slice(0, -1);
    else break;
  }
  return webHref(url) ? url : null;
}

/** A run of * _ or ~~ that may open or close emphasis, as a delimiter token; null if it is plain text. */
function delimiter(char, run, before, after) {
  if (char === '~' ? run !== 2 : run > MAX_DELIMITER_RUN) return null;
  const spaceBefore = before === undefined || SPACE.test(before);
  const spaceAfter = after === undefined || SPACE.test(after);
  const punctBefore = !spaceBefore && PUNCTUATION.test(before);
  const punctAfter = !spaceAfter && PUNCTUATION.test(after);
  const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
  const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
  // An underscore inside a word (snake_case, #behind_the_scenes) is never emphasis.
  const canOpen = char === '_' ? left && (!right || punctBefore) : left;
  const canClose = char === '_' ? right && (!left || punctAfter) : right;
  if (!canOpen && !canClose) return null;
  return { type: 'delim', char, count: run, size: run, canOpen, canClose };
}

/** Inline nodes of one block's text. `links` is false inside a link's own text. */
function inline(src, defs, depth, links = true) {
  if (depth > MAX_INLINE_DEPTH) return [{ type: 'text', text: src }];
  const runs = backtickRuns(src);
  const brackets = matchBrackets(src, runs);
  const tokens = [];
  let text = '';
  const flush = () => {
    if (text) tokens.push({ type: 'text', text });
    text = '';
  };
  const push = (token) => {
    flush();
    tokens.push(token);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        push({ type: 'break' });
        i += 2;
      } else if (next !== undefined && ESCAPABLE.test(next)) {
        text += next;
        i += 2;
      } else {
        text += c;
        i += 1;
      }
      continue;
    }
    if (c === '\n') {
      push({ type: 'break' });
      i += 1;
      continue;
    }
    if (c === '`') {
      const span = codeSpan(src, i, runs);
      if (span) {
        push({ type: 'codespan', text: span.text });
        i = span.end;
      } else {
        const run = runOf(src, i);
        text += src.slice(i, i + run);
        i += run;
      }
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const link = linkAt(src, i + 1, brackets, defs);
      if (link) {
        const alt = plainText(inline(link.label, defs, depth + 1, false)).replace(/\n/g, ' ');
        push({ type: 'image', alt, target: link.target });
        i = link.end;
        continue;
      }
    }
    if (c === '[' && links) {
      const link = linkAt(src, i, brackets, defs);
      if (link) {
        push({ type: 'link', href: webHref(link.target), target: link.target, children: inline(link.label, defs, depth + 1, false) });
        i = link.end;
        continue;
      }
    }
    if (c === '<' && links) {
      const auto = matchAt(SCHEME_LINK, src, i);
      if (auto) {
        push({ type: 'link', href: webHref(auto[1]), target: auto[1], children: [{ type: 'text', text: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const run = runOf(src, i);
      const token = delimiter(c, run, src[i - 1], src[i + run]);
      if (token) push(token);
      else text += src.slice(i, i + run);
      i += run;
      continue;
    }
    if (links && (c === 'h' || c === 'H') && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) {
      const url = bareUrl(src, i);
      if (url) {
        push({ type: 'link', href: webHref(url), target: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return pairDelimiters(tokens);
}

/**
 * Pair * _ ~~ delimiters into strong / em / del, inner pairs first
 * (CommonMark's "process emphasis"). The tokens are put in a linked list, with
 * a second list through the delimiters alone, so wrapping a pair is a few
 * pointer changes and every token is moved into a wrapper at most once.
 */
function pairDelimiters(tokens) {
  const head = { next: null };
  let last = head;
  let delims = null; // the first delimiter cell
  let lastDelim = null;
  for (const token of tokens) {
    const cell = { token, prev: last, next: null, prevDelim: null, nextDelim: null };
    last.next = cell;
    last = cell;
    if (token.type !== 'delim') continue;
    cell.prevDelim = lastDelim;
    if (lastDelim) lastDelim.nextDelim = cell;
    else delims = cell;
    lastDelim = cell;
  }

  // For each kind of closer, the delimiter at and below which no opener can
  // match it any more (null: none). Keeps a run of unmatched closers linear.
  const floors = new Map();
  const dropDelim = (cell) => {
    if (cell.prevDelim) cell.prevDelim.nextDelim = cell.nextDelim;
    if (cell.nextDelim) cell.nextDelim.prevDelim = cell.prevDelim;
    for (const [kind, floor] of floors) if (floor === cell) floors.set(kind, cell.prevDelim);
  };
  const dropCell = (cell) => {
    cell.prev.next = cell.next;
    if (cell.next) cell.next.prev = cell.prev;
    dropDelim(cell);
  };

  let closer = delims;
  while (closer) {
    const c = closer.token;
    if (!c.canClose) {
      closer = closer.nextDelim;
      continue;
    }
    const kind = `${c.char}${c.canOpen ? 1 : 0}${c.size % 3}`;
    const floor = floors.get(kind) ?? null;
    let opener = closer.prevDelim;
    while (opener && opener !== floor) {
      const o = opener.token;
      // CommonMark's "rule of 3": in *a**b* the ** pairs with neither *.
      const ruleOf3 = c.char !== '~' && (o.canClose || c.canOpen) &&
        (o.size + c.size) % 3 === 0 && !(o.size % 3 === 0 && c.size % 3 === 0);
      if (o.char === c.char && o.canOpen && !ruleOf3) break;
      opener = opener.prevDelim;
    }
    if (!opener || opener === floor) {
      floors.set(kind, closer.prevDelim);
      const next = closer.nextDelim;
      if (!c.canOpen) dropDelim(closer); // stays in the text as written
      closer = next;
      continue;
    }

    const o = opener.token;
    const use = c.char === '~' ? 2 : o.count >= 2 && c.count >= 2 ? 2 : 1;
    o.count -= use;
    c.count -= use;
    const children = [];
    for (let cell = opener.next; cell !== closer; cell = cell.next) children.push(cell.token);
    for (let d = opener.nextDelim; d && d !== closer; d = d.nextDelim) dropDelim(d);
    const wrapper = {
      token: { type: c.char === '~' ? 'del' : use === 2 ? 'strong' : 'em', children: tidy(children) },
      prev: opener,
      next: closer,
      prevDelim: null,
      nextDelim: null,
    };
    opener.next = wrapper;
    closer.prev = wrapper;
    if (o.count === 0) dropCell(opener);
    if (c.count === 0) {
      const next = closer.nextDelim;
      dropCell(closer);
      closer = next;
    }
  }

  const out = [];
  for (let cell = head.next; cell; cell = cell.next) out.push(cell.token);
  return tidy(out);
}

const asText = (token) => ({ type: 'text', text: token.char.repeat(token.count) });

/** Unpaired delimiters become text; neighbouring text joins up. */
function tidy(tokens) {
  const out = [];
  for (const token of tokens) {
    const node = token.type === 'delim' ? asText(token) : token;
    if (node.type === 'text') {
      if (!node.text) continue;
      if (out.at(-1)?.type === 'text') out[out.length - 1] = { type: 'text', text: out.at(-1).text + node.text };
      else out.push(node);
    } else {
      out.push(node);
    }
  }
  return out;
}
