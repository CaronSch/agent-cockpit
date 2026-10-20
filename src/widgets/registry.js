import { leaf } from '../layout/grid-model.js';
import pane from './pane.js';
import omp from './omp.js';
import sessions from './sessions.js';
import scratchpad from './scratchpad.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, newParams?(), mount(body, ctx) → { destroy() } }.
 * `newParams()` gives a window its starting settings when one is created (e.g. a fresh
 * scratchpad id); windows restored from a saved layout keep theirs.
 * `ctx.params` is this window's saved settings (read it when needed: it changes after
 * mount); `ctx.setParams(patch)` merges into them and persists them with the layout.
 * `ctx.addWidget(type, params)` opens another window beside the largest one;
 * `ctx.dragWidget(type, params, pointerdown)` lets the user drop it where they want, exactly
 * like dragging from the palette (a plain click does nothing).
 * `ctx.setUnread(true)` lights the window's border: it has news its user has not seen.
 */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { DragEndResult } from '../interaction/drag-controller.js' */
/**
 * @typedef {{
 *   readonly params: LeafParams,
 *   setParams(patch: LeafParams): void,
 *   addWidget(type: string, params: LeafParams): void,
 *   dragWidget(type: string, params: LeafParams, event: PointerEvent, options?: { label?: string, onEnd?: (result: DragEndResult) => void }): void,
 *   setUnread(unread: boolean): void,
 * }} WidgetContext
 */
/**
 * @typedef {{ type: string, title: string, glyph: string, description: string,
 *   newParams?: () => LeafParams,
 *   mount(body: HTMLElement, ctx: WidgetContext): { destroy(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [pane, omp, sessions, scratchpad];

/** @type {Readonly<Record<string, WidgetDef>>} */
export const WIDGETS = Object.freeze(Object.fromEntries(DEFS.map((def) => [def.type, def])));

/**
 * A new window of `type`: with `params` if given, else the widget's own starting settings.
 * @param {string} type @param {LeafParams} [params]
 */
export function newWidgetLeaf(type, params) {
  const fresh = leaf(`w_${crypto.randomUUID().slice(0, 8)}`, type);
  const start = params ?? WIDGETS[type]?.newParams?.();
  return start ? { ...fresh, params: start } : fresh;
}
