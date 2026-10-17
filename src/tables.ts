import { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { cellSpans, parse, schema, type Block, type Model } from './model';
import { validated, validatedStructure, type Patch } from './edits';
import { lineEnding, withFollowingParagraph } from './blocks';
import { alignedCell, wrapCell, type CellAlignment } from './table-alignment';

type Grid = { table: Block; header: string[]; delimiter: string[]; body: string[][]; aligns: string[] };
type Cells = { header: string[]; delimiter: string[]; body: string[][] };

function readGrid(model: Model, table: Block): Grid {
  const lines: { from: number; to: number }[] = [];
  let at = table.from;
  while (at < table.to) {
    const index = model.source.indexOf('\n', at);
    const end = index < 0 || index + 1 > table.to ? table.to : index + 1;
    lines.push({ from: at, to: end });
    at = end;
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

function buildTable(grid: Grid, cells: Cells): PMNode {
  const rows = [cells.header, ...cells.body];
  return schema.nodes.table.create({ id: '' }, rows.map((row, index) => schema.nodes.table_row.create({ id: '', header: index === 0 },
    row.map((text, column) => { const cell = alignedCell(text); return schema.nodes.table_cell.create({ id: '', header: index === 0, align: grid.aligns[column] ?? '', cellAlign: cell.align }, inlineContent(cell.text)); }))));
}

function writeGrid(model: Model, grid: Grid, cells: Cells): Patch {
  const newline = lineEnding(model, grid.table.from);
  const rows = [cells.header, cells.delimiter, ...cells.body];
  const edit: Patch = { from: grid.table.from, to: grid.table.to, insert: rows.map(row => `| ${row.join(' | ')} |`).join(newline) + newline };
  validated(model, edit, new Transform(model.doc).replaceWith(grid.table.pos, grid.table.pos + grid.table.node.nodeSize, buildTable(grid, cells)).doc);
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

export function insertRow(model: Model, cellId: string, offset: 0 | 1): Patch {
  const { grid, rowIndex } = locate(model, cellId);
  const index = rowIndex === 0 ? 0 : rowIndex - 1 + offset;
  const body = grid.body.slice();
  body.splice(Math.max(0, Math.min(body.length, index)), 0, Array(grid.header.length).fill(''));
  return writeGrid(model, grid, { header: grid.header, delimiter: grid.delimiter, body });
}

export function removeRow(model: Model, cellId: string): Patch {
  const { grid, rowIndex } = locate(model, cellId);
  if (rowIndex === 0) throw new Error('表头行不可删除，请在源码栏调整。');
  return writeGrid(model, grid, { header: grid.header, delimiter: grid.delimiter, body: grid.body.filter((_, index) => index !== rowIndex - 1) });
}

export function insertColumn(model: Model, cellId: string, offset: 0 | 1): Patch {
  const { grid, column } = locate(model, cellId);
  if (grid.header.length >= 12) throw new Error('表格最多 12 列。');
  const at = column + offset;
  const insert = <T,>(cells: T[], value: T): T[] => [...cells.slice(0, at), value, ...cells.slice(at)];
  const aligns = [...grid.aligns.slice(0, at), '', ...grid.aligns.slice(at)];
  return writeGrid(model, { ...grid, aligns }, {
    header: insert(grid.header, ''),
    delimiter: insert(grid.delimiter, '---'),
    body: grid.body.map(cells => insert(cells, '')),
  });
}

export function removeColumn(model: Model, cellId: string): Patch {
  const { grid, column } = locate(model, cellId);
  if (grid.header.length <= 1) throw new Error('表格至少保留一列。');
  const drop = <T,>(cells: T[]): T[] => cells.filter((_, index) => index !== column);
  return writeGrid(model, { ...grid, aligns: drop(grid.aligns) }, { header: drop(grid.header), delimiter: drop(grid.delimiter), body: grid.body.map(drop) });
}

export function setTableCell(model: Model, cellId: string, text: string): Patch {
  const cell = model.blocks.find(b => b.id === cellId && b.type === 'table_cell');
  if (!cell) throw new Error('未找到表格单元格。');
  const value = text.replace(/[\r\n]+/g, ' ').trim();
  // 空单元格在裁剪后 from===to；从该点写入可让新单元格起点与补丁起点一致，保留块 ID（确认后仍回到该格）。
  const empty = cell.from === cell.to;
  const edit: Patch = { from: cell.from, to: cell.to, insert: wrapCell(value.replace(/\|/g, '\\|'), cell.node.attrs.cellAlign) + (empty ? ' ' : '') };
  const node = schema.nodes.table_cell.create({ ...cell.node.attrs }, inlineContent(value));
  validated(model, edit, new Transform(model.doc).replaceWith(cell.pos, cell.pos + cell.node.nodeSize, node).doc);
  return edit;
}

export function setCellAlignment(model: Model, cellId: string, align: CellAlignment): Patch {
  const cell = model.blocks.find(block => block.id === cellId && block.type === 'table_cell');
  if (!cell) throw new Error('未找到表格单元格。');
  const text = alignedCell(model.source.slice(cell.from, cell.to)).text;
  const edit = { from: cell.from, to: cell.to, insert: wrapCell(text, align) + (cell.from === cell.to ? ' ' : '') };
  const expected = new Transform(model.doc).setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, cellAlign: align }).doc;
  return validated(model, edit, expected).edit;
}

// 一次事务修改多个单元格，未选择的格子逐字保留，撤销也只需一次。
export function setCellsAlignment(model: Model, cellIds: string[], align: CellAlignment): Patch {
  const cells = model.blocks.filter(block => block.type === 'table_cell' && cellIds.includes(block.id)).sort((a,b) => a.from - b.from);
  if (!cells.length) throw new Error('请先选择表格单元格。');
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
