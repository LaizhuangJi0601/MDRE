import katex from 'katex';
import type { Model } from '../model';
import { headingAnchor, schema } from '../model';

// S-2：KaTeX 同步渲染；公式字体由应用随包提供，离线可用。
export function renderMath(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: true, output: 'html', strict: 'ignore', trust: false });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const dom = document.createElement('span');
    dom.className = 'math-error';
    dom.textContent = message;
    dom.title = latex;
    return dom.outerHTML;
  }
}

export type TocEntry = { anchor: string; level: number; text: string };

// S-1/S-3：标题锚点与目录共用同一份 slug 来源，避免渲染与导出不一致。
// v0.2.7：目录锚点直接取模型里的唯一锚点（与链接解析、大纲、导出同一来源），
// 仅作为防御在极端情况下保留去重，且后缀基于原始锚点而不是上一次的结果。
export function tocEntries(model: Model): TocEntry[] {
  const entries: TocEntry[] = [];
  const used = new Set<string>();
  let index = 0;
  model.doc.descendants(node => {
    if (node.type !== schema.nodes.heading) return true;
    index++;
    const explicit = (node.attrs.explicitAnchor as string | null) ?? null;
    const base = (node.attrs.anchor as string | null) ?? headingAnchor(node.textContent || '', explicit, index);
    let anchor = base, suffix = 1;
    while (used.has(anchor)) anchor = `${base}-${++suffix}`;
    used.add(anchor);
    entries.push({ anchor, level: Math.min(6, Math.max(1, Number(node.attrs.level ?? 1))), text: (node.textContent || '').trim() || '（空标题）' });
    return false;
  });
  return entries;
}

export function tocHtml(entries: TocEntry[]): string {
  if (!entries.length) return '<p class="toc-empty">当前文档没有标题</p>';
  const html = (items: TocEntry[], start: number, level: number): [string, number] => {
    let output = '<ul>';
    let cursor = start;
    while (cursor < items.length && items[cursor].level >= level) {
      if (items[cursor].level > level) { const [nested, next] = html(items, cursor, items[cursor].level); output += nested; cursor = next; continue; }
      const entry = items[cursor];
      output += `<li><a href="#${entry.anchor}">${escapeHtml(entry.text)}</a>`;
      const [nested, next] = cursor + 1 < items.length && items[cursor + 1].level > level ? html(items, cursor + 1, items[cursor + 1].level) : ['', cursor + 1];
      output += nested + '</li>';
      cursor = next;
    }
    return [output + '</ul>', cursor];
  };
  return `<nav class="toc-block" aria-label="目录">${html(entries, 0, entries[0].level)[0]}</nav>`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

export { sanitizeHtml } from './html';
