// Divya's site-generator-speed entry: a fresh, dependency-free drop-in for
// makefun-site 1.0.0. Written from scratch against the kit's README + reference
// semantics (fused single-pass Markdown, index-based front matter, tree-walk
// templates). No code is copied from any other entry.
//
// run(input) returns the same output tree makefun-site 1.0.0's build returns,
// byte for byte.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** ECMAScript \s (WhiteSpace + LineTerminator) by code unit. */
function isWS(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** HTML escape: & < > " ' only. Returns the input itself when nothing changes. */
function esc(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (last < i) out += s.slice(last, i);
    out += rep;
    last = i + 1;
  }
  if (last === 0) return s;
  return last < s.length ? out + s.slice(last) : out;
}

/** Escape one character (used inside the inline loop). */
function escCh(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  slugCache.set(text, out);
  return out;
}

function slugifySlow(text) {
  // ASCII is stable under NFKD and holds no combining marks: the plain path
  // below is exact for it. Anything else goes through the full normalisation.
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const longDateCache = new Map();
function longDate(date) {
  const hit = longDateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = d + ' ' + MONTHS[m - 1] + ' ' + y;
  longDateCache.set(date, out);
  return out;
}

/** Word count: runs of non-whitespace, ECMAScript \s. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII fast lane: whitespace is 9-13 or 32; anything >= 128 uses isWS.
    const ws = c < 128 ? (c === 32 || (c >= 9 && c <= 13)) : isWS(c);
    if (ws) { inWord = false; continue; }
    if (!inWord) { inWord = true; n++; }
  }
  return n;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // first char must be alnum (no leading dash)
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
          prevDash = false;
        } else ok = false;
      }
      if (prevDash) ok = false; // trailing dash
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

// Line helpers over a string with \n ends: line [start, end) without the \n.
function lineEndAt(s, start) {
  const nl = s.indexOf('\n', start);
  return nl === -1 ? s.length : nl;
}

/**
 * Parse front matter: { data, body } or { error }. `text` has \n line ends.
 * Works on line offsets; the body is a slice of the input, never re-joined.
 */
function parseFrontMatter(text) {
  const firstEnd = lineEndAt(text, 0);
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstEnd + 1;
  while (pos <= text.length) {
    const e = lineEndAt(text, pos);
    if (e - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeStart = pos;
      closeEnd = e;
      break;
    }
    if (e === text.length) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // 1-based, opening --- is line 1
  pos = firstEnd + 1;
  while (pos < closeStart) {
    const e = lineEndAt(text, pos);
    lineNo++;
    const line = text.slice(pos, e);
    // blank (spaces/tabs only) or comment
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) { // not '#'
      const colon = line.indexOf(':');
      let key = null;
      let raw = null;
      if (colon > 0) {
        let keyOk = true;
        for (let i = 0; i < colon; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
        }
        if (keyOk) {
          key = line.slice(0, colon);
          if (colon === line.length - 1) raw = '';
          else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
        }
      }
      if (key === null) return { error: 'line ' + lineNo + ' is not "key: value"' };
      // drop trailing spaces/tabs from raw
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c !== 32 && c !== 9) break;
        r--;
      }
      if (r < raw.length) raw = raw.slice(0, r);
      if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

// Line classifiers (operate on a line string, no regex).
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fence open: ``` + lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45) { i++; continue; }
    break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 #, space/tab, non-empty text. Returns {depth, text} or null.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) break;
    j++;
  }
  if (j >= line.length) return null;
  let e = line.length;
  while (e > j) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  return { depth: n, text: line.slice(j, e) };
}

function isHr(line) {
  let tag = null;
  if (line.startsWith('---')) tag = 3;
  else if (line.startsWith('***')) tag = 3;
  else return false;
  for (let i = tag; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < 9 && i < line.length) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
  }
  return null;
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** First index in [from, hi) where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const w0 = what.charCodeAt(0);
  const last = hi - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.charCodeAt(j) === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.charCodeAt(j) !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Push s[lo, hi) HTML-escaped into `out`, in chunks. */
function escRange(s, lo, hi, out) {
  let last = lo;
  for (let i = lo; i < hi; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (last < i) out.push(s.slice(last, i));
    out.push(rep);
    last = i + 1;
  }
  if (last < hi) out.push(s.slice(last, hi));
}

/** Any character inline rendering treats specially (markdown or HTML escape). */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * Render inline Markdown of s[lo, hi) into `out` (an array of string pieces).
 * The native regex jumps straight to the next special character, so plain
 * runs are pushed as slices and the loop only stops at syntax. Recursion
 * works on ranges, never on sliced copies. `link` resolves a link target.
 * SPECIAL_RE is shared and re-entrant: lastIndex is reset at the top of
 * every iteration, so a nested call cannot disturb its caller.
 */
function inlineRange(s, lo, hi, link, out) {
  let i = lo;
  let run = lo; // start of the pending plain run
  while (i < hi) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m === null || m.index >= hi ? hi : m.index;
    if (j === hi) break;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash escape
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        if (j > run) out.push(s.slice(run, j));
        out.push(escCh(s[j + 1]));
        i = j + 2;
        run = i;
        continue;
      }
      i = j + 1; // backslash before a plain char: part of the plain run
      continue;
    }
    if (c === 96) { // code span
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<code>');
        escRange(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1; // lone backtick: part of the plain run
      }
      continue;
    }
    if (c === 42) { // * strong / em
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          if (j > run) out.push(s.slice(run, j));
          out.push('<strong>');
          inlineRange(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          run = i;
        } else {
          i = j + 2; // '**' with no closer: part of the plain run
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<em>');
        inlineRange(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1; // lone '*': part of the plain run
      }
      continue;
    }
    if (c === 91) { // [ link
      const k = findUnescaped(s, ']', j + 1, hi);
      let p = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        p = s.indexOf(')', k + 2);
        if (p === -1 || p >= hi) p = -1;
      }
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<a href="', esc(link(target)), '">');
        inlineRange(s, j + 1, k, link, out);
        out.push('</a>');
        i = p + 1;
        run = i;
        continue;
      }
      i = j + 1; // '[' with no link: part of the plain run
      continue;
    }
    // one of & < > " ' : escape it
    if (j > run) out.push(s.slice(run, j));
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    i = j + 1;
    run = i;
  }
  if (hi > run) out.push(s.slice(run, hi));
}

/** Any character inline rendering treats specially (markdown or HTML escape). */
const INLINE_SPECIAL = /[\\`*\[&<>"']/;

function inlineStr(s, link) {
  if (!INLINE_SPECIAL.test(s)) return s;
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * Render one body to HTML. Returns { html, toc, excerpt, words }.
 * Single pass over line offsets; no token array. The word count (the body's
 * words, for reading_minutes) is fused into this pass: every body line is
 * sliced exactly once, so counting each line where it is consumed gives the
 * whole body's count — a blank line has no words, and a line that only ends
 * a block is counted when the outer loop reaches it as a block start.
 */
function renderMarkdown(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const len = src.length;
  let pos = 0;
  while (pos < len) {
    let e = src.indexOf('\n', pos); if (e === -1) e = src.length;
    const line = src.slice(pos, e);
    const next = e === len ? len : e + 1;
    if (isBlank(line)) { pos = next; continue; }
    words += wordsOf(line);
    const lang = fenceLang(line);
    if (lang !== null) {
      const parts = ['<pre><code'];
      if (lang !== '') { parts.push(' class="language-', esc(lang), '"'); }
      parts.push('>');
      pos = next;
      while (pos < len) {
        let e2 = src.indexOf('\n', pos); if (e2 === -1) e2 = src.length;
        const bl = src.slice(pos, e2);
        words += wordsOf(bl);
        if (isFenceClose(bl)) { pos = e2 === len ? len : e2 + 1; break; }
        parts.push(esc(bl), '\n');
        pos = e2 === len ? len : e2 + 1;
      }
      // A fence that runs to the end leaves pos at len; the reference's
      // trailing i++ past the end is a no-op for us.
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineStr(hd.text, link);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = next;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // blockquote
      const qlines = [];
      const t0 = trimLine(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1));
      if (t0 !== '') qlines.push(t0);
      pos = next;
      while (pos < len) {
        let e2 = src.indexOf('\n', pos); if (e2 === -1) e2 = src.length;
        const bl = src.slice(pos, e2);
        if (bl.charCodeAt(0) !== 62) break;
        words += wordsOf(bl);
        const t = trimLine(bl.charCodeAt(1) === 32 ? bl.slice(2) : bl.slice(1));
        if (t !== '') qlines.push(t);
        pos = e2 === len ? len : e2 + 1;
      }
      if (qlines.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push('<blockquote>\n<p>' + inlineStr(qlines.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const start = marker.start;
      const items = [[trimLine(marker.text)]];
      pos = next;
      while (pos < len) {
        let e2 = src.indexOf('\n', pos); if (e2 === -1) e2 = src.length;
        const bl = src.slice(pos, e2);
        const m2 = listMarker(bl);
        if (m2 !== null && m2.ordered === ordered) {
          words += wordsOf(bl);
          items.push([trimLine(m2.text)]);
          pos = e2 === len ? len : e2 + 1;
        } else if (isContinued(bl)) {
          words += wordsOf(bl);
          items[items.length - 1].push(trimLine(bl));
          pos = e2 === len ? len : e2 + 1;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      const parts = [open, '\n'];
      for (let k = 0; k < items.length; k++) {
        parts.push('<li>', inlineStr(items[k].join('\n'), link), '</li>\n');
      }
      parts.push('</', tag, '>');
      blocks.push(parts.join(''));
      continue;
    }
    // paragraph: lines until blank / fence / heading / hr
    const plines = [trimLine(line)];
    pos = next;
    while (pos < len) {
      let e2 = src.indexOf('\n', pos); if (e2 === -1) e2 = src.length;
      const bl = src.slice(pos, e2);
      if (endsParagraph(bl)) break;
      words += wordsOf(bl);
      plines.push(trimLine(bl));
      pos = e2 === len ? len : e2 + 1;
    }
    const html = inlineStr(plines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_START = /[A-Za-z_]/;
function pathOf(name, text) {
  // text is already trimmed by the caller.
  if (text.length === 0) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  const parts = text.split('.');
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.length === 0 || !PATH_START.test(p[0])) {
      throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    }
    for (let i = 1; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) {
        throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
      }
    }
  }
  return parts;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src.charCodeAt(open + 1);
    if (nx !== 123 && nx !== 37) { // not '{' or '%'
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === 123) { // {{ or {{{
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    // {% %}
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if (tag.startsWith('for ') && (m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if (tag.startsWith('if ') && (m = /^if (not )?(\S+)$/.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError('template "' + name + '": an else outside an if');
      }
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
    } else if ((m = /^include "([a-z0-9-]+)"$/.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, templates, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var': {
        const v = lookup(scope, node.path);
        out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, node.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        // One scope object per (node, include depth), reused across renders:
        // a node cannot be on the render stack twice at the same depth
        // (re-entry goes through an include, which raises the depth), and
        // the parent, loop length, binding and loop fields are all reset
        // before each use below.
        let child = node.cache === undefined ? undefined : node.cache[depth];
        if (child === undefined) {
          const vars = {};
          vars[node.name] = undefined;
          vars.loop = { index: 1, first: true, last: false, length: xs.length };
          child = { vars, parent: scope };
          if (node.cache === undefined) node.cache = [];
          node.cache[depth] = child;
        } else {
          child.parent = scope;
          child.vars.loop.length = xs.length;
        }
        const vars = child.vars;
        const loop = vars.loop;
        for (let k = 0; k < xs.length; k++) {
          vars[node.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(node.body, child, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(node.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

function linkOf(s) {
  if (s === null) return null;
  const d = s.data.date;
  return { title: s.data.title, url: s.url, date: d === undefined ? '' : d, date_long: d === undefined ? '' : longDate(d) };
}

export function run(input) {
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort();
  for (let i = 0; i < tNames.length; i++) {
    const name = tNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter + drops, in source order.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => {
    const d = x.data.date < y.data.date ? 1 : x.data.date > y.data.date ? -1 : 0;
    if (d !== 0) return d;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = p.data.tags !== undefined ? p.data.tags : [];
    const seen = new Set();
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = s.data.tags !== undefined ? s.data.tags : [];
    const seen = new Set();
    s.tagRefs = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => {
    if (y.posts.length !== x.posts.length) return y.posts.length - x.posts.length;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });

  // Cards.
  const cards = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const d = s.data.date;
    s.card = {
      title: s.data.title,
      url: s.url,
      date: d === undefined ? '' : d,
      date_long: d === undefined ? '' : longDate(d),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    if (s.post) cards.set(s, s.card);
  }

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const page = { ...s.card, slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post };
    output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', { site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url,
      count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
