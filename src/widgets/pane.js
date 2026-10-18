import { el } from '../ui/dom.js';

/** An empty window: the frame every real widget is mounted into, with nothing inside. */
export default {
  type: 'pane',
  title: 'Pane',
  glyph: '▢',
  description: 'An empty window',

  /** @param {HTMLElement} body */
  mount(body) {
    body.append(el('p', 'widget-empty', 'Empty pane'));
    return { destroy() {} };
  },
};
