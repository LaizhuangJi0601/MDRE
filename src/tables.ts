import { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { cellSpans, parse, parseWidthList, formatWidthList, schema, type Block, type Model, type TableAlignValue, type TableVAlignValue } from './model';
import { validated, validatedStructure, serializeBlock, htmlInlineContent, patch, type Patch } from './edits';
import { lineEnding, withFollowingParagraph } from './blocks';
import { alignedCell, wrapCell, type CellAlignment } from './table-alignment';

type Grid = { table: Block; header: string[]; delimiter: string[]; body: string[][]; aligns: string[] };
type Cells = { header: string[]; delimiter: string[]; body: string[][] };

function readGrid(model: Model, table: Block): Grid {
  // 表格块区间可能包含其后的列宽注释，行数由模型决定，避免把注释读成数据行。
  const count = table.node.childCount + 1;
  const lines: { from: number; to: number }[] = [];
  let at = table.from;
  for (let index = 0; index < count; index++) {
    const next = model.source.indexOf('\n', at);
    const end = next < 0 ? model.source.length : next + 1;
    lines.push({ from: at, to: end });
    at = end;
    if (next < 0) break;
  }
  if (lines.length < 2) throw new Error('表格结构不完整，请在源码栏调整。');
  const rows = lines.map(line => cellSpans(model.source, line.from, line.to).map(span => model.source.slice(span.from, span.to)));
  const columns = rows[0].length;
  if (!columns) throw new Error('表格缺少表头，请在源码栏调整。');
  const pad = (cells: string[]) => Array.from({ length: columns }, (_, index) => cells[index] ?? '');
  const aligns = model.blocks.filter(b => b.type === 'table_cell' && b.node.attrs.header === true && b.parent === table.node.firstChild?.attrs.id)
    .sort((a, b) => a.from - b.from).map(cell => String(cell.node.attrs.align ?? ''));
  return { table, header: rows[0], delimiter: pad(rows[1]), body: rows.slice(2).map(pad), aligns: Array.from({ length: columns }, (_, index) => aligns[index] ?? '') };
}

function inlineContent(text: string): PMNode[] {
  const first = parse(text).doc.firstChild;
  if (first?.isTextblock) return Array.from({ length: first.childCount }, (_, index) => first.child(index));
  return text ? [schema.text(text)] : [];
}

function buildTable(grid: Grid, cells: Cells, attrs: Record<string, unknown> = {}): PMNode {
  const rows = [cells.header, ...cells.body];
  return schema.nodes.table.create(attrs, rows.map((row, index) => schema.nodes.table_row.create({ id: '', header: index === 0 },
    row.map((text, column) => { const cell = alignedCell(text); return schema.nodes.table_cell.create({ id: '', header: index === 0, align: grid.aligns[column] ?? '', cellAlign: cell.align }, inlineContent(cell.text)); }))));
}

function blockNewline(model: Model, block: Block | null): string {
  const ending = block ? /(?:\r\n|\r|\n)$/.exec(model.source.slice(block.from, block.to))?.[0] : undefined;
  return ending ?? lineEnding(model, 0);
}

export function insertTable(model: Model, after: Block | null, rows: number, columns: number, followingParagraph = false): Patch {
  if (!Number.isInteger(rows) || rows < 0 || rows > 50) throw new Error('表格数据行数需为 0–50 的整数。');
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error('表格列数需为 1–12 的整数。');
  const newline = blockNewline(model, after);
  const cells: Cells = { header: Array(columns).fill(''), delimiter: Array(columns).fill('---'), body: Array.from({ length: rows }, () => Array(columns).fill('')) };
  const at = after ? after.to : model.source.length;
  if (after?.type === 'paragraph' && !after.node.content.size && model.source.trim() === '') {
    const grid: Grid = { table: after, header: cells.header, delimiter: cells.delimiter, body: cells.body, aligns: Array(columns).fill('') };
    const edit = { from: model.source.startsWith('\uFEFF') ? 1 : 0, to: model.source.length, insert: [cells.header, cells.delimiter, ...cells.body].map(row => `| ${row.join(' | ')} |`).join(newline) + newline };
    const result = validatedStructure(model, edit, new Transform(model.doc).replaceWith(after.pos, after.pos + after.node.nodeSize, buildTable(grid, cells)).doc).edit;
    return followingParagraph ? withFollowingParagraph(model, result, after.pos) : result;
  }
  const terminated = /(?:\r\n|\r|\n)$/.test(model.source.slice(0, at)) ? newline : newline + newline;
  const edit: Patch = { from: at, to: at, insert: terminated + [cells.header, cells.delimiter, ...cells.body].map(row => `| ${row.join(' | ')} |`).join(newline) + newline };
  const grid: Grid = { table: after ?? model.blocks[0], header: cells.header, delimiter: cells.delimiter, body: cells.body, aligns: Array(columns).fill('') };
  const expected = new Transform(model.doc).insert(after ? after.pos + after.node.nodeSize : model.doc.content.size, buildTable(grid, cells)).doc;
  const result = validatedStructure(model, edit, expected).edit;
  return followingParagraph ? withFollowingParagraph(model, result, after ? after.pos + after.node.nodeSize : model.doc.content.size) : result;
}

// ===== v0.2.5 表格数据层契约（DESIGN 3.2） =====
export type TableFormat = 'gfm' | 'html';
export type CellAlign = TableAlignValue;
export type CellVAlign = TableVAlignValue;
export type TableCellInfo = { id: string; from: number; to: number; text: string; rowspan: number; colspan: number; align: CellAlign; vAlign: CellVAlign };
export type TableInfo = { id: string; format: TableFormat; rows: number; columns: number; widths: number[] | null; widthMismatch: boolean; cells: TableCellInfo[][] };
/** 与 Patch 兼容（main.ts 既有的 structural(...) 调用可直接使用），同时携带格式转换信息。 */
export type TablePatch = Patch & { patch: Patch; converted: boolean; format: TableFormat };

type WidthComment = { from: number; to: number; widths: number[] | null; mismatch: boolean; raw: string };
type TableLayout = { table: Block; node: PMNode; format: TableFormat; textEnd: number; comment: WidthComment | null; columns: number };

// 表格源码行结束位置（不含其后的列宽注释）。
function tableTextEnd(model: Model, table: Block): number {
  let at = table.from;
  for (let index = 0; index < table.node.childCount + 1; index++) {
    const next = model.source.indexOf('\n', at);
    if (next < 0) return model.source.length;
    at = next + 1;
  }
  return at;
}
function tableColumnsOf(node: PMNode): number {
  return nodeGrid(node).columns;
}
function widthCommentOf(model: Model, table: Block, textEnd: number): WidthComment | null {
  const rest = model.source.slice(textEnd, table.to);
  if (!rest) return null;
  const index = rest.indexOf('<!--');
  if (index < 0) return null;
  if (!/^[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)*$/.test(rest.slice(0, index))) return null;
  const match = /^<!--[ \t]*mdre:table-widths[ \t]*:[ \t]*([^>]*?)[ \t]*-->/.exec(rest.slice(index));
  if (!match) return null;
  const from = textEnd + index, to = from + match[0].length;
  const values = parseWidthList(match[1]);
  const mismatch = !values || values.length !== tableColumnsOf(table.node);
  return { from, to, widths: mismatch ? null : values, mismatch, raw: match[0] };
}
function tableLayoutOf(model: Model, table: Block): TableLayout {
  const format: TableFormat = table.node.attrs.format === 'html' ? 'html' : 'gfm';
  const textEnd = tableTextEnd(model, table);
  const comment = format === 'gfm' ? widthCommentOf(model, table, textEnd) : null;
  return { table, node: table.node, format, textEnd, comment, columns: tableColumnsOf(table.node) };
}
function widthLine(widths: number[]): string {
  return `<!-- mdre:table-widths: ${formatWidthList(widths).join(',')} -->`;
}
function tablePatch(edit: Patch, converted: boolean, format: TableFormat): TablePatch {
  return { ...edit, patch: edit, converted, format };
}

// 表格网格：slots[r][c] 为占用该格的单元格扁平序号，flatOf[r][i] 为第 r 行第 i 个源顺序单元格的扁平序号。
type NodeGrid = { columns: number; slots: (number | null)[][]; flatOf: number[][]; rows: number[]; indexes: number[]; columnsOf: number[]; ids: string[] };
function nodeGrid(node: PMNode): NodeGrid {
  const grid: NodeGrid = { columns: 0, slots: [], flatOf: [], rows: [], indexes: [], columnsOf: [], ids: [] };
  let flat = 0;
  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex++) {
    const row = node.child(rowIndex);
    grid.slots[rowIndex] ??= []; grid.flatOf[rowIndex] = [];
    let column = 0;
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex++) {
      while (grid.slots[rowIndex][column] !== undefined && grid.slots[rowIndex][column] !== null) column++;
      const cell = row.child(cellIndex);
      const rowspan = Math.max(1, Number(cell.attrs.rowspan ?? 1)), colspan = Math.max(1, Number(cell.attrs.colspan ?? 1));
      for (let dr = 0; dr < rowspan && rowIndex + dr < node.childCount; dr++) {
        grid.slots[rowIndex + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) grid.slots[rowIndex + dr][column + dc] = flat;
      }
      grid.flatOf[rowIndex][cellIndex] = flat;
      grid.rows[flat] = rowIndex; grid.indexes[flat] = cellIndex; grid.columnsOf[flat] = column; grid.ids[flat] = String(cell.attrs.id ?? '');
      flat++; column += colspan;
      grid.columns = Math.max(grid.columns, column);
    }
  }
  for (const row of grid.slots) grid.columns = Math.max(grid.columns, row.length);
  return grid;
}

