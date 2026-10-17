// v0.2.5 渲染栏右键“表格”菜单扩展：列宽组、上下居中、合并/拆分单元格、转换为 Markdown 表格。
// 只原地追加 table-operations.children，保留 main.ts 既有的对齐与插删行列项；所有操作经 info.run 包装。
import { editorContextHooks, env, type EditorContextInfo } from '../runtime';
import type { ContextItem } from '../../ui/context-menu';
import type { Model } from '../../model';
import {
  canConvertToMarkdownTable, convertToMarkdownTable, findTable, mergeCells, readTable, setColumnWidths,
  setVerticalAlign, splitCell, tableIdOfCell, tableWidths, type TableCellInfo, type TableInfo,
} from '../../tables';
import { applyTablePatch, cellPositions, tableOfCell } from './shared';
import { contentWidths, equalWidths, fitWidths, tableGeometry } from './layout';
import { confirmConvertToMarkdown } from './convert-dialog';

type WidthAction = 'equal' | 'fit' | 'auto';

export function initTableContextMenu(): void {
  editorContextHooks.push(info => {
    try { extendTableMenu(info); } catch (reason) { console.error('MDRE 表格右键菜单扩展失败', reason); }
  });
}

function extendTableMenu(info: EditorContextInfo): void {
  const tableItem = info.items.find(item => item.id === 'table-operations');
  if (!tableItem?.children) return;
  const cell = info.cell;
  if (!cell) return;
  const table = tableOfCell(cell);
  if (!table) return;
  const model = info.doc.model as Model;
  const clicked = cell.dataset.cell ?? '';
  if (!clicked) return;
  let tableId = table.dataset.block ?? '';
  if (!tableId) {
    try { tableId = tableIdOfCell(model, clicked) ?? ''; } catch { tableId = ''; }
  }
  if (!tableId) return;
  const tableInfo = safeTable(model, tableId);
  if (!tableInfo) return;
  const writable = info.writable;
  const selected = info.tableCells.length ? [...new Set(info.tableCells)] : [clicked];
  if (!selected.length) return;
  const run = info.run;
  const cellById = new Map<string, TableCellInfo>();
  for (const row of tableInfo.cells) for (const entry of row) cellById.set(entry.id, entry);
  const currentModel = () => env().workspace.active.model as Model;
  const currentTable = () => (document.querySelector<HTMLElement>(`[data-cell="${clicked}"]`)?.closest('table') ?? table) as HTMLTableElement;

  let storedWidths: number[] | null = null;
  try { storedWidths = tableWidths(model, tableId); } catch { storedWidths = null; }
  const autoEnabled = !!storedWidths && storedWidths.length === tableInfo.columns;

  const widthChildren: ContextItem[] = [
    { id: 'table-width-equal', label: '均分各列', disabled: !writable, run: run(() => applyColumnWidths(currentModel, currentTable, tableId, 'equal')) },
    { id: 'table-width-fit', label: '适应内容', disabled: !writable, run: run(() => applyColumnWidths(currentModel, currentTable, tableId, 'fit')) },
    { id: 'table-width-auto', label: '恢复自动列宽', disabled: !writable || !autoEnabled, run: run(() => applyColumnWidths(currentModel, currentTable, tableId, 'auto')) },
  ];

  const middle = selected.every(id => cellById.get(id)?.vAlign === 'middle');
  const valignItem: ContextItem = {
    id: 'table-valign-middle', label: '上下居中', icon: 'swap', checked: middle, disabled: !writable,
    run: run(() => applyTablePatch(setVerticalAlign(currentModel(), selected, !middle))),
  };

  const clickedInfo = cellById.get(clicked);
  const mergeItem: ContextItem = {
    id: 'table-merge', label: '合并单元格', icon: 'join', disabled: !writable || selected.length < 2,
    run: run(() => {
      const active = currentModel();
      assertMergeRectangle(active, tableId, selected);
      applyTablePatch(mergeCells(active, selected));
    }),
  };
  const splittable = !!clickedInfo && (clickedInfo.rowspan > 1 || clickedInfo.colspan > 1);
  const splitItem: ContextItem = {
    id: 'table-split', label: '拆分单元格', icon: 'split', disabled: !writable || !splittable,
    run: run(() => applyTablePatch(splitCell(currentModel(), clicked))),
  };

  let convertible = false;
  try { convertible = writable && canConvertToMarkdownTable(model, tableId); } catch { convertible = false; }
  const convertItem: ContextItem = {
    id: 'table-to-markdown', label: '转换为 Markdown 表格', icon: 'markdown', disabled: !convertible,
    run: run(async () => {
      const doc = env().workspace.active;
      const snapshot = doc.model as Model;
      if (!canConvertToMarkdownTable(snapshot, tableId)) throw new Error('当前表格不满足转换为 Markdown 表格的条件（需为无合并单元格、无上下居中的 HTML 表格）。');
      reportNothingToConvert(snapshot, tableId);
      const element = currentTable();
      if (!element.isConnected) throw new Error('表格已不在渲染页中，请刷新渲染后重试。');
      const accepted = await confirmConvertToMarkdown(snapshot, tableId, element);
      if (!accepted) return;
      if (env().workspace.active !== doc || (doc.model as Model) !== snapshot) throw new Error('文档已变化，请重新右键操作。');
      applyTablePatch(convertToMarkdownTable(doc.model as Model, tableId));
      env().message('已转换为 Markdown 表格');
    }),
  };

  tableItem.children.push(
    { id: 'sep-table-widths-v025', label: '', separator: true },
    ...widthChildren,
    { id: 'sep-table-valign-v025', label: '', separator: true },
    valignItem,
    { id: 'sep-table-merge-v025', label: '', separator: true },
    mergeItem,
    splitItem,
    { id: 'sep-table-to-markdown-v025', label: '', separator: true },
    convertItem,
  );
}

