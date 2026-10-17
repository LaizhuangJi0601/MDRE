// 「复制为富文本」的渲染模型 → HTML 序列化（MDRE 0.2.5「剪贴板与轻量互通」）。
// 直接从 ProseMirror 渲染模型生成语义 HTML，天然排除页码、代码行号、纸张边距等
// 仅存在于 DOM 视图的分页装饰；图片按文档解析结果转成 data URI 或保留 HTTPS。
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { sanitizeHtml } from '../../render/html';
import { htmlToPlainText } from '../../html-to-markdown';

export type RichCopyOptions = {
  /** 渲染选区；null 表示整篇渲染内容 */
  range: { from: number; to: number } | null;
  title?: string;
  /** 返回图片可嵌入的地址（data URI / HTTPS / file URI）；null 表示无法解析 */
  resolveImage: (node: PMNode, pos: number | null) => Promise<string | null> | string | null;
};

export type RichCopyResult = {
  html: string;
  /** 与 html 对应的 body 片段，execCommand 兜底时使用 */
  body: string;
  text: string;
  /** MDRE 私有格式按最接近语义（加粗/下划线）降级的处数 */
  downgraded: number;
  /** 无法映射而丢弃的内容/图片处数 */
  dropped: number;
  imageFailures: number;
};

type ImageTask = { token: string; node: PMNode; pos: number | null; alt: string; width: number | null };
type Context = { images: ImageTask[]; downgraded: number; dropped: number; imageFailures: number };

const IMAGE_TOKEN = (index: number) => `\u0003MDRE-RICH-IMAGE-${index}\u0003`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (value: string) => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
const escapeAttribute = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

function textBlockTag(node: PMNode): string {
  if (node.type.name === 'heading') return `h${Math.max(1, Math.min(6, Number(node.attrs.level) || 1))}`;
  return 'p';
}

function taskPrefix(node: PMNode): string {
  const checked = node.attrs.checked;
  if (checked === null || checked === undefined) return '';
  return checked ? '☑ ' : '☐ ';
}

function wrapMark(inner: string, mark: Mark, context: Context): string {
  switch (mark.type.name) {
    case 'strong': return `<strong>${inner}</strong>`;
    case 'em': return `<em>${inner}</em>`;
    case 'underline': return `<u>${inner}</u>`;
    case 'strike': return `<s>${inner}</s>`;
    case 'code': return `<code>${inner}</code>`;
    case 'sup': return `<sup>${inner}</sup>`;
    case 'sub': return `<sub>${inner}</sub>`;
    case 'link': {
      const href = String(mark.attrs.href ?? '');
      const title = mark.attrs.title ? ` title="${escapeAttribute(String(mark.attrs.title))}"` : '';
      return `<a href="${escapeAttribute(href)}"${title}>${inner}</a>`;
    }
    // MDRE 私有格式：Markdown 无法表达，按最接近的语义降级（提示处数）。
    case 'color': context.downgraded++; return `<u>${inner}</u>`;
    case 'highlight': case 'bg': context.downgraded++; return `<strong>${inner}</strong>`;
    case 'size': context.downgraded++; return `<strong>${inner}</strong>`;
    case 'html': {
      const open = sanitizeHtml(String(mark.attrs.open ?? ''));
      const close = sanitizeHtml(String(mark.attrs.close ?? ''));
      if (!open || !close) { context.dropped++; return inner; }
      return open + inner + close;
    }
    default: return inner;
  }
}

const MARK_ORDER = ['link', 'code', 'strong', 'em', 'underline', 'strike', 'sup', 'sub', 'color', 'highlight', 'bg', 'size', 'html'];