function tableRowBlocks(model: Model, table: Block): Block[] {
  return model.blocks.filter(block => block.type === 'table_row' && block.parent === table.id).sort((a, b) => a.from - b.from);
}
function tableCellBlocks(model: Model, row: Block): Block[] {
  return model.blocks.filter(block => block.type === 'table_cell' && block.parent === row.id).sort((a, b) => a.from - b.from);
}
function tableBlockOf(model: Model, tableId: string): Block {
  const table = model.blocks.find(block => block.id === tableId && block.type === 'table');
  if (!table) throw new Error('未找到表格。');
  return table;
}

export function tableIdOfCell(model: Model, cellId: string): string | null {
  const cell = model.blocks.find(block => block.id === cellId && block.type === 'table_cell');
  if (!cell) return null;
  const row = model.blocks.find(block => block.id === cell.parent && block.type === 'table_row');
  if (!row) return null;
  return model.blocks.find(block => block.id === row.parent && block.type === 'table')?.id ?? null;
}

export function readTable(model: Model, tableId: string): TableInfo {
  const table = tableBlockOf(model, tableId);
  const node = table.node;
  const format: TableFormat = node.attrs.format === 'html' ? 'html' : 'gfm';
  const rowBlocks = tableRowBlocks(model, table);
  if (rowBlocks.length !== node.childCount) throw new Error('表格结构损坏，请在源码栏调整。');
  const cells: TableCellInfo[][] = [];
  let columns = 0;
  rowBlocks.forEach((row, _offset, rowIndex) => {
    const cellBlocks = tableCellBlocks(model, row);
    if (cellBlocks.length !== row.node.childCount) throw new Error('表格结构损坏，请在源码栏调整。');
    cells.push(cellBlocks.map(cell => {
      const attrs = cell.node.attrs;
      const raw = model.source.slice(cell.from, cell.to);
      return {
        id: cell.id, from: cell.from, to: cell.to,
        text: format === 'gfm' ? alignedCell(raw).text : raw,
        rowspan: Math.max(1, Number(attrs.rowspan ?? 1)),
        colspan: Math.max(1, Number(attrs.colspan ?? 1)),
        align: String(attrs.cellAlign || attrs.align || '') as CellAlign,
        vAlign: String(attrs.vAlign || '') as CellVAlign,
      };
    }));
    columns = Math.max(columns, cells[cells.length - 1].reduce((sum, cell) => sum + cell.colspan, 0));
    void rowIndex;
  });
  columns = Math.max(columns, nodeGrid(node).columns);
  const stored = Array.isArray(node.attrs.widths) ? node.attrs.widths as number[] : null;
  const widthMismatch = !!(node.attrs.widthMismatch ?? false) || (!!stored && stored.length !== columns);
  return { id: table.id, format, rows: rowBlocks.length, columns, widths: stored && stored.length === columns ? stored.slice() : null, widthMismatch, cells };
}

