// v0.2.5 表格列宽交互：渲染栏列边框悬停 col-resize、拖动实时预览、松开一次提交、双击按内容适应。
// 拖动期间不修改 ProseMirror 托管的 DOM（那会触发视图重绘），而是在 body 上放一份同尺寸的表格副本，
// 用 <colgroup> 实时预览百分比宽度；松开后只提交一次源码补丁，不逐像素写源码。
import { env } from '../runtime';
import type { Model } from '../../model';
import { setColumnWidths, tableWidths } from '../../tables';
import { applyTablePatch, editableTable, reportTableError, type EditableTable } from './shared';
import {
  boundaryAt, clearGeometryCache, contentWidths, fitColumnWidths, fitWidths, measuredPercentages,
  MIN_COLUMN_WIDTH, normalizePercentages, roundPercentages, tableGeometry,
} from './layout';

type ActiveDocument = EditableTable['doc'];

type Preview = { container: HTMLDivElement; table: HTMLTableElement };

type DragState = {
  doc: ActiveDocument;
  table: HTMLTableElement;
  tableId: string;
  boundary: number;
  base: number[];
  widths: number[];
  startX: number;
  tableWidth: number;
  moved: boolean;
  preview: Preview | null;
};

let drag: DragState | null = null;
let hoverTable: HTMLTableElement | null = null;
let hoverBoundary = 0;
let bound = false;

const draggableTable = (target: EventTarget | null): HTMLTableElement | null => {
  const element = target instanceof Element ? target.closest('table') : null;
  return element instanceof HTMLTableElement ? element : null;
};

function setHover(table: HTMLTableElement, boundary: number): void {
  if (hoverTable === table && hoverBoundary === boundary) return;
  clearHover();
  hoverTable = table;
  hoverBoundary = boundary;
  document.body.classList.add('mdre-table-col-hover');
}

function clearHover(): void {
  if (!hoverTable) return;
  hoverTable = null;
  hoverBoundary = 0;
  document.body.classList.remove('mdre-table-col-hover');
}

/** 创建覆盖在原表格上的预览副本：位置与尺寸一致，pointer-events 穿透。 */
function createPreview(state: DragState): Preview {
  const rect = state.table.getBoundingClientRect();
  const container = document.createElement('div');
  container.className = 'mdre-width-overlay';
  container.style.left = `${rect.left}px`;
  container.style.top = `${rect.top}px`;
  container.style.width = `${rect.width}px`;
  const style = getComputedStyle(state.table);
  container.style.fontFamily = style.fontFamily;
  container.style.fontSize = style.fontSize;
  container.style.lineHeight = style.lineHeight;
  container.style.letterSpacing = style.letterSpacing;
  container.style.color = style.color;
  const clone = state.table.cloneNode(true) as HTMLTableElement;
  clone.removeAttribute('data-block');
  clone.removeAttribute('data-format');
  clone.querySelectorAll('[data-block], [data-cell], [id]').forEach(node => {
    node.removeAttribute('data-block');
    node.removeAttribute('data-cell');
    node.removeAttribute('id');
  });
  clone.querySelectorAll('colgroup').forEach(group => group.remove());
  const colgroup = document.createElement('colgroup');
  for (let index = 0; index < state.base.length; index++) colgroup.append(document.createElement('col'));
  clone.insertBefore(colgroup, clone.firstChild);
  container.append(clone);
  document.body.append(container);
  return { container, table: clone };
}

function paintPreview(state: DragState, widths: number[]): void {
  const preview = state.preview;
  if (!preview) return;
  const columns = preview.table.querySelector('colgroup')?.children ?? [];
  for (let index = 0; index < widths.length && index < columns.length; index++) {
    (columns[index] as HTMLElement).style.width = `${Math.round(widths[index] * 100) / 100}%`;
  }
}

function syncPreviewPosition(state: DragState): void {
  if (!state.preview) return;
  const rect = state.table.getBoundingClientRect();
  state.preview.container.style.left = `${rect.left}px`;
  state.preview.container.style.top = `${rect.top}px`;
  state.preview.container.style.width = `${rect.width}px`;
}

function destroyPreview(state: DragState): void {
  state.preview?.container.remove();
  state.preview = null;
}

function detachDragListeners(): void {
  document.removeEventListener('mousemove', onDragMove, true);
  document.removeEventListener('mouseup', onDragEnd, true);
  document.removeEventListener('keydown', onDragKey, true);
  window.removeEventListener('scroll', onDragScroll, true);
  window.removeEventListener('resize', onDragScroll);
}

function finishDrag(): DragState | null {
  const state = drag;
  if (!state) return null;
  drag = null;
  detachDragListeners();
  destroyPreview(state);
  document.body.classList.remove('mdre-col-resizing');
  return state;
}

/** 取消当前拖动（文档切换、预览刷新或按 Escape 时调用），不提交任何源码修改。 */
export function cancelColumnDrag(): void {
  finishDrag();
}

