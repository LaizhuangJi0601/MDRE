// v0.2.5 表格列宽：渲染 DOM 几何测量、列边框命中、百分比与“按内容适应”换算。
// 所有计算都只读渲染 DOM，不逐像素写源码；真正提交由调用方一次完成。
export const MIN_COLUMN_WIDTH = 4;

export type TableCellBox = { element: HTMLTableCellElement; column: number; span: number };

export type TableGeometry = {
  columns: number;
  /** 各列边界相对表格左边缘的偏移（px），长度 columns + 1。 */
  offsets: number[];
  /** 该边界是否有真实单元格边框（插值补出的边界不可拖动）。 */
  real: boolean[];
  cells: TableCellBox[];
};

let cache = new WeakMap<HTMLTableElement, TableGeometry>();

/** 渲染刷新、窗口尺寸变化后丢弃测量缓存（表格列宽由 table-layout:fixed 决定，缓存是安全的）。 */
export function clearGeometryCache(): void {
  cache = new WeakMap();
}

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function computeGeometry(table: HTMLTableElement): TableGeometry | null {
  const rows = Array.from(table.rows);
  if (!rows.length) return null;
  const rect = table.getBoundingClientRect();
  if (!(rect.width > 0)) return null;
  const offsets: (number | undefined)[] = [];
  const real: boolean[] = [];
  const cells: TableCellBox[] = [];
  const note = (index: number, value: number) => {
    const x = value - rect.left;
    if (!Number.isFinite(x)) return;
    if (offsets[index] === undefined) offsets[index] = x;
    else if (Math.abs(offsets[index]! - x) <= 2) offsets[index] = (offsets[index]! + x) / 2;
  };
  // rowspan 会占住后续行的列：用逐行占用表还原每个单元格在逻辑网格中的起始列。
  let occupied: number[] = [];
  let columns = 0;
  for (const row of rows) {
    const next = occupied.map(value => Math.max(0, value - 1));
    let column = 0;
    for (const element of Array.from(row.cells)) {
      while ((occupied[column] ?? 0) > 0) column++;
      const span = Math.max(1, element.colSpan || 1);
      const rowspan = Math.max(1, element.rowSpan || 1);
      const box = element.getBoundingClientRect();
      note(column, box.left);
      note(column + span, box.right);
      real[column] = true;
      real[column + span] = true;
      cells.push({ element, column, span });
      if (rowspan > 1) for (let k = 0; k < span; k++) next[column + k] = Math.max(next[column + k] ?? 0, rowspan - 1);
      column += span;
    }
    columns = Math.max(columns, column);
    occupied = next;
  }
  if (!columns) return null;
  // 表格左右边缘以表格自身矩形为准，中间缺失的边界按相邻已知边界线性插值（插值边界不可拖动）。
  offsets[0] = 0;
  offsets[columns] = rect.width;
  for (let index = 0; index <= columns; index++) {
    if (offsets[index] !== undefined) continue;
    let before = index - 1;
    while (before >= 0 && offsets[before] === undefined) before--;
    let after = index + 1;
    while (after <= columns && offsets[after] === undefined) after++;
    if (before < 0 || after > columns) return null;
    const start = offsets[before]!, end = offsets[after]!;
    offsets[index] = start + (end - start) * (index - before) / (after - before);
    real[index] = false;
  }
  const result = offsets.map(value => value!);
  for (let index = 1; index <= columns; index++) if (!(result[index] > result[index - 1])) return null;
  return { columns, offsets: result, real, cells };
}

/** 读取（并缓存）渲染表格的列边界几何；DOM 已被替换时自动重算。 */
export function tableGeometry(table: HTMLTableElement): TableGeometry | null {
  const cached = cache.get(table);
  if (cached && cached.cells.every(box => box.element.isConnected)) return cached;
  const geometry = computeGeometry(table);
  if (geometry) cache.set(table, geometry);
  return geometry;
}