export function findTable(model: Model, tableId: string): TableInfo | null {
  try { return readTable(model, tableId); } catch { return null; }
}

export function tableWidths(model: Model, tableId: string): number[] | null {
  return findTable(model, tableId)?.widths ?? null;
}

function validateWidths(widths: number[], columns: number): void {
  if (widths.length !== columns) throw new Error(`列宽数量需与表格列数（${columns}）一致。`);
  if (widths.some(width => !Number.isFinite(width) || width <= 0)) throw new Error('列宽必须为正数百分比。');
  const minimum = Math.min(4, 100 / columns);
  if (widths.some(width => width < minimum - 1e-6)) throw new Error(`列宽不能小于 ${Math.round(minimum * 10) / 10}%。`);
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total > 100 + 0.5) throw new Error('列宽之和不能超过 100%。');
}
function fitWidths(widths: number[]): number[] {
  const values = widths.map(width => Math.round(width * 100) / 100);
  const total = values.reduce((sum, width) => sum + width, 0);
  return total > 100 ? values.map(width => Math.round(width * 10000 / total) / 100) : values;
}
function serializedSource(model: Model, node: PMNode, newline: string): string {
  const text = serializeBlock(node, model).replace(/\n/g, newline);
  return text.endsWith(newline) ? text : text + newline;
}
function tableNodeDiffs(expected: PMNode, actual: PMNode | null): string | null {
  if (!actual || actual.type.name !== 'table') return '表格类型';
  const format = String(expected.attrs.format ?? 'gfm');
  if (String(actual.attrs.format ?? 'gfm') !== format) return '表格格式';
  if (JSON.stringify(expected.attrs.widths ?? null) !== JSON.stringify(actual.attrs.widths ?? null)) return '列宽';
  if (!!expected.attrs.widthMismatch !== !!actual.attrs.widthMismatch) return '列宽状态';
  if (expected.childCount !== actual.childCount) return '行数';
  for (let rowIndex = 0; rowIndex < expected.childCount; rowIndex++) {
    const expectedRow = expected.child(rowIndex), actualRow = actual.child(rowIndex);
    if (expectedRow.childCount !== actualRow.childCount) return '单元格数';
    for (let cellIndex = 0; cellIndex < expectedRow.childCount; cellIndex++) {
      const a = expectedRow.child(cellIndex), b = actualRow.child(cellIndex);
      if (!!a.attrs.header !== !!b.attrs.header || Number(a.attrs.rowspan ?? 1) !== Number(b.attrs.rowspan ?? 1)
        || Number(a.attrs.colspan ?? 1) !== Number(b.attrs.colspan ?? 1)
        || String(a.attrs.cellAlign || a.attrs.align || '') !== String(b.attrs.cellAlign || b.attrs.align || '')
        || String(a.attrs.vAlign || '') !== String(b.attrs.vAlign || '')
        || a.textContent !== b.textContent) return '单元格内容';
    }
  }
  return null;
}
// 整表回写：序列化规范源码后重新解析，并以结构事实（行/列/跨度/对齐/文字）校验。
function commitTableNode(model: Model, table: Block, nextTable: PMNode, converted: boolean): TablePatch {
  if (nextTable.type.name !== 'table') throw new Error('表格结构损坏，请在源码栏调整。');
  const newline = lineEnding(model, table.from);
  const edit: Patch = { from: table.from, to: table.to, insert: serializedSource(model, nextTable, newline) };
  const next = parse(model.source.slice(0, edit.from) + edit.insert + model.source.slice(edit.to), model, edit);
  const failure = tableNodeDiffs(nextTable, next.doc.nodeAt(table.pos));
  if (failure) throw new Error(`表格${failure}写回校验失败，请使用源码栏调整。`);
  return tablePatch(edit, converted, nextTable.attrs.format === 'html' ? 'html' : 'gfm');
}
function mapTableCells(node: PMNode, update: (cell: PMNode) => PMNode): PMNode {
  const rows: PMNode[] = [];
  node.forEach(row => {
    const cells: PMNode[] = [];
    row.forEach(cell => cells.push(update(cell)));
    rows.push(row.type.create(row.attrs, cells));
  });
  return node.type.create(node.attrs, rows);
}
function toHtmlFormat(node: PMNode): PMNode {
  const rows: PMNode[] = [];
  node.forEach(row => {
    const cells: PMNode[] = [];
    row.forEach(cell => cells.push(cell.type.create({
      ...cell.attrs,
      align: String(cell.attrs.cellAlign || cell.attrs.align || ''),
      cellAlign: null, rowspan: 1, colspan: 1, vAlign: cell.attrs.vAlign || '',
    }, cell.content)));
    rows.push(row.type.create({ ...row.attrs, header: cells.every(cell => !!cell.attrs.header) }, cells));
  });
  return node.type.create({ ...node.attrs, format: 'html', widthMismatch: false }, rows);
}
function emptyCell(template: PMNode | null, header: boolean): PMNode {
  return schema.nodes.table_cell.create({
    id: '', header,
    align: String(template?.attrs.align ?? ''), cellAlign: null, rowspan: 1, colspan: 1, vAlign: String(template?.attrs.vAlign ?? ''),
  });
}
function templateCellOf(node: PMNode): PMNode | null {
  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex++) {
    const row = node.child(rowIndex);
    if (row.childCount) return row.child(0);
  }
  return null;
}