function onDragScroll(): void {
  if (drag) syncPreviewPosition(drag);
}

function onDragMove(event: MouseEvent): void {
  const state = drag;
  if (!state) return;
  const deltaPixels = event.clientX - state.startX;
  if (!state.moved) {
    if (Math.abs(deltaPixels) < 1) return;
    state.moved = true;
  }
  event.preventDefault();
  const delta = deltaPixels / Math.max(1, state.tableWidth) * 100;
  const left = state.base[state.boundary - 1];
  const right = state.base[state.boundary];
  const limited = Math.max(MIN_COLUMN_WIDTH - left, Math.min(right - MIN_COLUMN_WIDTH, delta));
  const widths = state.base.slice();
  widths[state.boundary - 1] = left + limited;
  widths[state.boundary] = right - limited;
  state.widths = widths;
  paintPreview(state, widths);
}

function onDragKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !drag) return;
  event.preventDefault();
  event.stopPropagation();
  finishDrag();
}

function onDragEnd(): void {
  const state = finishDrag();
  if (!state || !state.moved) return;
  const widths = roundPercentages(state.widths);
  try {
    if (env().workspace.active !== state.doc) throw new Error('文档已切换，列宽未保存。');
    const model = state.doc.model as Model;
    applyTablePatch(setColumnWidths(model, state.tableId, widths));
  } catch (reason) {
    reportTableError(reason);
  } finally {
    clearGeometryCache();
  }
}

function baseWidths(info: EditableTable, table: HTMLTableElement, columns: number): number[] | null {
  let stored: number[] | null = null;
  try { stored = tableWidths(info.model, info.tableId); } catch { stored = null; }
  if (stored && stored.length === columns) return normalizePercentages(stored);
  return measuredPercentages(table);
}

function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || drag) return;
  const table = draggableTable(event.target);
  if (!table) return;
  const boundary = boundaryAt(table, event.clientX, event.clientY);
  if (boundary === null) return;
  const info = editableTable(table);
  if (!info) return;
  const geometry = tableGeometry(table);
  if (!geometry) return;
  const base = baseWidths(info, table, geometry.columns);
  if (!base) return;
  // 命中列边框：接管本次按下，阻止既有单元格选择/图片拖动/文本选区。
  event.preventDefault();
  event.stopImmediatePropagation();
  clearHover();
  drag = {
    doc: info.doc, table, tableId: info.tableId, boundary,
    base: roundPercentages(base), widths: base.slice(),
    startX: event.clientX, tableWidth: geometry.offsets[geometry.columns] - geometry.offsets[0],
    moved: false, preview: null,
  };
  drag.preview = createPreview(drag);
  paintPreview(drag, drag.widths);
  document.body.classList.add('mdre-col-resizing');
  document.addEventListener('mousemove', onDragMove, true);
  document.addEventListener('mouseup', onDragEnd, true);
  document.addEventListener('keydown', onDragKey, true);
  window.addEventListener('scroll', onDragScroll, true);
  window.addEventListener('resize', onDragScroll);
}

function onDoubleClick(event: MouseEvent): void {
  const table = draggableTable(event.target);
  if (!table) return;
  const boundary = boundaryAt(table, event.clientX, event.clientY);
  if (boundary === null) return;
  const info = editableTable(table);
  if (!info) return;
  const geometry = tableGeometry(table);
  if (!geometry) return;
  const required = contentWidths(table);
  if (!required) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const current = baseWidths(info, table, geometry.columns);
    if (!current) throw new Error('无法读取当前列宽，请刷新渲染后重试。');
    const widths = fitColumnWidths(current, fitWidths(required), boundary - 1);
    applyTablePatch(setColumnWidths(info.model as Model, info.tableId, widths));
  } catch (reason) {
    reportTableError(reason);
  } finally {
    clearGeometryCache();
  }
}

function onPointerMove(event: PointerEvent): void {
  if (drag || event.pointerType === 'touch') return;
  const table = draggableTable(event.target);
  if (!table) { clearHover(); return; }
  const boundary = boundaryAt(table, event.clientX, event.clientY);
  if (boundary === null || !editableTable(table)) { clearHover(); return; }
  setHover(table, boundary);
}

/** 绑定列宽拖拽/双击与悬停光标（render.dom 捕获阶段，只命中列边框时接管）。 */
export function initColumnResize(): void {
  if (bound) return;
  bound = true;
  const render = env().render;
  const dom = render.dom as HTMLElement;
  dom.addEventListener('mousedown', onMouseDown, true);
  dom.addEventListener('dblclick', onDoubleClick, true);
  dom.addEventListener('pointermove', onPointerMove, true);
  dom.addEventListener('pointerleave', () => { if (!drag) clearHover(); }, true);
  const invalidate = () => { if (!drag) { clearGeometryCache(); clearHover(); } };
  window.addEventListener('resize', invalidate);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!drag) clearGeometryCache(); }).observe(dom);
}

export { clearGeometryCache };
