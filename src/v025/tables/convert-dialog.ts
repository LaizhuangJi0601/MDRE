// v0.2.5 “转换为 Markdown 表格”确认弹窗：列出会丢失的信息，用户确认后才转换。
// 使用自建 <dialog> + env.openFloating/closeFloating，不使用 window.confirm/alert。
import { env } from '../runtime';
import type { Model } from '../../model';
import { readTable } from '../../tables';
import { cellPositions } from './shared';

let dialog: HTMLDialogElement | null = null;
let pending: ((accepted: boolean) => void) | null = null;

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  const element = document.createElement('dialog');
  element.id = 'mdre-table-convert-dialog';
  element.dataset.cancel = 'mdre-convert-cancel';
  element.innerHTML = [
    '<h3>转换为 Markdown 表格</h3>',
    '<p>转换后表格将成为标准 Markdown 表格。请确认下列会丢失的信息：</p>',
    '<ul class="mdre-convert-loss"></ul>',
    '<p class="mdre-convert-note dialog-hint">列宽会保留为表格后的 HTML 注释（<code>&lt;!-- mdre:table-widths: 25%,40%,35% --&gt;</code>），其他编辑器可能忽略该注释。</p>',
    '<div class="dialog-actions"><button id="mdre-convert-cancel" type="button">取消</button><button id="mdre-convert-ok" class="primary-button" type="button">转换为 Markdown 表格</button></div>',
  ].join('');
  document.body.append(element);
  element.querySelector<HTMLButtonElement>('#mdre-convert-cancel')?.addEventListener('click', () => finish(false));
  element.querySelector<HTMLButtonElement>('#mdre-convert-ok')?.addEventListener('click', () => finish(true));
  element.oncancel = () => finish(false);
  dialog = element;
  return element;
}

function finish(accepted: boolean): void {
  const resolve = pending;
  pending = null;
  if (dialog?.open) {
    try { env().closeFloating(dialog); } catch { /* 关闭失败不阻塞后续操作 */ }
  }
  resolve?.(accepted);
}

/** 收集会丢失的信息：列内混合对齐、其他 HTML 属性/样式、无表头语义等。 */
function collectLosses(model: Model, tableId: string, table: HTMLTableElement): string[] {
  const losses: string[] = [];
  let info: ReturnType<typeof readTable> | null = null;
  try { info = readTable(model, tableId); } catch { info = null; }
  if (info) {
    const positions = cellPositions(info);
    const byColumn: string[][] = Array.from({ length: info.columns }, () => []);
    for (const row of info.cells) {
      for (const cell of row) {
        const position = positions.get(cell.id);
        if (position && position.colspan === 1) byColumn[position.column].push(cell.align || '');
      }
    }
    const mixed = byColumn.map((aligns, index) => new Set(aligns).size > 1 ? index + 1 : 0).filter(Boolean);
    if (mixed.length) losses.push(`第 ${mixed.join('、')} 列的单元格对齐不一致：转换后按该列首行写回分隔行，无法统一时按左对齐处理。`);
  }
  const block = model.blocks.find(item => item.id === tableId && item.type === 'table');
  const raw = block ? model.source.slice(block.from, block.to) : '';
  const styleProps = new Set<string>();
  const collectStyles = (html: string, skip: string[]) => {
    for (const match of html.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      for (const declaration of (match[1] ?? match[2] ?? '').split(';')) {
        const name = declaration.split(':')[0]?.trim().toLowerCase();
        if (name && !skip.includes(name)) styleProps.add(name);
      }
    }
  };
  // col/colgroup 的宽度会保留为 mdre:table-widths 注释，不算丢失；单元格与行的其他样式无法在 Markdown 中表达。
  for (const match of raw.matchAll(/<col(?:group)?\b[^>]*>/gi)) collectStyles(match[0], ['width', 'height']);
  for (const match of raw.matchAll(/<(?:table|thead|tbody|tr|th|td)\b[^>]*>/gi)) collectStyles(match[0], ['text-align', 'vertical-align']);
  if (styleProps.size) losses.push(`表格与单元格上的自定义样式（如 ${[...styleProps].slice(0, 4).join('、')}）在标准 Markdown 表格中无法表达，转换后将丢失。`);
  const extraAttrs = new Set<string>();
  for (const match of raw.matchAll(/<(?:table|thead|tbody|tr|th|td)\b([^>]*)>/gi)) {
    for (const attribute of match[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=|>|\/)/g)) {
      const name = attribute[1].toLowerCase();
      if (['style', 'colspan', 'rowspan', 'align', 'data-block', 'data-cell'].includes(name)) continue;
      extraAttrs.add(name);
    }
  }
  if (extraAttrs.size) losses.push(`表格与单元格上的其他 HTML 属性（如 ${[...extraAttrs].slice(0, 4).join('、')}）转换后将丢失。`);
  // HTML 表格可能没有表头语义：GFM 表格第一行固定为表头。
  const firstRow = table.rows[0];
  if (firstRow && firstRow.cells[0]?.tagName === 'TD') losses.push('原表格第一行是普通单元格，转换后将成为 Markdown 表头行。');
  if (!losses.length) losses.push('未检测到会丢失的信息：表格的行列结构与单元格文字将完整保留。');
  return losses;
}

/** 打开确认弹窗；返回 true 表示用户确认转换。 */
export function confirmConvertToMarkdown(model: Model, tableId: string, table: HTMLTableElement): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  const losses = collectLosses(model, tableId, table);
  const element = ensureDialog();
  const list = element.querySelector<HTMLUListElement>('.mdre-convert-loss');
  if (list) list.replaceChildren(...losses.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  return new Promise<boolean>(resolve => {
    pending = resolve;
    try { env().openFloating(element); } catch (reason) { pending = null; throw reason; }
  });
}