// ---- GFM 结构操作：行/列增删与列宽注释同步 ----
function writeGrid(model: Model, grid: Grid, cells: Cells, options: { widths?: number[] | null } = {}): Patch {
  const layout = tableLayoutOf(model, grid.table);
  const newline = lineEnding(model, grid.table.from);
  const rows = [cells.header, cells.delimiter, ...cells.body];
  const tableText = rows.map(row => `| ${row.join(' | ')} |`).join(newline) + newline;
  const columnChange = cells.header.length !== layout.columns;
  const stored = Array.isArray(grid.table.node.attrs.widths) ? grid.table.node.attrs.widths as number[] : null;
  let widths: number[] | null;
  let widthMismatch = false;
  if (columnChange) {
    // 列数变化：同步列宽注释；原注释失配时回退自动布局（清除注释）。
    widths = options.widths === undefined ? stored : options.widths;
    if (layout.comment?.mismatch || !widths || widths.length !== cells.header.length) widths = null;
  } else {
    if (layout.comment?.mismatch) { widths = null; widthMismatch = true; }
    else widths = layout.comment ? layout.comment.widths : stored;
  }
  if (widths && widths.length !== cells.header.length) widths = null;
  let edit: Patch;
  if (columnChange) {
    // 表格块区间已包含注释与其行尾换行，整体替换避免留下多余空行。
    const to = layout.comment ? layout.table.to : layout.textEnd;
    edit = { from: grid.table.from, to, insert: tableText + (widths ? widthLine(widths) + newline : '') };
  } else {
    edit = { from: grid.table.from, to: layout.textEnd, insert: tableText };
  }
  const attrs = { ...grid.table.node.attrs, widths: widths ?? null, widthMismatch };
  validated(model, edit, new Transform(model.doc).replaceWith(grid.table.pos, grid.table.pos + grid.table.node.nodeSize, buildTable(grid, cells, attrs)).doc);
  return edit;
}
function locate(model: Model, cellId: string): { grid: Grid; rowIndex: number; column: number } {
  const cell = model.blocks.find(b => b.id === cellId && b.type === 'table_cell');
  if (!cell) throw new Error('未找到表格单元格。');
  const row = model.blocks.find(b => b.id === cell.parent && b.type === 'table_row');
  if (!row) throw new Error('未找到表格行。');
  const table = model.blocks.find(b => b.id === row.parent && b.type === 'table');
  if (!table) throw new Error('未找到表格。');
  const rows = model.blocks.filter(b => b.type === 'table_row' && b.parent === table.id).sort((a, b) => a.from - b.from);
  const columns = model.blocks.filter(b => b.type === 'table_cell' && b.parent === row.id).sort((a, b) => a.from - b.from);
  return { grid: readGrid(model, table), rowIndex: rows.indexOf(row), column: columns.indexOf(cell) };
}
function cellTableId(model: Model, cellId: string): string {
  const tableId = tableIdOfCell(model, cellId);
  if (!tableId) throw new Error('请先在表格单元格内操作。');
  return tableId;
}

