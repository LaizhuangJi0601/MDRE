// v0.2.5 表格交互共享工具：环境判定、补丁提交与中文错误出口。
import { env } from '../runtime';
import type { Model } from '../../model';
import type { TableInfo, TablePatch } from '../../tables';

/** 首次合并或首次启用“上下居中”自动转 HTML 表格时的状态栏提示（需求原文）。 */
export const HTML_CONVERTED_MESSAGE = '此表已转为 HTML 表格，其他仅支持标准 Markdown 表格的编辑器可能显示源码';

export type EditableTable = {
  doc: { model: Model; readOnly?: boolean; welcome?: boolean };
  model: Model;
  table: HTMLTableElement;
  tableId: string;
};

/** 判断渲染栏中的表格是否可交互（编辑模式、属于当前文档模型中的 table 块、不是嵌入预览里的装饰表格）。 */
export function editableTable(table: HTMLTableElement | null | undefined): EditableTable | null {
  if (!table || !table.isConnected) return null;
  // 源码片段预览、帮助文档、弹窗里的表格只是展示，不参与表格交互。
  if (table.closest('.opaque, .inline-editor, dialog, #help-content, #image-view-stage')) return null;
  if (!table.closest('.ProseMirror')) return null;
  const doc = env().workspace.active;
  if (!doc || doc.welcome || doc.readOnly) return null;
  const tableId = table.dataset.block;
  if (!tableId) return null;
  const model = doc.model as Model;
  const block = model.blocks.find(item => item.id === tableId && item.type === 'table');
  if (!block) return null;
  return { doc, model, table, tableId };
}

/** 从右键/指针命中的单元格向上找最近的表格元素。 */
export function tableOfCell(cell: Element | null | undefined): HTMLTableElement | null {
  const table = cell instanceof Element ? cell.closest('table') : null;
  return table instanceof HTMLTableElement ? table : null;
}

/**
 * 提交表格数据层返回的补丁：一次 env.structural 写入（一次撤销），
 * 若数据层为执行操作把 GFM 表格转成了 HTML 表格，用状态栏给出需求约定的提示。
 */
export function applyTablePatch(result: TablePatch): void {
  env().structural({ from: result.from, to: result.to, insert: result.insert }, undefined, 'render');
  if (result.converted) {
    env().message(HTML_CONVERTED_MESSAGE);
    // 状态栏宽度有限，用 title 保留完整提示，便于悬停读取。
    document.getElementById('status-text')?.setAttribute('title', HTML_CONVERTED_MESSAGE);
  }
}

/** 行内格式错误的统一出口：中文错误交给主程序错误条与状态栏展示。 */
export function reportTableError(reason: unknown): void {
  env().error(reason instanceof Error ? reason.message : String(reason));
}

/** TableInfo.cells 是“行内源顺序单元格”，这里换算成逻辑网格位置（供矩形校验与列对齐统计使用）。 */
export type CellPosition = { row: number; column: number; rowspan: number; colspan: number };

export function cellPositions(info: TableInfo): Map<string, CellPosition> {
  const positions = new Map<string, CellPosition>();
  const covered: boolean[][] = Array.from({ length: Math.max(1, info.rows) }, () => Array.from({ length: Math.max(1, info.columns) }, () => false));
  for (let row = 0; row < info.cells.length; row++) {
    let column = 0;
    for (const cell of info.cells[row] ?? []) {
      while (covered[row]?.[column]) column++;
      if (column >= info.columns) break;
      positions.set(cell.id, { row, column, rowspan: Math.max(1, cell.rowspan), colspan: Math.max(1, cell.colspan) });
      for (let dr = 0; dr < Math.max(1, cell.rowspan); dr++) {
        const target = covered[row + dr];
        if (!target) continue;
        for (let dc = 0; dc < Math.max(1, cell.colspan); dc++) if (column + dc < info.columns) target[column + dc] = true;
      }
      column += Math.max(1, cell.colspan);
    }
  }
  return positions;
}
