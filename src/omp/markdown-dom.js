/**
 * Renders the safe markdown tree from `markdown.js` as DOM nodes (text nodes only, never HTML).
 */
import { el } from '../ui/dom.js';
import { parseMarkdown } from './markdown.js';
/** @import { Block, Inline } from './markdown.js' */

/** @param {string} source @returns {DocumentFragment} */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) fragment.append(renderBlock(block));
  return fragment;
}

/** @param {Block} block @returns {Node} */
function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return withInline(el('p'), block.children);
    case 'heading':
      return withInline(el(/** @type {'h3' | 'h4' | 'h5' | 'h6'} */ (`h${Math.min(6, block.level + 2)}`), 'md-heading'), block.children);
    case 'code': {
      const pre = el('pre', 'md-code');
      const code = el('code', undefined, block.text);
      if (block.lang) pre.dataset.lang = block.lang;
      pre.append(code);
      return pre;
    }
    case 'table':
      return el('pre', 'md-table', block.text);
    case 'rule':
      return el('hr');
    case 'quote': {
      const quote = el('blockquote');
      for (const child of block.children) quote.append(renderBlock(child));
      return quote;
    }
    case 'list': {
      const list = block.ordered ? el('ol') : el('ul');
      if (block.ordered && block.start !== 1 && list instanceof HTMLOListElement) list.start = block.start;
      for (const item of block.items) {
        const li = el('li');
        for (const child of item) li.append(renderBlock(child));
        list.append(li);
      }
      return list;
    }
  }
}

/** @template {HTMLElement} E @param {E} parent @param {Inline[]} children @returns {E} */
function withInline(parent, children) {
  for (const child of children) parent.append(renderInline(child));
  return parent;
}

/** @param {Inline} node @returns {Node} */
function renderInline(node) {
  switch (node.type) {
    case 'text':
      return document.createTextNode(node.text);
    case 'code':
      return el('code', 'md-inline-code', node.text);
    case 'strong':
      return withInline(el('strong'), node.children);
    case 'em':
      return withInline(el('em'), node.children);
    case 'break':
      return el('br');
    case 'link': {
      const a = withInline(el('a'), node.children);
      a.href = node.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      return a;
    }
  }
}