// ---- HTML 结构操作：按网格调整跨度 ----
function insertHtmlRow(model: Model, table: Block, cellId: string, offset: 0 | 1): Patch {
  const node = table.node, grid = nodeGrid(node);
  const flat = grid.ids.indexOf(cellId);
  if (flat < 0) throw new Error('未找到表格单元格。');
  const origin = grid.rows[flat];
  const boundary = origin === 0 ? 1 : offset === 1 ? origin + 1 : origin;
  const occupied = new Map<number, number>();
  for (let index = 0; index < grid.ids.length; index++) {
    const start = grid.rows[index];
    const cell = node.child(start).child(grid.indexes[index]);
    const rowspan = Math.max(1, Number(cell.attrs.rowspan ?? 1)), colspan = Math.max(1, Number(cell.attrs.colspan ?? 1));
    if (rowspan > 1 && start < boundary && start + rowspan > boundary) {
      for (let dc = 0; dc < colspan; dc++) occupied.set(grid.columnsOf[index] + dc, index);
    }
  }
  const rows: PMNode[] = [];
  const insertRowNode = () => {
    const cells: PMNode[] = [];
    const template = templateCellOf(node);
    for (let column = 0; column < grid.columns; column++) if (!occupied.has(column)) cells.push(emptyCell(template, false));
    // 整行都被上方跨行单元格覆盖时插入空行（HTML 允许 tr 不含单元格）。
    rows.push(schema.nodes.table_row.create({ id: '', header: false }, cells));
  };
  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex++) {
    if (rowIndex === boundary) insertRowNode();
    const row = node.child(rowIndex);
    const cells: PMNode[] = [];
    row.forEach((cell, _offset, cellIndex) => {
      const index = grid.flatOf[rowIndex][cellIndex];
      if (occupied.get(grid.columnsOf[index]) === index) {
        cells.push(cell.type.create({ ...cell.attrs, rowspan: Math.max(1, Number(cell.attrs.rowspan ?? 1)) + 1 }, cell.content));
      } else cells.push(cell);
    });
    rows.push(row.type.create(row.attrs, cells));
  }
  if (boundary >= node.childCount) insertRowNode();
  return commitTableNode(model, table, node.type.create(node.attrs, rows), false).patch;
}
function removeHtmlRow(model: Model, table: Block, cellId: string): Patch {
  const node = table.node, grid = nodeGrid(node);
  const flat = grid.ids.indexOf(cellId);
  if (flat < 0) throw new Error('未找到表格单元格。');
  const rowIndex = grid.rows[flat];
  const row = node.child(rowIndex);
  if (rowIndex === 0 && row.childCount > 0 && row.child(0).attrs.header) throw new Error('表头行不可删除，请在源码栏调整。');
  const crossing = (grid.slots[rowIndex] ?? []).find(index => index !== null && index !== undefined && grid.rows[index] !== rowIndex);
  if (crossing !== undefined && crossing !== null) throw new Error('该行存在跨行合并单元格，无法删除；请先拆分单元格。');
  let spanned = false;
  row.forEach(cell => { if (Number(cell.attrs.rowspan ?? 1) > 1) spanned = true; });
  if (spanned) throw new Error('该行包含跨行合并单元格，无法删除；请先拆分单元格。');
  if (node.childCount <= 1) throw new Error('表格至少保留一行。');
  const rows: PMNode[] = [];
  for (let index = 0; index < node.childCount; index++) if (index !== rowIndex) rows.push(node.child(index));
  return commitTableNode(model, table, node.type.create(node.attrs, rows), false).patch;
}
function insertHtmlColumn(model: Model, table: Block, cellId: string, offset: 0 | 1): Patch {
  const node = table.node, grid = nodeGrid(node);
  const flat = grid.ids.indexOf(cellId);
  if (flat < 0) throw new Error('未找到表格单元格。');
  const column = grid.columnsOf[flat] + offset;
  if (grid.columns >= 12) throw new Error('表格最多 12 列。');
  const rows: PMNode[] = [];
  node.forEach((row, _offset, rowIndex) => {
    const entries: { column: number; cell: PMNode }[] = [];
    const headerRow = rowIndex === 0 && row.childCount > 0 && Array.from({ length: row.childCount }, (_, index) => row.child(index).attrs.header).every(Boolean);
    row.forEach((cell, _offset, cellIndex) => {
      const start = grid.columnsOf[grid.flatOf[rowIndex][cellIndex]];
      const colspan = Math.max(1, Number(cell.attrs.colspan ?? 1));
      entries.push({ column: start, cell: start < column && start + colspan > column ? cell.type.create({ ...cell.attrs, colspan: colspan + 1 }, cell.content) : cell });
    });
    const crossing = entries.some(entry => entry.column < column && entry.column + Math.max(1, Number(entry.cell.attrs.colspan ?? 1)) > column);
    const coveredSlot = grid.slots[rowIndex]?.[column];
    const coveredByAbove = coveredSlot !== undefined && coveredSlot !== null && grid.rows[coveredSlot] < rowIndex
      && grid.columnsOf[coveredSlot] < column
      && grid.columnsOf[coveredSlot] + Math.max(1, Number(node.child(grid.rows[coveredSlot]).child(grid.indexes[coveredSlot]).attrs.colspan ?? 1)) > column;
    if (!crossing && !coveredByAbove && row.childCount > 0) {
      const template = templateCellOf(node);
      const at = entries.findIndex(entry => entry.column >= column);
      entries.splice(at < 0 ? entries.length : at, 0, { column, cell: emptyCell(template, headerRow) });
    }
    entries.sort((a, b) => a.column - b.column);
    rows.push(row.type.create(row.attrs, entries.map(entry => entry.cell)));
  });
  // HTML 表格的列宽存在 colgroup 中，插列时同步比例（总宽不超 100）。
  const stored = Array.isArray(node.attrs.widths) ? node.attrs.widths as number[] : null;
  const widths = stored && stored.length === grid.columns
    ? fitWidths([...stored.slice(0, column), Math.round(10000 / (grid.columns + 1)) / 100, ...stored.slice(column)])
    : null;
  return commitTableNode(model, table, node.type.create({ ...node.attrs, widths }, rows), false).patch;
}
function removeHtmlColumn(model: Model, table: Block, cellId: string): Patch {
  const node = table.node, grid = nodeGrid(node);
  const flat = grid.ids.indexOf(cellId);
  if (flat < 0) throw new Error('未找到表格单元格。');
  const column = grid.columnsOf[flat];
  if (grid.columns <= 1) throw new Error('表格至少保留一列。');
  const rows: PMNode[] = [];
  node.forEach((row, _offset, rowIndex) => {
    const cells: PMNode[] = [];
    row.forEach((cell, _offset, cellIndex) => {
      const start = grid.columnsOf[grid.flatOf[rowIndex][cellIndex]];
      const colspan = Math.max(1, Number(cell.attrs.colspan ?? 1));
      if (start <= column && column < start + colspan) {
        if (colspan > 1) cells.push(cell.type.create({ ...cell.attrs, colspan: colspan - 1 }, cell.content));
      } else cells.push(cell);
    });
    // 被跨行合并覆盖的空行不产单元格；内容随删除列丢失属于删除列的正常结果。
    rows.push(row.type.create(row.attrs, cells));
  });
  const stored = Array.isArray(node.attrs.widths) ? node.attrs.widths as number[] : null;
  const widths = stored && stored.length === grid.columns ? stored.filter((_, index) => index !== column) : null;
  return commitTableNode(model, table, node.type.create({ ...node.attrs, widths }, rows), false).patch;
}

export function insertRow(model: Model, cellId: string, offset: 0 | 1): Patch {
  const tableId = cellTableId(model, cellId);
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') return insertHtmlRow(model, table, cellId, offset);
  const { grid, rowIndex } = locate(model, cellId);
  const index = rowIndex === 0 ? 0 : rowIndex - 1 + offset;
  const body = grid.body.slice();
  body.splice(Math.max(0, Math.min(body.length, index)), 0, Array(grid.header.length).fill(''));
  return writeGrid(model, grid, { header: grid.header, delimiter: grid.delimiter, body });
}

export function removeRow(model: Model, cellId: string): Patch {
  const tableId = cellTableId(model, cellId);
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') return removeHtmlRow(model, table, cellId);
  const { grid, rowIndex } = locate(model, cellId);
  if (rowIndex === 0) throw new Error('表头行不可删除，请在源码栏调整。');
  return writeGrid(model, grid, { header: grid.header, delimiter: grid.delimiter, body: grid.body.filter((_, index) => index !== rowIndex - 1) });
}

