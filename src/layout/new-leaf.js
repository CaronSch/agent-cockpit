/** Fresh leaf ids for widgets entering the tree. */
import { leaf } from './grid-model.js';

export const createId = () => `w_${crypto.randomUUID().slice(0, 8)}`;
/** @param {string} widget */
export const newLeaf = (widget) => leaf(createId(), widget);