function safeTable(model: Model, tableId: string): TableInfo | null {
  try { return findTable(model, tableId); } catch { return null; }
}

/** 该表如果是 GFM 表格，本来就没有可转换的 HTML 结构：保持置灰逻辑由数据层判定。 */
function reportNothingToConvert(model: Model, tableId: string): void {
  const info = safeTable(model, tableId);
  if (info && info.format !== 'html') throw new Error('当前表格已是标准 Markdown 表格，无需转换。');
}

function applyColumnWidths(currentModel: () => Model, currentTable: () => HTMLTableElement, tableId: string, action: WidthAction): void {
  const model = currentModel();
  if (action === 'auto') {
    applyTablePatch(setColumnWidths(model, tableId, null));
    return;
  }
  const info = readTable(model, tableId);
  if (action === 'equal') {
    applyTablePatch(setColumnWidths(model, tableId, equalWidths(info.columns)));
    return;
  }
  const table = currentTable();
  if (!table.isConnected) throw new Error('表格已不在渲染页中，请刷新渲染后重试。');
  const geometry = tableGeometry(table);
  if (!geometry) throw new Error('无法测量表格列宽，请刷新渲染后重试。');
  if (geometry.columns !== info.columns) throw new Error('渲染列数与表格数据列数不一致，请刷新渲染后重试。');
  const required = contentWidths(table);
  if (!required) throw new Error('无法测量表格内容宽度，请刷新渲染后重试。');
  applyTablePatch(setColumnWidths(model, tableId, fitWidths(required)));
}

/** 合并前校验矩形选区：只接受连续行列组成的矩形，非法时用中文错误拒绝（不改文档）。 */
function assertMergeRectangle(model: Model, tableId: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('选择中包含重复单元格，请重新选择。');
  const info = readTable(model, tableId);
  const positions = cellPositions(info);
  const boxes = ids.map(id => positions.get(id));
  if (boxes.some(box => !box)) throw new Error('只能合并同一表格内的单元格。');
  // 选区里已有合并单元格时交给数据层判断能否保持跨度。
  if (boxes.some(box => box!.rowspan > 1 || box!.colspan > 1)) return;
  const rows = boxes.map(box => box!.row);
  const columns = boxes.map(box => box!.column);
  const minRow = Math.min(...rows), maxRow = Math.max(...rows);
  const minColumn = Math.min(...columns), maxColumn = Math.max(...columns);
  const area = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);
  if (area !== ids.length || boxes.some(box => box!.row < minRow || box!.row > maxRow || box!.column < minColumn || box!.column > maxColumn)) {
    throw new Error('只能合并矩形区域：请选择连续的行列范围后再合并。');
  }
}