export function insertColumn(model: Model, cellId: string, offset: 0 | 1): Patch {
  const tableId = cellTableId(model, cellId);
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') return insertHtmlColumn(model, table, cellId, offset);
  const { grid, column } = locate(model, cellId);
  if (grid.header.length >= 12) throw new Error('表格最多 12 列。');
  const at = column + offset;
  const insert = <T,>(cells: T[], value: T): T[] => [...cells.slice(0, at), value, ...cells.slice(at)];
  const aligns = [...grid.aligns.slice(0, at), '', ...grid.aligns.slice(at)];
  const stored = Array.isArray(table.node.attrs.widths) ? table.node.attrs.widths as number[] : null;
  const widths = stored && stored.length === grid.header.length
    ? fitWidths(insert(stored, Math.round(10000 / (grid.header.length + 1)) / 100))
    : null;
  return writeGrid(model, { ...grid, aligns }, {
    header: insert(grid.header, ''),
    delimiter: insert(grid.delimiter, '---'),
    body: grid.body.map(cells => insert(cells, '')),
  }, { widths });
}

export function removeColumn(model: Model, cellId: string): Patch {
  const tableId = cellTableId(model, cellId);
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') return removeHtmlColumn(model, table, cellId);
  const { grid, column } = locate(model, cellId);
  if (grid.header.length <= 1) throw new Error('表格至少保留一列。');
  const drop = <T,>(cells: T[]): T[] => cells.filter((_, index) => index !== column);
  const stored = Array.isArray(table.node.attrs.widths) ? table.node.attrs.widths as number[] : null;
  const widths = stored && stored.length === grid.header.length ? drop(stored) : null;
  return writeGrid(model, { ...grid, aligns: drop(grid.aligns) }, { header: drop(grid.header), delimiter: drop(grid.delimiter), body: grid.body.map(drop) }, { widths });
}

export function setTableCell(model: Model, cellId: string, text: string): Patch {
  const cell = model.blocks.find(b => b.id === cellId && b.type === 'table_cell');
  if (!cell) throw new Error('未找到表格单元格。');
  const value = text.replace(/[\r\n]+/g, ' ').trim();
  const htmlTable = tableIdOfCell(model, cellId);
  if (htmlTable && tableBlockOf(model, htmlTable).node.attrs.format === 'html') {
    // HTML 单元格内层写规范的等价 HTML，避免导出时把 Markdown 语法显示成原文；只替换内层区间以保留块 ID。
    const nextCell = schema.nodes.table_cell.create({ ...cell.node.attrs }, inlineContent(value));
    const edit: Patch = { from: cell.from, to: cell.to, insert: htmlInlineContent(nextCell) };
    const next = parse(patch(model.source, edit), model, edit);
    const target = next.blocks.find(block => block.id === cell.id && block.type === 'table_cell');
    if (!target || target.node.textContent !== nextCell.textContent) throw new Error('表格单元格内容无法可靠写回 HTML，请使用源码栏调整。');
    return edit;
  }
  // 空单元格在裁剪后 from===to；从该点写入可让新单元格起点与补丁起点一致，保留块 ID（确认后仍回到该格）。
  const empty = cell.from === cell.to;
  const edit: Patch = { from: cell.from, to: cell.to, insert: wrapCell(value.replace(/\|/g, '\\|'), cell.node.attrs.cellAlign) + (empty ? ' ' : '') };
  const node = schema.nodes.table_cell.create({ ...cell.node.attrs }, inlineContent(value));
  validated(model, edit, new Transform(model.doc).replaceWith(cell.pos, cell.pos + cell.node.nodeSize, node).doc);
  return edit;
}

export function setCellAlignment(model: Model, cellId: string, align: CellAlignment): Patch {
  return setCellsAlignment(model, [cellId], align);
}

// 一次事务修改多个单元格，未选择的格子逐字保留，撤销也只需一次。
// v0.2.5：保持 Patch 返回类型兼容 main.ts；html 表格写单元格样式并整表回写。
export function setCellsAlignment(model: Model, cellIds: string[], align: CellAlignment): Patch {
  const cells = model.blocks.filter(block => block.type === 'table_cell' && cellIds.includes(block.id)).sort((a,b) => a.from - b.from);
  if (!cells.length) throw new Error('请先选择表格单元格。');
  const tableIds = new Set(cells.map(cell => tableIdOfCell(model, cell.id)));
  if (tableIds.size > 1) throw new Error('请选择同一个表格内的单元格。');
  const tableId = [...tableIds][0];
  if (!tableId) throw new Error('未找到表格。');
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') {
    const targets = new Set(cells.map(cell => cell.id));
    const next = mapTableCells(table.node, cell => targets.has(String(cell.attrs.id))
      ? cell.type.create({ ...cell.attrs, align, cellAlign: null }, cell.content) : cell);
    return commitTableNode(model, table, next, false).patch;
  }
  const from = cells[0].from, to = cells.at(-1)!.to;
  let insert = model.source.slice(from, to);
  const transform = new Transform(model.doc);
  for (const cell of [...cells].reverse()) {
    const text = alignedCell(model.source.slice(cell.from, cell.to)).text;
    insert = insert.slice(0, cell.from - from) + wrapCell(text, align) + (cell.from === cell.to ? ' ' : '') + insert.slice(cell.to - from);
    transform.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, cellAlign: align });
  }
  return validated(model, { from, to, insert }, transform.doc).edit;
}