/** 命中列边框：返回该边框对应的边界下标（1..columns-1），未命中返回 null。 */
export function boundaryAt(table: HTMLTableElement, clientX: number, clientY: number, tolerance = 4): number | null {
  const rect = table.getBoundingClientRect();
  if (!(rect.width > 0) || clientY < rect.top - 2 || clientY > rect.bottom + 2) return null;
  const geometry = tableGeometry(table);
  if (!geometry || geometry.columns < 2) return null;
  const x = clientX - rect.left;
  let best = -1;
  let bestDistance = tolerance + 0.01;
  for (let boundary = 1; boundary < geometry.columns; boundary++) {
    if (!geometry.real[boundary]) continue;
    const distance = Math.abs(x - geometry.offsets[boundary]);
    if (distance < bestDistance) { bestDistance = distance; best = boundary; }
  }
  return best > 0 ? best : null;
}

/** 当前渲染宽度换算成百分比（总和归一化为 100）。 */
export function measuredPercentages(table: HTMLTableElement): number[] | null {
  const geometry = tableGeometry(table);
  if (!geometry) return null;
  const total = geometry.offsets[geometry.columns] - geometry.offsets[0];
  if (!(total > 0)) return null;
  const widths = Array.from({ length: geometry.columns }, (_, index) => (geometry.offsets[index + 1] - geometry.offsets[index]) / total * 100);
  return normalizePercentages(widths);
}

let measurer: HTMLElement | null = null;

function fitMeasurer(cell: HTMLTableCellElement): HTMLElement {
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.className = 'mdre-cell-measure';
    document.body.append(measurer);
  }
  const style = getComputedStyle(cell);
  measurer.style.fontFamily = style.fontFamily;
  measurer.style.fontSize = style.fontSize;
  measurer.style.fontWeight = style.fontWeight;
  measurer.style.fontStyle = style.fontStyle;
  measurer.style.letterSpacing = style.letterSpacing;
  measurer.style.lineHeight = style.lineHeight;
  return measurer;
}

/** 单个单元格内容的自然宽度（不换行时的实际排版宽度，像素）。 */
function contentWidth(cell: HTMLTableCellElement): number {
  const source = cell.querySelector('.cell-content') ?? cell;
  const container = fitMeasurer(cell);
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  container.replaceChildren(...Array.from(clone.childNodes));
  const width = container.getBoundingClientRect().width;
  if (!width) return 0;
  const style = getComputedStyle(cell);
  const chrome = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, name) => sum + (parseFloat(style.getPropertyValue(name) || '0') || 0), 0);
  return width + chrome;
}

/** 各列内容所需宽度（px）；跨列单元格按 colspan 平摊。 */
export function contentWidths(table: HTMLTableElement): number[] | null {
  const geometry = tableGeometry(table);
  if (!geometry) return null;
  const required = Array.from({ length: geometry.columns }, () => 0);
  for (const box of geometry.cells) {
    const width = contentWidth(box.element);
    if (box.span === 1) required[box.column] = Math.max(required[box.column], width);
    else {
      const each = width / box.span;
      for (let k = 0; k < box.span && box.column + k < required.length; k++) required[box.column + k] = Math.max(required[box.column + k], each);
    }
  }
  for (let index = 0; index < required.length; index++) required[index] = Math.max(required[index], 12);
  return required;
}

/** 归一化为总和 100 的百分比（清掉 0/NaN/负值）。 */
export function normalizePercentages(widths: number[]): number[] {
  if (!widths.length) return [];
  const cleaned = widths.map(value => Number.isFinite(value) && value > 0 ? value : 0);
  const sum = cleaned.reduce((total, value) => total + value, 0);
  if (!(sum > 0)) return Array.from({ length: widths.length }, () => 100 / widths.length);
  return cleaned.map(value => value / sum * 100);
}

function distribute(values: number[], total: number): number[] {
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (!(sum > 0)) return values.map(() => total / values.length);
  return values.map(value => value * total / sum);
}

