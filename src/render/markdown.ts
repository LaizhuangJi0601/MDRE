import katex from 'katex';
import type { Model } from '../model';
import { schema } from '../model';

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
export function tocEntries(model: Model): TocEntry[] {
  const entries: TocEntry[] = [];
  const used = new Set<string>();
  model.doc.descendants((node, _pos, parent) => {
    if (node.type !== schema.nodes.heading) return true;
    const index = entries.length + 1;
    const explicit = (node.attrs.anchor as string | null) ?? null;
    let anchor = explicit ?? `sec-${(node.textContent || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section'}-${index}`;
    // 同文档锚点必须唯一；显式 ID 也在重复时追加序号，不改变原 ID 语义。
    let suffix = 1;
    while (used.has(anchor)) anchor = `${explicit ?? anchor}-${++suffix}`;
    used.add(anchor);
    entries.push({ anchor, level: Math.min(6, Math.max(1, Number(node.attrs.level ?? 1))), text: (node.textContent || '').trim() || '（空标题）' });
    void parent;
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

// S-6：渲染输出的单一白名单出口。先解析成结构再重建 HTML，纯函数，便于单测覆盖。
const allowedTags = new Set(['p', 'br', 'hr', 'strong', 'em', 's', 'del', 'code', 'pre', 'mark', 'span', 'div', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'nav', 'figure', 'figcaption', 'section', 'article', 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msqrt', 'mtext', 'mspace', 'mover', 'munder', 'mtable', 'mtr', 'mtd']);
const allowedAttrs = new Set(['href', 'title', 'alt', 'src', 'width', 'height', 'class', 'style', 'id', 'colspan', 'rowspan', 'start', 'align', 'encoding', 'mathvariant']);
const voidTags = new Set(['br', 'hr', 'img']);
const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
const tagPattern = /<\/?([a-zA-Z][-a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

export function sanitizeHtml(html: string): string {
  let output = '';
  let cursor = 0;
  tagPattern.lastIndex = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    // 标签之间的文本已由 markdown-it 转义，原样保留；只有标签与属性参与白名单判定。
    output += html.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    const closing = match[0].startsWith('</');
    const tag = match[1].toLowerCase();
    // 未在白名单内的标签整体丢弃（保留其文本内容）。
    if (!allowedTags.has(tag)) continue;
    if (closing) { if (!voidTags.has(tag)) output += `</${tag}>`; continue; }
    const attrs: string[] = [];
    attributePattern.lastIndex = 0;
    for (let attr = attributePattern.exec(match[2]); attr; attr = attributePattern.exec(match[2])) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action' || name === 'xlink:href' || name === 'xmlns') continue;
      if (!allowedAttrs.has(name) && !name.startsWith('data-') && !name.startsWith('aria-')) continue;
      if ((name === 'href' || name === 'src') && !safeAttributeUrl(value, tag === 'img')) continue;
      if (name === 'style' && /expression|javascript:|url\s*\(\s*['"]?\s*(?:javascript|data:text\/html)/i.test(value)) continue;
      attrs.push(value ? ` ${name}="${escapeAttribute(value)}"` : ` ${name}`);
    }
    output += `<${tag}${attrs.join('')}>`;
  }
  output += html.slice(cursor);
  return output;
}

// 先去掉控制字符再判定协议，避免 `java&Tab;script:` 一类实体或空白分隔绕过前缀匹配。
function safeAttributeUrl(raw: string, isImage: boolean): boolean {
  const value = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (value.startsWith('#')) return true;
  if (/^(?:https?:|mailto:)/.test(value)) return true;
  if (isImage && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/.test(value)) return true;
  return false;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", tab: '\t', newline: '\n', nbsp: ' ' };
    return named[String(name).toLowerCase()] ?? whole;
  });
}

const escapeAttribute = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