// v0.2.5：GFM 表格的水平对齐按规划写分隔行（整列生效），并清除受影响列的旧式行内对齐包裹；
// HTML 表格写单元格 text-align 样式。既有 setCellsAlignment 保持原行为兼容。
export function setColumnsAlignment(model: Model, cellIds: string[], align: CellAlignment): Patch {
  const cells = model.blocks.filter(block => block.type === 'table_cell' && cellIds.includes(block.id)).sort((a, b) => a.from - b.from);
  if (!cells.length) throw new Error('请先选择表格单元格。');
  const tableIds = new Set(cells.map(cell => tableIdOfCell(model, cell.id)));
  if (tableIds.size > 1) throw new Error('请选择同一个表格内的单元格。');
  const tableId = [...tableIds][0];
  if (!tableId) throw new Error('未找到表格。');
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format === 'html') {
    const targets = new Set(cells.map(cell => cell.id));
    const next = mapTableCells(table.node, cell => targets.has(String(cell.attrs.id))
      ? cell.type.create({ ...cell.attrs, align, cellAlign: null }, cell.content) : cell);
    return commitTableNode(model, table, next, false).patch;
  }
  const grid = readGrid(model, table);
  const rowBlocks = tableRowBlocks(model, table);
  const columns = new Set<number>();
  for (const cell of cells) {
    const rowIndex = rowBlocks.findIndex(row => row.id === cell.parent);
    if (rowIndex < 0) continue;
    const column = tableCellBlocks(model, rowBlocks[rowIndex]).findIndex(item => item.id === cell.id);
    if (column >= 0 && column < grid.header.length) columns.add(column);
  }
  if (!columns.size) throw new Error('未找到可对齐的表格列。');
  const marker = { left: ':---', right: '---:', center: ':---:' }[align];
  const strip = (text: string) => alignedCell(text).text;
  const clean = (row: string[]) => row.map((text, column) => columns.has(column) ? strip(text) : text);
  const delimiter = grid.delimiter.map((text, column) => columns.has(column) ? marker : text);
  const header = clean(grid.header);
  const body = grid.body.map(clean);
  return writeGrid(model, { ...grid, aligns: grid.aligns.map((value, column) => columns.has(column) ? align : value) }, { header, delimiter, body });
}

export function setColumnWidths(model: Model, tableId: string, widths: number[] | null): TablePatch {
  const table = tableBlockOf(model, tableId);
  const layout = tableLayoutOf(model, table);
  if (widths) validateWidths(widths, layout.columns);
  if (layout.format === 'html') {
    const next = table.node.type.create({ ...table.node.attrs, widths: widths ? widths.slice() : null, widthMismatch: false }, table.node.content);
    return commitTableNode(model, table, next, false);
  }
  const newline = lineEnding(model, table.from);
  const stored = Array.isArray(table.node.attrs.widths) ? table.node.attrs.widths as number[] : null;
  let edit: Patch | null = null;
  if (widths) {
    const line = widthLine(widths);
    if (layout.comment) edit = { from: layout.comment.from, to: layout.comment.to, insert: line };
    else {
      const prefix = layout.textEnd > 0 && /(?:\r\n|\r|\n)$/.test(model.source.slice(0, layout.textEnd)) ? '' : newline;
      edit = { from: layout.textEnd, to: layout.textEnd, insert: prefix + line + newline };
    }
  } else if (layout.comment) {
    // 删除注释整行（含行尾换行），恢复自动布局。
    let to = layout.comment.to;
    const ending = /^(?:\r\n|\r|\n)/.exec(model.source.slice(to))?.[0];
    if (ending) to += ending.length;
    edit = { from: layout.comment.from, to, insert: '' };
  }
  const expected = new Transform(model.doc).setNodeMarkup(table.pos, undefined, { ...table.node.attrs, widths: widths ? widths.slice() : null, widthMismatch: false }).doc;
  if (edit) validated(model, edit, expected);
  else {
    // 无注释且需要自动布局：确认当前模型确实没有列宽。
    if (stored) edit = { from: 0, to: 0, insert: '' };
  }
  return tablePatch(edit ?? { from: 0, to: 0, insert: '' }, false, 'gfm');
}

export function setVerticalAlign(model: Model, cellIds: string[], middle: boolean): TablePatch {
  if (!cellIds.length) throw new Error('请先选择表格单元格。');
  const tableIds = new Set(cellIds.map(cellId => tableIdOfCell(model, cellId)));
  if (tableIds.size > 1) throw new Error('请选择同一个表格内的单元格。');
  const tableId = [...tableIds][0];
  if (!tableId) throw new Error('未找到表格。');
  const table = tableBlockOf(model, tableId);
  const targets = new Set(cellIds);
  if (table.node.attrs.format !== 'html') {
    if (!middle) return tablePatch({ from: 0, to: 0, insert: '' }, false, 'gfm');
    const next = mapTableCells(toHtmlFormat(table.node), cell => targets.has(String(cell.attrs.id))
      ? cell.type.create({ ...cell.attrs, vAlign: 'middle' }, cell.content) : cell);
    return commitTableNode(model, table, next, true);
  }
  const next = mapTableCells(table.node, cell => targets.has(String(cell.attrs.id))
    ? cell.type.create({ ...cell.attrs, vAlign: middle ? 'middle' : '' }, cell.content) : cell);
  return commitTableNode(model, table, next, false);
}

export function mergeCells(model: Model, cellIds: string[]): TablePatch {
  if (cellIds.length < 2) throw new Error('请选择至少两个单元格再合并。');
  const tableIds = new Set(cellIds.map(cellId => tableIdOfCell(model, cellId)));
  if (tableIds.size > 1) throw new Error('只能合并同一个表格内的单元格。');
  const tableId = [...tableIds][0];
  if (!tableId) throw new Error('未找到表格。');
  const table = tableBlockOf(model, tableId);
  const info = readTable(model, tableId);
  const node = info.format === 'gfm' ? toHtmlFormat(table.node) : table.node;
  const grid = nodeGrid(node);
  const selected = cellIds.map(cellId => grid.ids.indexOf(cellId));
  if (selected.some(flat => flat < 0)) throw new Error('未找到要合并的单元格。');
  const selectedSet = new Set(selected);
  let minRow = Infinity, maxRow = -1, minColumn = Infinity, maxColumn = -1;
  for (const flat of selected) {
    minRow = Math.min(minRow, grid.rows[flat]); maxRow = Math.max(maxRow, grid.rows[flat]);
    minColumn = Math.min(minColumn, grid.columnsOf[flat]); maxColumn = Math.max(maxColumn, grid.columnsOf[flat]);
  }
  const covered = new Set<number>();
  for (let row = minRow; row <= maxRow; row++) {
    for (let column = minColumn; column <= maxColumn; column++) {
      const flat = grid.slots[row]?.[column];
      if (flat === undefined || flat === null) throw new Error('合并只接受矩形区域，请重新选择。');
      covered.add(flat);
    }
  }
  if (covered.size !== selectedSet.size || [...covered].some(flat => !selectedSet.has(flat))) throw new Error('合并只接受矩形区域，请重新选择。');
  const ordered = [...selected].sort((a, b) => grid.rows[a] - grid.rows[b] || grid.columnsOf[a] - grid.columnsOf[b]);
  const top = ordered[0];
  const contents: PMNode[] = [];
  for (const flat of ordered) {
    const cell = node.child(grid.rows[flat]).child(grid.indexes[flat]);
    if (!cell.content.size) continue;
    if (contents.length) contents.push(schema.nodes.hard_break.create());
    cell.content.forEach(child => contents.push(child));
  }
  const rows: PMNode[] = [];
  node.forEach((row, _offset, rowIndex) => {
    const cells: PMNode[] = [];
    row.forEach((cell, _offset, cellIndex) => {
      const flat = grid.flatOf[rowIndex][cellIndex];
      if (covered.has(flat) && flat !== top) return;
      if (flat === top) cells.push(cell.type.create({ ...cell.attrs, rowspan: maxRow - minRow + 1, colspan: maxColumn - minColumn + 1 }, contents));
      else cells.push(cell);
    });
    rows.push(row.type.create(row.attrs, cells));
  });
  return commitTableNode(model, table, node.type.create(node.attrs, rows), info.format === 'gfm');
}