function wrapMarks(inner: string, marks: readonly Mark[], context: Context): string {
  const sorted = [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
  let output = inner;
  for (const mark of sorted) output = wrapMark(output, mark, context);
  return output;
}

function serializeImage(node: PMNode, pos: number | null, context: Context): string {
  const task: ImageTask = {
    token: IMAGE_TOKEN(context.images.length),
    node,
    pos,
    alt: String(node.attrs.alt ?? ''),
    width: node.attrs.width === null || node.attrs.width === undefined ? null : Number(node.attrs.width),
  };
  context.images.push(task);
  const width = task.width ? ` width="${Math.round(task.width)}"` : '';
  const title = node.attrs.title ? ` title="${escapeAttribute(String(node.attrs.title))}"` : '';
  return `<img src="${task.token}" alt="${escapeAttribute(task.alt)}"${title}${width}>`;
}

function serializeInline(parent: PMNode, basePosition: number, context: Context): string {
  let output = '';
  parent.forEach((child, offset) => {
    const position = basePosition + offset;
    if (child.isText) { output += wrapMarks(escapeHtml(child.text ?? ''), child.marks, context); return; }
    switch (child.type.name) {
      case 'hard_break': output += '<br>'; break;
      case 'image': output += serializeImage(child, position, context); break;
      case 'raw_inline': {
        const raw = sanitizeHtml(String(child.attrs.raw ?? ''));
        if (!raw.trim()) context.dropped++; else output += raw;
        break;
      }
      case 'math_inline': output += escapeHtml(String(child.attrs.latex ?? '')); break;
      case 'footnote_ref': output += `<sup>[${escapeHtml(String(child.attrs.label ?? ''))}]</sup>`; break;
      default: output += escapeHtml(child.textContent); break;
    }
  });
  return output;
}

function serializeTable(node: PMNode, position: number, context: Context): string {
  const rows: string[] = [];
  node.forEach((row, rowOffset) => {
    const rowPosition = position + 1 + rowOffset;
    const cells: string[] = [];
    row.forEach((cell, cellOffset) => {
      const cellPosition = rowPosition + 1 + cellOffset;
      const header = !!(cell.attrs.header || row.attrs.header);
      const tag = header ? 'th' : 'td';
      const style = cell.attrs.cellAlign || cell.attrs.align ? ` style="text-align:${escapeAttribute(String(cell.attrs.cellAlign || cell.attrs.align))}"` : '';
      const colspan = Number(cell.attrs.colspan) > 1 ? ` colspan="${Number(cell.attrs.colspan)}"` : '';
      const rowspan = Number(cell.attrs.rowspan) > 1 ? ` rowspan="${Number(cell.attrs.rowspan)}"` : '';
      const valign = cell.attrs.vAlign ? ` style="vertical-align:${escapeAttribute(String(cell.attrs.vAlign))}${cell.attrs.cellAlign || cell.attrs.align ? `;text-align:${escapeAttribute(String(cell.attrs.cellAlign || cell.attrs.align))}` : ''}"` : '';
      cells.push(`<${tag}${colspan}${rowspan}${valign || style}>${serializeInline(cell, cellPosition + 1, context)}</${tag}>`);
    });
    rows.push(`<tr>${cells.join('')}</tr>`);
  });
  // 表格边框属于结构可辨识信息，复制到 Word 时保留网格线。
  return `<table border="1" cellspacing="0" cellpadding="4"><tbody>${rows.join('')}</tbody></table>`;
}

function serializeOpaque(node: PMNode, context: Context): string {
  const kind = String(node.attrs.kind ?? 'source');
  const content = String(node.attrs.content || node.attrs.raw || '');
  switch (kind) {
    case 'hr': return '<hr>';
    case 'html_block': {
      const raw = sanitizeHtml(content);
      if (!raw.trim()) { context.dropped++; return ''; }
      return raw;
    }
    case 'code': {
      const info = String(node.attrs.info ?? '').trim().split(/\s/)[0] ?? '';
      const language = info ? ` class="language-${escapeAttribute(info)}"` : '';
      return `<pre><code${language}>${escapeHtml(content.replace(/\n$/, ''))}</code></pre>`;
    }
    case 'mermaid': {
      return `<pre><code class="language-mermaid">${escapeHtml(content.replace(/\n$/, ''))}</code></pre>`;
    }
    default: return `<pre><code>${escapeHtml(content.replace(/\n$/, ''))}</code></pre>`;
  }
}

function serializeBlock(node: PMNode, position: number, context: Context): string {
  switch (node.type.name) {
    case 'paragraph': return `<p>${serializeInline(node, position + 1, context)}</p>`;
    case 'heading': {
      const tag = textBlockTag(node);
      return `<${tag}>${serializeInline(node, position + 1, context)}</${tag}>`;
    }
    case 'blockquote': {
      let inner = '';
      node.forEach((child, offset) => { inner += serializeBlock(child, position + 1 + offset, context); });
      return `<blockquote>${inner}</blockquote>`;
    }
    case 'bullet_list': case 'ordered_list': {
      const tag = node.type.name === 'bullet_list' ? 'ul' : 'ol';
      const start = node.type.name === 'ordered_list' && Number(node.attrs.order) > 1 ? ` start="${Number(node.attrs.order)}"` : '';
      let inner = '';
      node.forEach((child, offset) => { inner += serializeBlock(child, position + 1 + offset, context); });
      return `<${tag}${start}>${inner}</${tag}>`;
    }
    case 'list_item': {
      const prefix = taskPrefix(node);
      let inner = '';
      node.forEach((child, offset) => {
        const childPosition = position + 1 + offset;
        // 任务清单：把 ☑/☐ 放进首段内部，粘贴回 Markdown 时能还原为 [x]/[ ]。
        if (prefix && child.isTextblock && !inner) {
          const tag = textBlockTag(child);
          inner += `<${tag}>${prefix}${serializeInline(child, childPosition + 1, context)}</${tag}>`;
        } else {
          inner += serializeBlock(child, childPosition, context);
        }
      });
      return `<li>${inner || prefix}</li>`;
    }
    case 'table': return serializeTable(node, position, context);
    case 'opaque': return serializeOpaque(node, context);
    case 'math_block': return `<p>${escapeHtml(String(node.attrs.latex ?? ''))}</p>`;
    case 'footnote_defs': {
      const items = (node.attrs.items ?? []) as { label: string; text: string }[];
      if (!items.length) return '';
      return `<ol>${items.map(item => `<li>${escapeHtml(String(item.text ?? ''))}</li>`).join('')}</ol>`;
    }
    case 'footnote_def': return `<p>${escapeHtml(String(node.attrs.text ?? ''))}</p>`;
    // 文首元数据与目录块属于界面信息，不进入富文本。
    case 'toc_block': context.dropped++; return '';
    case 'front_matter': return '';
    default: context.dropped++; return '';
  }
}

/** 选区跨越多个块时，只序列化与选区相交的部分；容器按半开区间递归。 */
function serializeRangeNode(node: PMNode, position: number, from: number, to: number, context: Context): string {
  const start = position, end = position + node.nodeSize;
  if (end <= from || start >= to) return '';
  if (node.isTextblock) {
    const localFrom = Math.max(0, Math.min(node.content.size, from - (position + 1)));
    const localTo = Math.max(localFrom, Math.min(node.content.size, to - (position + 1)));
    if (localFrom >= localTo) return '';
    const cut = node.cut(localFrom, localTo);
    const tag = textBlockTag(node);
    return `<${tag}>${serializeInline(cut, position + 1 + localFrom, context)}</${tag}>`;
  }
  if (node.isAtom) return serializeBlock(node, position, context);
  switch (node.type.name) {
    case 'blockquote': {
      let inner = '';
      node.forEach((child, offset) => { inner += serializeRangeNode(child, position + 1 + offset, from, to, context); });
      return inner ? `<blockquote>${inner}</blockquote>` : '';
    }
    case 'bullet_list': case 'ordered_list': {
      const tag = node.type.name === 'bullet_list' ? 'ul' : 'ol';
      let inner = '';
      node.forEach((child, offset) => { inner += serializeRangeNode(child, position + 1 + offset, from, to, context); });
      return inner ? `<${tag}>${inner}</${tag}>` : '';
    }
    case 'list_item': {
      const prefix = taskPrefix(node);
      let inner = '';
      let injected = false;
      node.forEach((child, offset) => {
        const html = serializeRangeNode(child, position + 1 + offset, from, to, context);
        // 任务清单前缀注入首个块内部，粘贴回 Markdown 时可还原为 [x]/[ ]。
        if (prefix && !injected && html.startsWith('<')) {
          const tagEnd = html.indexOf('>') + 1;
          inner += html.slice(0, tagEnd) + prefix + html.slice(tagEnd);
          injected = true;
        } else inner += html;
      });
      return inner.trim() ? `<li>${inner}</li>` : '';
    }
    // 表格等复杂容器部分选中时保留整块，避免生成结构不完整的 HTML。
    default: return serializeBlock(node, position, context);
  }
}

function serializeDocumentBody(doc: PMNode, range: { from: number; to: number } | null, context: Context): string {
  const from = range?.from ?? 0;
  const to = range?.to ?? doc.content.size;
  if (!range) {
    let output = '';
    doc.forEach((node, offset) => { output += serializeBlock(node, offset, context); });
    return output;
  }
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  // 同一文本块内选择：保留段落/标题语义，只序列化被选中的行内内容。
  if ($from.sameParent($to) && $from.parent.isTextblock && $from.depth > 0) {
    const localFrom = from - $from.start();
    const localTo = to - $from.start();
    if (localTo > localFrom) {
      const cut = $from.parent.cut(localFrom, localTo);
      const tag = textBlockTag($from.parent);
      return `<${tag}>${serializeInline(cut, $from.start() + localFrom, context)}</${tag}>`;
    }
  }
  let output = '';
  doc.forEach((node, offset) => { output += serializeRangeNode(node, offset, from, to, context); });
  return output;
}

/**
 * 生成富文本剪贴板内容（text/html + text/plain）。
 * 图片解析失败时从 HTML 中移除并计数，保证剪贴板内容里不出现无法读取的图片地址。
 */
export async function renderRichCopy(doc: PMNode, options: RichCopyOptions): Promise<RichCopyResult> {
  const context: Context = { images: [], downgraded: 0, dropped: 0, imageFailures: 0 };
  let body = serializeDocumentBody(doc, options.range, context);
  if (context.images.length) {
    const sources = await Promise.all(context.images.map(async image => {
      try {
        const value = await options.resolveImage(image.node, image.pos);
        return value && value.trim() ? value.trim() : null;
      } catch { return null; }
    }));
    for (const [index, image] of context.images.entries()) {
      const source = sources[index];
      if (source) {
        body = body.split(image.token).join(escapeAttribute(source));
      } else {
        context.imageFailures++;
        body = body.replace(new RegExp(`<img[^>]*${escapeRegExp(image.token)}[^>]*>`, 'g'), '');
      }
    }
  }
  const title = escapeHtml(options.title || 'MDRE 文档快照');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  return {
    html,
    body,
    text: htmlToPlainText(body),
    downgraded: context.downgraded,
    dropped: context.dropped,
    imageFailures: context.imageFailures,
  };
}
