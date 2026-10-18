import pane from './pane.js';
import omp from './omp.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, mount(body, ctx) → { destroy() } }.
 * `ctx.params` is this window's saved settings (read it when needed: it changes after
 * mount); `ctx.setParams(patch)` merges into them and persists them with the layout.
 */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @typedef {{ readonly params: LeafParams, setParams(patch: LeafParams): void }} WidgetContext */
/**
 * @typedef {{ type: string, title: string, glyph: string, description: string,
 *   mount(body: HTMLElement, ctx: WidgetContext): { destroy(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [pane, omp];

/** @type {Readonly<Record<string, WidgetDef>>} */
export const WIDGETS = Object.freeze(Object.fromEntries(DEFS.map((def) => [def.type, def])));
