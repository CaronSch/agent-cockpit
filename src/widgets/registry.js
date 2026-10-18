import pane from './pane.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, mount(body) → { destroy() } }
 */
/**
 * @typedef {{ type: string, title: string, glyph: string, description: string,
 *   mount(body: HTMLElement): { destroy(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [pane];

/** @type {Readonly<Record<string, WidgetDef>>} */
export const WIDGETS = Object.freeze(Object.fromEntries(DEFS.map((def) => [def.type, def])));
