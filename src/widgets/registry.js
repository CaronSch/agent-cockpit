import pane from './pane.js';
import omp from './omp.js';
import sessions from './sessions.js';

/**
 * Widgets the palette can add, keyed by type.
 * Contract: { type, title, glyph, description, mount(body, ctx) → { destroy() } }.
 * `ctx.params` is this window's saved settings (read it when needed: it changes after
 * mount); `ctx.setParams(patch)` merges into them and persists them with the layout.
 * `ctx.addWidget(type, params)` opens another window beside the largest one;
 * `ctx.dragWidget(type, params, pointerdown)` lets the user drop it where they want, exactly
 * like dragging from the palette (a plain click does nothing).
 */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { DragEndResult } from '../interaction/drag-controller.js' */
/**
 * @typedef {{
 *   readonly params: LeafParams,
 *   setParams(patch: LeafParams): void,
 *   addWidget(type: string, params: LeafParams): void,
 *   dragWidget(type: string, params: LeafParams, event: PointerEvent, options?: { label?: string, onEnd?: (result: DragEndResult) => void }): void,
 * }} WidgetContext
 */
/**
 * @typedef {{ type: string, title: string, glyph: string, description: string,
 *   mount(body: HTMLElement, ctx: WidgetContext): { destroy(): void } }} WidgetDef
 */

/** @type {readonly WidgetDef[]} */
const DEFS = [pane, omp, sessions];

/** @type {Readonly<Record<string, WidgetDef>>} */
export const WIDGETS = Object.freeze(Object.fromEntries(DEFS.map((def) => [def.type, def])));
