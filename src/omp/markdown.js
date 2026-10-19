/**
 * Safe markdown subset for agent text: parses into a small block/inline tree, never HTML.
 *
 * Supported: paragraphs (newlines kept as line breaks), ATX headings, fenced code with a
 * language, inline code, bold/italic, bullet and numbered lists, block quotes, horizontal
 * rules, links and autolinks. Tables stay preformatted. Raw HTML is plain text. Only
 * http, https and mailto targets become links; anything else stays text. An unterminated
 * fence (text still streaming) runs to the end of the input.
 */

/**
 * @typedef {(
 *   | { type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong', children: Inline[] }
 *   | { type: 'em', children: Inline[] }
 *   | { type: 'link', href: string, children: Inline[] }
 *   | { type: 'break' }
 * )} Inline
 */

/**
 * @typedef {(
 *   | { type: 'paragraph', children: Inline[] }
 *   | { type: 'heading', level: number, children: Inline[] }
 *   | { type: 'code', lang: string, text: string }
 *   | { type: 'list', ordered: boolean, start: number, items: Block[][] }
 *   | { type: 'quote', children: Block[] }
 *   | { type: 'table', text: string }
 *   | { type: 'rule' }
 * )} Block
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns the href if it is an absolute http(s) or mailto URL, else null.
 * @param {string} raw @returns {string | null}
 */
export function safeHref(raw) {
  const href = raw.trim();
  // Control characters and whitespace inside a URL are never legitimate here.
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? href : null;
}

/** @param {string} source @returns {Block[]} */
export function parseMarkdown(source) {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

/** @param {string} line */
const isBlank = (line) => line.trim() === '';

/**
 * True when `line` would open a block other than a paragraph (so it ends a paragraph).
 * @param {string} line
 */
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/** @param {string[]} lines @returns {Block[]} */
function parseBlocks(lines) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = line.length - line.trimStart().length;
      /** @type {string[]} */
      const body = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close[0] === marker[0] && close.length >= marker.length && /^(`+|~+)$/.test(close)) {
          i++;
          break;
        }
        body.push(stripIndent(lines[i], indent));
        i++;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      /** @type {string[]} */
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        // Lazy continuation: an unmarked line right after quoted text continues it.
        inner.push(quoted ? quoted[1] : lines[i]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      /** @type {string[]} */
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(lines[i++]);
      blocks.push({ type: 'table', text: rows.join('\n') });
      continue;
    }

    /** @type {string[]} */
    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseInline(para.map((l) => l.trim()).join('\n')) });
  }
  return blocks;
}

/** @param {string} line @param {number} count */
function stripIndent(line, count) {
  let n = 0;
  while (n < count && line[n] === ' ') n++;
  return line.slice(n);
}

/**
 * @param {string[]} lines @param {number} start
 * @returns {{ block: Block, next: number }}
 */
function parseList(lines, start) {
  const first = /** @type {RegExpExecArray} */ (LIST_ITEM.exec(lines[start]));
  const ordered = /\d/.test(first[2]);
  const delimiter = ordered ? first[2].slice(-1) : first[2];
  /** @type {string[][]} */
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match) break;
    const isOrdered = /\d/.test(match[2]);
    if (isOrdered !== ordered || (isOrdered ? match[2].slice(-1) : match[2]) !== delimiter) break;
    const contentIndent = match[1].length + match[2].length + 1;
    /** @type {string[]} */
    const body = [match[3] ?? ''];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (isBlank(next)) {
        // A blank line continues the item only if indented content follows it.
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(next) >= contentIndent) {
        body.push(stripIndent(next, contentIndent));
      } else if (LIST_ITEM.test(next) || startsBlock(next)) {
        break;
      } else {
        body.push(next.trim()); // lazy paragraph continuation
      }
      i++;
    }
    items.push(body);
    // Blank lines between items keep the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j > i && j < lines.length && LIST_ITEM.test(lines[j])) i = j;
  }
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  return { block: { type: 'list', ordered, start: startNumber, items: items.map(parseBlocks) }, next: i };
}

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const BARE_URL = /^(https?:\/\/[^\s<]+[^\s<.,;:!?'")\]}])/;

/**
 * @param {string} text @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      flush();
      out.push({ type: 'break' });
      i++;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close !== -1 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close === -1) {
        buf += fence;
        i += run;
        continue;
      }
      let code = text.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      flush();
      out.push({ type: 'code', text: code });
      i = close + run;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const span = parseEmphasis(text, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.next;
        continue;
      }
      // An unmatched run of delimiters is literal text.
      let run = 1;
      while (text[i + run] === ch) run++;
      buf += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === '[') {
      const link = parseLink(text, i);
      if (link) {
        flush();
        out.push(...link.nodes);
        i = link.next;
        continue;
      }
    }

    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      const href = close === -1 ? null : safeHref(text.slice(i + 1, close));
      if (href) {
        flush();
        out.push({ type: 'link', href, children: [{ type: 'text', text: href.replace(/^mailto:/i, '') }] });
        i = close + 1;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || !WORD.test(text[i - 1]))) {
      const bare = BARE_URL.exec(text.slice(i));
      const href = bare && safeHref(bare[1]);
      if (bare && href) {
        flush();
        out.push({ type: 'link', href, children: [{ type: 'text', text: href }] });
        i += bare[1].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * `**strong**`, `__strong__`, `*em*`, `_em_` starting at `start`. Underscores only count
 * at word boundaries, so snake_case identifiers stay intact.
 * @param {string} text @param {number} start
 * @returns {{ node: Inline, next: number } | null}
 */
function parseEmphasis(text, start) {
  const ch = text[start];
  const double = text[start + 1] === ch;
  const delim = double ? ch + ch : ch;
  const open = start + delim.length;
  if (open >= text.length || /\s/.test(text[open])) return null;
  if (ch === '_' && start > 0 && WORD.test(text[start - 1])) return null;
  let search = open;
  while (search < text.length) {
    const close = text.indexOf(delim, search);
    if (close === -1) return null;
    const after = text[close + delim.length];
    const valid =
      close > open &&
      !/\s/.test(text[close - 1]) &&
      // A single delimiter must not be half of a double one.
      (double || (after !== ch && text[close - 1] !== ch)) &&
      (ch !== '_' || after === undefined || !WORD.test(after));
    if (valid) {
      const children = parseInline(text.slice(open, close));
      return { node: double ? { type: 'strong', children } : { type: 'em', children }, next: close + delim.length };
    }
    search = close + 1;
  }
  return null;
}

/**
 * `[label](target)`. Unsafe targets keep their label as plain text.
 * @param {string} text @param {number} start
 * @returns {{ nodes: Inline[], next: number } | null}
 */
function parseLink(text, start) {
  let depth = 0;
  let end = -1;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\\') {
      j++;
      continue;
    }
    if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) {
      end = j;
      break;
    }
  }
  if (end === -1 || text[end + 1] !== '(') return null;
  // The target may hold balanced parentheses, e.g. a Wikipedia URL.
  let close = -1;
  for (let j = end + 2, parens = 0; j < text.length; j++) {
    if (text[j] === '(') parens++;
    else if (text[j] === ')' && parens-- === 0) {
      close = j;
      break;
    }
  }
  if (close === -1) return null;
  const target = text.slice(end + 2, close).trim().split(/\s+/)[0] ?? '';
  const children = parseInline(text.slice(start + 1, end));
  const href = safeHref(target.replace(/^<|>$/g, ''));
  return { nodes: href ? [{ type: 'link', href, children }] : children, next: close + 1 };
}