export function splitCell(model: Model, cellId: string): TablePatch {
  const tableId = tableIdOfCell(model, cellId);
  if (!tableId) throw new Error('请先在表格单元格内操作。');
  const table = tableBlockOf(model, tableId);
  if (table.node.attrs.format !== 'html') throw new Error('该单元格没有合并，无需拆分。');
  const node = table.node, grid = nodeGrid(node);
  const flat = grid.ids.indexOf(cellId);
  if (flat < 0) throw new Error('未找到表格单元格。');
  const cell = node.child(grid.rows[flat]).child(grid.indexes[flat]);
  const rowspan = Math.max(1, Number(cell.attrs.rowspan ?? 1)), colspan = Math.max(1, Number(cell.attrs.colspan ?? 1));
  if (rowspan === 1 && colspan === 1) throw new Error('该单元格没有合并，无需拆分。');
  const startRow = grid.rows[flat], startColumn = grid.columnsOf[flat];
  const rows: PMNode[] = [];
  node.forEach((row, _offset, rowIndex) => {
    if (rowIndex < startRow || rowIndex >= startRow + rowspan) { rows.push(row); return; }
    const entries: { column: number; cell: PMNode }[] = [];
    row.forEach((item, _offset, cellIndex) => {
      const index = grid.flatOf[rowIndex][cellIndex];
      entries.push({ column: grid.columnsOf[index], cell: index === flat ? item.type.create({ ...item.attrs, rowspan: 1, colspan: 1 }, item.content) : item });
    });
    for (let column = startColumn; column < startColumn + colspan; column++) {
      if (rowIndex === startRow && column === startColumn) continue;
      if (grid.slots[rowIndex]?.[column] !== flat) continue;
      entries.push({ column, cell: emptyCell(cell, !!cell.attrs.header) });
    }
    entries.sort((a, b) => a.column - b.column);
    rows.push(row.type.create(row.attrs, entries.map(entry => entry.cell)));
  });
  return commitTableNode(model, table, node.type.create(node.attrs, rows), false);
}

export function canConvertToMarkdownTable(model: Model, tableId: string): boolean {
  const info = findTable(model, tableId);
  if (!info || info.format !== 'html') return false;
  return info.cells.every(row => row.every(cell => cell.rowspan === 1 && cell.colspan === 1 && !cell.vAlign));
}

export function convertToMarkdownTable(model: Model, tableId: string): TablePatch {
  if (!canConvertToMarkdownTable(model, tableId)) throw new Error('仅无合并、无上下居中的 HTML 表格可转换为 Markdown 表格。');
  const table = tableBlockOf(model, tableId);
  const node = table.node, grid = nodeGrid(node);
  const columns = grid.columns;
  // 分隔行对齐只取每列首行单元格样式；同一列内混合对齐无法在 GFM 分隔行表达，按左对齐处理。
  const columnAlign: CellAlignment[] = [];
  for (let column = 0; column < columns; column++) {
    const flat = grid.slots[0]?.[column];
    const align = flat === undefined || flat === null ? '' : String(node.child(0).child(grid.indexes[flat]).attrs.cellAlign || node.child(0).child(grid.indexes[flat]).attrs.align || '');
    columnAlign.push(align as CellAlignment);
  }
  const gfmRows: PMNode[] = [];
  node.forEach((row, _offset, rowIndex) => {
    const cells: PMNode[] = [];
    row.forEach((cell, _offset, cellIndex) => {
      const column = grid.columnsOf[grid.flatOf[rowIndex][cellIndex]];
      cells.push(cell.type.create({
        ...cell.attrs, header: rowIndex === 0, align: columnAlign[column] ?? '', cellAlign: null, rowspan: 1, colspan: 1, vAlign: '',
      }, cell.content));
    });
    gfmRows.push(row.type.create({ id: '', header: rowIndex === 0 }, cells));
  });
  const widths = Array.isArray(node.attrs.widths) && (node.attrs.widths as number[]).length === columns ? node.attrs.widths as number[] : null;
  const next = schema.nodes.table.create({ id: node.attrs.id, format: 'gfm', widths, widthMismatch: false }, gfmRows);
  const newline = lineEnding(model, table.from);
  const edit: Patch = { from: table.from, to: table.to, insert: serializedSource(model, next, newline) };
  const parsed = parse(model.source.slice(0, edit.from) + edit.insert + model.source.slice(edit.to), model, edit);
  const failure = tableNodeDiffs(next, parsed.doc.nodeAt(table.pos));
  if (failure) throw new Error(`表格${failure}写回校验失败，请使用源码栏调整。`);
  return tablePatch(edit, false, 'gfm');
}