/** 保证每列不小于最小值；空间不足时退回均分（调用方按列数决定是否允许）。 */
function enforceMinimum(widths: number[], minimum = MIN_COLUMN_WIDTH): number[] {
  let next = widths.slice();
  const pinned = new Set<number>();
  for (let guard = 0; guard < widths.length + 2; guard++) {
    const free = next.map((_, index) => index).filter(index => !pinned.has(index));
    if (!free.length) break;
    const budget = 100 - pinned.size * minimum;
    if (!(budget > 0)) return Array.from({ length: widths.length }, () => 100 / widths.length);
    const sum = free.reduce((total, index) => total + next[index], 0);
    for (const index of free) next[index] = sum > 0 ? next[index] * budget / sum : budget / free.length;
    const bad = free.filter(index => next[index] < minimum - 1e-9);
    if (!bad.length) break;
    for (const index of bad) { next[index] = minimum; pinned.add(index); }
  }
  return next;
}

/** 把浮点百分比修约到两位小数并让总和精确等于 total。 */
export function roundPercentages(widths: number[], total = 100): number[] {
  const rounded = widths.map(value => round(value));
  if (!rounded.length) return rounded;
  const sum = rounded.reduce((acc, value) => acc + value, 0);
  const drift = round(total - sum);
  if (drift) {
    let target = 0;
    for (let index = 1; index < rounded.length; index++) if (rounded[index] > rounded[target]) target = index;
    rounded[target] = round(rounded[target] + drift);
  }
  return rounded;
}

/** 均分各列（列数过多、无法满足最小列宽时给出中文错误）。 */
export function equalWidths(columns: number): number[] {
  if (!columns || columns < 1) throw new Error('表格没有可调整的列。');
  if (columns * MIN_COLUMN_WIDTH > 100 + 1e-9) throw new Error(`表格有 ${columns} 列，均分后每列不足 ${MIN_COLUMN_WIDTH}%，无法应用列宽。`);
  return roundPercentages(Array.from({ length: columns }, () => 100 / columns));
}

/** 按内容适应：内容宽度换算成百分比（最小 4%，总和 100%）。 */
export function fitWidths(required: number[]): number[] {
  if (!required.length) return [];
  if (required.length * MIN_COLUMN_WIDTH > 100 + 1e-9) throw new Error(`表格有 ${required.length} 列，按内容适应后每列不足 ${MIN_COLUMN_WIDTH}%，无法应用列宽。`);
  const positive = required.map(value => Math.max(1, value));
  return roundPercentages(enforceMinimum(distribute(positive, 100)));
}

/**
 * 双击某一列边框：该列按内容适应，其余列按当前宽度比例分享剩余宽度（仍保证最小列宽、总和 100）。
 * 空间不足时退回“全部按内容适应”。
 */
export function fitColumnWidths(current: number[], fit: number[], index: number): number[] {
  const count = current.length;
  if (!count) return [];
  const fallback = roundPercentages(fit.slice());
  if (count !== fit.length || index < 0 || index >= count) return fallback;
  const target = clamp(fit[index], MIN_COLUMN_WIDTH, 100 - (count - 1) * MIN_COLUMN_WIDTH);
  const budget = 100 - target;
  const others = current.map((_, position) => position).filter(position => position !== index);
  if (!others.length) return [100];
  if (budget < others.length * MIN_COLUMN_WIDTH - 1e-9) return fallback;
  const result = current.slice();
  result[index] = target;
  let free = others.slice();
  let freeBudget = budget;
  for (let guard = 0; guard <= others.length + 1; guard++) {
    if (!free.length) break;
    const sum = free.reduce((total, position) => total + current[position], 0);
    const values = free.map(position => sum > 0 ? current[position] * freeBudget / sum : freeBudget / free.length);
    const bad = free.filter((position, offset) => values[offset] < MIN_COLUMN_WIDTH - 1e-9);
    if (!bad.length) { free.forEach((position, offset) => { result[position] = values[offset]; }); break; }
    for (const position of bad) { result[position] = MIN_COLUMN_WIDTH; freeBudget -= MIN_COLUMN_WIDTH; }
    free = free.filter(position => !bad.includes(position));
    if (freeBudget <= 0) return fallback;
  }
  return roundPercentages(result);
}
