// 剪贴板 HTML → Markdown 转换与白名单清洗（MDRE 0.2.5「剪贴板与轻量互通」）。
// 纯函数模块：只依赖浏览器 DOM（DOMParser），不读取 env、文档会话或 Tauri 能力。
// 图片无法同步落盘，因此转换结果用唯一占位符标记 data URI / 本地图片，由调用方
// 异步存入全局图片库后替换；HTTPS 图片按规划直接保留链接。
// 由于无副作用、无应用状态依赖，本模块可单独在浏览器测试页中验证。

export const CLIPBOARD_HTML_LIMIT = 5 * 1024 * 1024;
export const CLIPBOARD_IMAGE_LIMIT = 20;

export type PasteImage = {
  /** 出现在 markdown 中的唯一占位符 */
  token: string;
  /** data = 内嵌 data URI；local = 本地路径（Word 临时文件、file: 等） */
  kind: 'data' | 'local';
  src: string;
  alt: string;
};

export type HtmlConversion = {
  /** 转换结果；图片位置仍是占位符，调用方替换后才能写入源码 */
  markdown: string;
  ignored: number;
  images: PasteImage[];
  remoteImages: number;
  tables: number;
  mergedTables: number;
  skippedImages: number;
  oversized: boolean;
  overImageLimit: boolean;
};

const BR_MARK = '\u0000BR\u0000';
const IMAGE_TOKEN = (index: number) => `\u0002MDREIMG${index}\u0002`;

// 危险/无意义元素：整棵子树丢弃（脚本、嵌入内容、样式与 Word 导出用的元数据容器）。
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'link', 'meta', 'base', 'head', 'title',
  'svg', 'math', 'xml', 'canvas', 'video', 'audio', 'map', 'area', 'source', 'track', 'form', 'button', 'select',
  'textarea', 'option', 'optgroup', 'datalist', 'progress', 'meter', 'dialog', 'slot', 'applet', 'frame', 'frameset',
]);
// 已知块级元素。
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'figure', 'figcaption', 'form',
  'fieldset', 'legend', 'center', 'address', 'dl', 'dt', 'dd', 'details', 'summary', 'hgroup', 'search', 'menu',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'caption', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'hr', 'xmp', 'listing', 'plaintext', 'o:p',
]);
// 已知行内元素（其余标签按是否含块级子节点判断）。
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img',
  'ins', 'kbd', 'label', 'mark', 'output', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'small', 'span',
  'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'o:p',
]);
// 保留的 HTML 属性白名单：转换器只需要这些语义信息，样式由解释后降级。
const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'start', 'checked',
  'type', 'class', 'style', 'id', 'scope', 'headers', 'role', 'aria-checked',
]);
const SAFE_PROTOCOL = /^(?:https?:|mailto:|tel:)/i;

type StyleMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

type Context = {
  ignored: number;
  images: PasteImage[];
  remoteImages: number;
  tables: number;
  mergedTables: number;
  skippedImages: number;
};

const newContext = (): Context => ({ ignored: 0, images: [], remoteImages: 0, tables: 0, mergedTables: 0, skippedImages: 0 });

const emptyConversion = (extra: Partial<HtmlConversion> = {}): HtmlConversion => ({
  markdown: '', ignored: 0, images: [], remoteImages: 0, tables: 0, mergedTables: 0, skippedImages: 0,
  oversized: false, overImageLimit: false, ...extra,
});

function tagName(element: Element): string {
  return (element.nodeName || element.tagName || '').toLowerCase();
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function stripControl(text: string): string {
  // 去掉控制字符与零宽字符，避免 `java\nscript:` 一类绕过协议判断。
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
}

function safeLinkUrl(raw: string): boolean {
  const value = stripControl(raw).trim().replace(/[\s\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (!value) return false;
  if (value.startsWith('#')) return true;
  if (SAFE_PROTOCOL.test(value)) return true;
  if (/^(?:javascript|vbscript|data|blob|file|about):/.test(value)) return false;
  // 其他自定义协议可能触发外部程序，只接受相对地址。
  return !/^[a-z][a-z0-9+.-]*:/.test(value);
}

function safeImageUrl(raw: string): boolean {
  const value = stripControl(raw).trim().replace(/[\s\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (!value) return false;
  if (SAFE_PROTOCOL.test(value)) return true;
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);/i.test(value)) return true;
  // 本地路径交给宿主尝试读取；读不到时由调用方跳过并提示。
  if (/^(?:file:|[a-z]:[\\/]|\/\/[^/]+\/|\/)/i.test(raw.trim())) return true;
  if (value.startsWith('blob:')) return false;
  return !/^[a-z][a-z0-9+.-]*:/.test(value);
}

// 清洗 DOM：丢弃危险子树、注释、事件属性、危险 URL，并裁剪属性白名单。
function cleanTree(root: Element | DocumentFragment): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 8) { child.remove(); continue; } // 注释（含 Word 条件注释）
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = tagName(element);
    if (DROP_TAGS.has(tag) || /^[vw]:/.test(tag)) { element.remove(); continue; }
    if (/^o:/.test(tag) && tag !== 'o:p') { // <o:p> 之外的 Office 命名空间节点丢弃内容
      element.remove(); continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action' || name === 'background') {
        element.removeAttribute(attr.name); continue;
      }
      if (!KEEP_ATTRS.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
        element.removeAttribute(attr.name); continue;
      }
      if (name === 'href' && !safeLinkUrl(attr.value)) element.removeAttribute(attr.name);
      if ((name === 'src' || name === 'poster') && !safeImageUrl(attr.value)) element.removeAttribute(attr.name);
      if (name === 'style' && /expression\s*\(|javascript:|behavior\s*:|url\s*\(\s*['"]?\s*(?:javascript|vbscript)/i.test(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
    cleanTree(element);
  }
}

function parseAndClean(html: string): Document | null {
  try {
    const document = new DOMParser().parseFromString(html, 'text/html');
    if (!document.body) return null;
    cleanTree(document.body);
    return document;
  } catch {
    return null;
  }
}

/** 转换前的 HTML 白名单清洗：脚本/iframe/object/style 标签、on* 事件属性、javascript: URL 一律丢弃。 */
export function sanitizeClipboardHtml(html: string): string {
  if (typeof html !== 'string' || !html.trim()) return '';
  const document = parseAndClean(html);
  return document ? document.body.innerHTML : '';
}

function isWhitespaceNode(node: Node): boolean {
  return node.nodeType === 3 && !(node as Text).data.trim();
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\t\r\n\f ]+/g, ' ');
}

// 文本节点转 Markdown 行内文本：转义会与 Markdown 语法冲突的字符，避免生成脏结构。
function escapeInlineText(value: string): string {
  return value.replace(/[\\`*_[\]<>~|&]/g, '\\$&');
}

function wrapInline(open: string, close: string, inner: string): string {
  if (!inner) return '';
  const leading = /^[ \t]+/.exec(inner)?.[0] ?? '';
  const trailing = inner.slice(leading.length).match(/[ \t]+$/)?.[0] ?? '';
  const core = inner.slice(leading.length, inner.length - trailing.length);
  if (!core.trim()) return inner;
  return leading + open + core + close + trailing;
}

function inlineCodeSpan(text: string): string {
  const value = text.replace(/\s+/g, ' ');
  if (!value) return '';
  const runs = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1), 1));
  const pad = /^[` ]|[` ]$/.test(value) ? ' ' : '';
  return fence + pad + value + pad + fence;
}

function isBoldWeight(value: string): boolean {
  const weight = value.trim().toLowerCase();
  if (weight === 'bold' || weight === 'bolder') return true;
  if (weight === 'normal' || weight === 'lighter') return false;
  const numeric = Number(weight);
  return Number.isFinite(numeric) && numeric >= 600;
}

// 解析 style 中得到映射的行内格式，并统计 Markdown 无法表达的格式项。
function styleInfo(element: Element, ctx: Context, options: { tableCell?: boolean } = {}): StyleMarks {
  const style = element.getAttribute('style');
  if (!style) return {};
  const marks: StyleMarks = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().toLowerCase();
    if (!value) continue;
    switch (property) {
      case 'font-weight': marks.bold = isBoldWeight(value); break;
      case 'font-style': if (/italic|oblique/.test(value)) marks.italic = true; else if (/^normal/.test(value)) marks.italic = false; break;
      case 'text-decoration': case 'text-decoration-line': case '-webkit-text-decoration':
        if (/underline/.test(value)) marks.underline = true;
        if (/line-through/.test(value)) marks.strike = true;
        break;
      // 颜色、字体、字号、行距、对齐等 Markdown 无法表达：忽略并计数。
      case 'color': case 'background': case 'background-color': case 'font': case 'font-family': case 'font-size':
      case 'line-height': case 'letter-spacing': case 'word-spacing': case 'vertical-align':
        ctx.ignored++; break;
      case 'text-align':
        if (!options.tableCell) ctx.ignored++;
        break;
      default: break;
    }
  }
  return marks;
}

function inlineNodes(nodes: readonly Node[], ctx: Context): string {
  let output = '';
  for (const node of nodes) {
    if (node.nodeType === 3) { output += escapeInlineText(normalizeText((node as Text).data)); continue; }
    if (node.nodeType !== 1) continue;
    output += inlineElement(node as Element, ctx);
  }
  return output;
}

function inlineElement(element: Element, ctx: Context): string {
  const tag = tagName(element);
  if (DROP_TAGS.has(tag) || /^[vw]:/.test(tag)) return '';
  const children = Array.from(element.childNodes);
  switch (tag) {
    case 'br': return BR_MARK;
    case 'img': return imageMarkdown(element, ctx);
    case 'wbr': return '';
    case 'b': case 'strong': {
      styleInfo(element, ctx);
      return wrapInline('**', '**', inlineNodes(children, ctx));
    }
    case 'i': case 'em': {
      styleInfo(element, ctx);
      const inner = inlineNodes(children, ctx);
      return wrapInline('*', '*', inner);
    }
    case 'u': case 'ins': {
      styleInfo(element, ctx);
      const inner = inlineNodes(children, ctx);
      return wrapInline('<u>', '</u>', inner);
    }
    case 's': case 'strike': case 'del': {
      styleInfo(element, ctx);
      const inner = inlineNodes(children, ctx);
      return wrapInline('~~', '~~', inner);
    }
    case 'code': {
      styleInfo(element, ctx);
      return inlineCodeSpan(extractText(element, { breaks: false }));
    }
    case 'a': {
      styleInfo(element, ctx);
      const inner = inlineNodes(children, ctx);
      return linkMarkdown(element, inner, ctx);
    }
    case 'sup': return `<sup>${inlineNodes(children, ctx)}</sup>`;
    case 'sub': return `<sub>${inlineNodes(children, ctx)}</sub>`;
    case 'font': {
      for (const attr of ['color', 'face', 'size']) if (element.hasAttribute(attr)) ctx.ignored++;
      const marks = styleInfo(element, ctx);
      return applyMarks(inlineNodes(children, ctx), marks, ctx);
    }
    case 'small': case 'big': ctx.ignored++; {
      const marks = styleInfo(element, ctx);
      return applyMarks(inlineNodes(children, ctx), marks, ctx);
    }
    case 'mark': ctx.ignored++; {
      const marks = styleInfo(element, ctx);
      return applyMarks(inlineNodes(children, ctx), marks, ctx);
    }
    case 'center': ctx.ignored++; {
      const marks = styleInfo(element, ctx);
      return applyMarks(inlineNodes(children, ctx), marks, ctx);
    }
    case 'input': return '';
    default: {
      const marks = styleInfo(element, ctx);
      return applyMarks(inlineNodes(children, ctx), marks, ctx);
    }
  }
}

function applyMarks(inner: string, marks: StyleMarks, ctx: Context): string {
  void ctx;
  let content = inner;
  if (marks.strike) content = wrapInline('~~', '~~', content);
  if (marks.underline) content = wrapInline('<u>', '</u>', content);
  if (marks.italic) content = wrapInline('*', '*', content);
  if (marks.bold) content = wrapInline('**', '**', content);
  return content;
}

function linkMarkdown(element: Element, inner: string, ctx: Context): string {
  const rawHref = element.getAttribute('href');
  if (!rawHref || !rawHref.trim()) return inner;
  if (!safeLinkUrl(rawHref)) { ctx.ignored++; return inner; }
  const href = rawHref.trim();
  const text = inner.trim() || escapeInlineText(href);
  const title = element.getAttribute('title');
  const destination = /[\s()<>]/.test(href)
    ? `<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : href;
  const suffix = title ? ` "${title.replace(/(["\\])/g, '\\$1')}"` : '';
  return `[${text}](${destination}${suffix})`;
}

function imageMarkdown(element: Element, ctx: Context): string {
  const src = (element.getAttribute('src') ?? '').trim();
  if (!src) { ctx.skippedImages++; return ''; }
  const alt = (element.getAttribute('alt') ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (element.hasAttribute('width') || element.hasAttribute('height')) ctx.ignored++;
  if (/^data:image\//i.test(src)) {
    const image = { token: '', kind: 'data' as const, src, alt };
    image.token = IMAGE_TOKEN(ctx.images.length);
    ctx.images.push(image);
    return image.token;
  }
  if (/^https?:/i.test(src)) { ctx.remoteImages++; return imageDestination(alt, src); }
  if (/^blob:/i.test(src)) { ctx.skippedImages++; return ''; }
  const image = { token: '', kind: 'local' as const, src, alt };
  image.token = IMAGE_TOKEN(ctx.images.length);
  ctx.images.push(image);
  return image.token;
}

function imageDestination(alt: string, src: string): string {
  const cleanAlt = alt.replace(/[[\]()]/g, '');
  const destination = /[\s()<>]/.test(src)
    ? `<${src.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : src;
  return `![${cleanAlt}](${destination})`;
}

/** 提取元素文本；pre/代码块中 <br> 视作换行。 */
function extractText(element: Element, options: { breaks: boolean }): string {
  let output = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) { output += (node as Text).data; return; }
    if (node.nodeType !== 1) return;
    const tag = tagName(node as Element);
    if (DROP_TAGS.has(tag) || /^[vw]:/.test(tag)) return;
    if (tag === 'br') { output += options.breaks ? '\n' : ' '; return; }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(element.childNodes)) walk(child);
  return output;
}

function hasBlockChild(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    if (BLOCK_TAGS.has(tagName(child))) return true;
  }
  return false;
}

function isBlockElement(element: Element): boolean {
  const tag = tagName(element);
  if (tag === 'br' || tag === 'img' || INLINE_TAGS.has(tag)) return false;
  if (BLOCK_TAGS.has(tag)) return true;
  return hasBlockChild(element);
}

// Word 列表段落：<p style="mso-list:l0 level1 lfo1"> + mso-list:Ignore 标记。
function wordListInfo(paragraph: Element): { level: number; ordered: boolean; marker: string } | null {
  const style = paragraph.getAttribute('style') ?? '';
  const match = /mso-list\s*:\s*([^;]+)/i.exec(style);
  if (!match) return null;
  const level = Number(/level(\d+)/i.exec(match[1])?.[1] ?? 1) || 1;
  let marker = '';
  const ignore = paragraph.querySelector<HTMLElement>('span[style*="mso-list"], span[style*="MsoList"], span[style*="mso-list"]');
  if (ignore) marker = ignore.textContent ?? '';
  if (!marker.trim()) {
    const leading = (paragraph.textContent ?? '').replace(/^[\s\u00a0]+/, '');
    marker = /^(?:\d{1,9}[.)]|\(?\d{1,9}[.)]|\(?[a-zA-Z][.)]|[•·◦○●▪■□❖➤►✓✔\uF000-\uF0FF])/.exec(leading)?.[0] ?? '';
  }
  const trimmed = marker.trim();
  const ordered = /^\(?\d{1,9}[.)]/.test(trimmed) || /^\(?[a-zA-Z][.)]/.test(trimmed);
  return { level: Math.max(1, Math.min(9, level)), ordered, marker };
}

function wordListContent(paragraph: Element, ctx: Context): string {
  const clone = paragraph.cloneNode(true) as Element;
  for (const span of Array.from(clone.querySelectorAll('span'))) {
    if (/mso-list/i.test(span.getAttribute('style') ?? '')) span.remove();
  }
  const text = inlineNodes(Array.from(clone.childNodes), ctx).replace(new RegExp(BR_MARK, 'g'), '  \n').trim();
  // 部分导出器把编号直接写成文本，去掉重复的标记。
  return text.replace(/^(?:\d{1,9}[.)]|\(?\d{1,9}[.)]|\(?[a-zA-Z][.)]|[•·◦○●▪■□❖➤►]|\uF000-\uF0FF)[\s\u00a0]*/, '').trimStart();
}

function renderWordList(items: readonly { level: number; ordered: boolean; content: string }[]): string {
  const state: { ordered: boolean; counter: number }[] = [];
  const lines: string[] = [];
  for (const item of items) {
    const level = Math.max(1, Math.min(9, item.level));
    while (state.length > level) state.pop();
    while (state.length < level) state.push({ ordered: false, counter: 0 });
    const slot = state[level - 1];
    let marker: string;
    if (item.ordered) {
      slot.counter = slot.ordered ? slot.counter + 1 : 1;
      slot.ordered = true;
      marker = `${slot.counter}. `;
    } else {
      slot.ordered = false;
      marker = '- ';
    }
    const indent = '  '.repeat(level - 1);
    const hang = ' '.repeat(indent.length + marker.length);
    const contentLines = item.content.split('\n');
    const first = contentLines.shift() ?? '';
    lines.push(indent + marker + first + contentLines.map(line => '\n' + hang + line).join(''));
  }
  return lines.join('\n');
}

function collectWordList(children: readonly Node[], start: number, ctx: Context): { items: { level: number; ordered: boolean; content: string }[]; next: number } {
  const items: { level: number; ordered: boolean; content: string }[] = [];
  let index = start;
  while (index < children.length) {
    const node = children[index];
    if (node.nodeType === 3) { if (isWhitespaceNode(node)) { index++; continue; } break; }
    if (node.nodeType !== 1) { index++; continue; }
    const element = node as Element;
    const tag = tagName(element);
    if (!/^(?:p|h[1-6]|li)$/.test(tag)) break;
    const info = wordListInfo(element);
    if (!info) break;
    items.push({ level: info.level, ordered: info.ordered, content: wordListContent(element, ctx) });
    index++;
  }
  return { items, next: index };
}

function taskPrefix(element: Element): { prefix: string; first: string } {
  const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="CHECKBOX"]');
  if (checkbox) {
    const checked = checkbox.hasAttribute('checked') || checkbox.checked === true;
    return { prefix: checked ? '[x] ' : '[ ] ', first: '' };
  }
  return { prefix: '', first: '' };
}

function renderList(element: Element, ctx: Context, indent: string): string {
  const ordered = tagName(element) === 'ol';
  const start = Math.max(1, Number(element.getAttribute('start')) || 1);
  const lines: string[] = [];
  let index = 0;
  for (const child of Array.from(element.children)) {
    const tag = tagName(child);
    if (tag !== 'li') {
      // 部分导出器把列表项直接写成段落/div。
      const content = inlineNodes(Array.from(child.childNodes), ctx).replace(new RegExp(BR_MARK, 'g'), '  \n').trim();
      if (!content) continue;
      const marker = ordered ? `${start + index}. ` : '- ';
      index++;
      lines.push(indent + marker + content.split('\n').join('\n' + ' '.repeat(indent.length + marker.length)));
      continue;
    }
    const parts = listItemParts(child, ctx);
    const task = taskPrefix(child);
    let first = task.prefix + parts.first;
    // MDRE 富文本副本用 ☑/☐ 表示任务清单，粘贴回来时还原为 [x]/[ ]。
    if (!task.prefix) {
      const marker = /^\s*([☐☑☒✓✔□■])\s*/u.exec(first);
      if (marker) first = (/[☑☒✓✔■]/u.test(marker[1]) ? '[x] ' : '[ ] ') + first.slice(marker[0].length);
    }
    const marker = ordered ? `${start + index}. ` : '- ';
    index++;
    const hang = ' '.repeat(indent.length + marker.length);
    let line = indent + marker + first;
    for (const block of parts.blocks) line += '\n' + block.split('\n').map(item => hang + item).join('\n');
    for (const nested of parts.nested) line += '\n' + renderList(nested, ctx, hang);
    lines.push(line);
  }
  return lines.join('\n');
}

function listItemParts(element: Element, ctx: Context): { first: string; blocks: string[]; nested: Element[] } {
  const paragraphs: string[] = [];
  const blocks: string[] = [];
  const nested: Element[] = [];
  let buffer: Node[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const text = inlineNodes(buffer, ctx).replace(new RegExp(BR_MARK, 'g'), '  \n').trim();
    buffer = [];
    if (!text) return;
    if (!paragraphs.length) paragraphs.push(text); else blocks.push(text);
  };
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) { buffer.push(child); continue; }
    if (child.nodeType !== 1) continue;
    const tag = tagName(child as Element);
    if (tag === 'input') continue;
    if (tag === 'ul' || tag === 'ol') { flush(); nested.push(child as Element); continue; }
    if (BLOCK_TAGS.has(tag) || (!INLINE_TAGS.has(tag) && hasBlockChild(child as Element))) {
      flush();
      const childBlocks = convertBlock(child as Element, ctx);
      if (!childBlocks.length) continue;
      if (!paragraphs.length && childBlocks.length === 1 && /^(?:p|h[1-6])$/i.test(tag)) {
        paragraphs.push(childBlocks[0]);
      } else blocks.push(...childBlocks);
      continue;
    }
    buffer.push(child);
  }
  flush();
  return { first: paragraphs[0] ?? '', blocks: [...paragraphs.slice(1), ...blocks], nested };
}

function cellContents(cell: Element, ctx: Context): string {
  const chunks: string[] = [];
  let buffer: Node[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const text = inlineNodes(buffer, ctx).replace(new RegExp(BR_MARK, 'g'), '<br>').trim();
    buffer = [];
    if (text) chunks.push(text);
  };
  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === 3) { buffer.push(child); continue; }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = tagName(element);
    if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'li' || tag === 'div') {
      flush();
      const text = inlineNodes(Array.from(element.childNodes), ctx).replace(new RegExp(BR_MARK, 'g'), '<br>').trim();
      if (text) chunks.push(text);
    } else if (tag === 'ul' || tag === 'ol') {
      flush();
      const items = Array.from(element.querySelectorAll(':scope > li')).map(li => inlineNodes(Array.from(li.childNodes), ctx).trim()).filter(Boolean);
      if (items.length) chunks.push(items.join('；'));
    } else if (tag === 'pre') {
      flush();
      const text = extractText(element, { breaks: true }).replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
    } else if (tag === 'table') {
      flush();
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(text);
      ctx.ignored++;
    } else {
      buffer.push(child);
    }
  }
  flush();
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function cellAlignment(cell: Element): 'left' | 'center' | 'right' | '' {
  const align = (cell.getAttribute('align') ?? '').trim().toLowerCase();
  if (align === 'left' || align === 'center' || align === 'right') return align;
  const style = (cell.getAttribute('style') ?? '').toLowerCase();
  const match = /text-align\s*:\s*(left|center|right)/.exec(style);
  return (match?.[1] as 'left' | 'center' | 'right' | undefined) ?? '';
}

function tableRows(table: Element): Element[] {
  return Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table);
}

function rowCells(row: Element): Element[] {
  return Array.from(row.children).filter(cell => /^(?:td|th)$/.test(tagName(cell)));
}

function renderTable(table: Element, ctx: Context): string[] {
  ctx.tables++;
  const rows = tableRows(table).map(rowCells).filter(cells => cells.length > 0);
  if (!rows.length) return [];
  const caption = Array.from(table.children).find(child => tagName(child) === 'caption');
  const captionText = caption ? (caption.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  const merged = rows.some(cells => cells.some(cell => {
    const colspan = Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
    const rowspan = Number.parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1;
    return colspan > 1 || rowspan > 1;
  }));
  if (merged) {
    // 合并单元格无法用 GFM 表格表达：降级为普通段落并计数，由调用方提示。
    ctx.mergedTables++;
    const paragraphs = rows
      .map(cells => cells.map(cell => cellContents(cell, ctx)).filter(Boolean).join(' | '))
      .filter(Boolean);
    return captionText ? [plainParagraph(captionText), ...paragraphs.map(plainParagraph)] : paragraphs.map(plainParagraph);
  }
  const columns = Math.max(...rows.map(cells => cells.length));
  if (!columns) return [];
  const header = rows[0];
  const alignments = Array.from({ length: columns }, (_, index) => header[index] ? cellAlignment(header[index]) : '');
  // 单元格内容已在行内转换中转义过竖线，这里只补未转义的竖线，避免二次转义。
  const escapeCell = (text: string) => text.replace(/(?<!\\)\|/g, '\\|').replace(/\n/g, '<br>');
  const formatRow = (cells: Element[]) => '| ' + Array.from({ length: columns }, (_, index) => {
    if (!cells[index]) return '';
    styleInfo(cells[index], ctx, { tableCell: true });
    return escapeCell(cellContents(cells[index], ctx));
  }).join(' | ') + ' |';
  const separator = '| ' + alignments.map(align => align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---').join(' | ') + ' |';
  const body = rows.slice(1).map(formatRow);
  const tableMarkdown = [formatRow(header), separator, ...body].join('\n');
  return captionText ? [plainParagraph(captionText), tableMarkdown] : [tableMarkdown];
}

function plainParagraph(text: string): string {
  return escapeLineStarts(escapeInlineText(normalizeText(text).trim()));
}

function escapeLineStarts(text: string): string {
  return text.split('\n').map(line => {
    let value = line;
    value = value.replace(/^([ \t]*)(#{1,6})([ \t])/, '$1\\$2$3');
    value = value.replace(/^([ \t]*)([-+*])([ \t])/, '$1\\$2$3');
    value = value.replace(/^([ \t]*)(\d{1,9})([.)])([ \t])/, '$1$2\\$3$4');
    value = value.replace(/^([ \t]*)([>|])/, '$1\\$2');
    value = value.replace(/^([ \t]*)(`{3,}|~{3,})/, '$1\\$2');
    value = value.replace(/^([ \t]*)(-{3,}|={3,})([ \t]*)$/, '$1\\$2$3');
    return value;
  }).join('\n');
}

function paragraphMarkdown(inline: string): string {
  const text = inline.replace(new RegExp(BR_MARK, 'g'), '  \n').trim();
  if (!text) return '';
  return escapeLineStarts(text);
}

function headingMarkdown(level: number, inline: string): string {
  const text = inline.replace(new RegExp(BR_MARK, 'g'), '  \n').trim();
  if (!text) return '';
  return '#'.repeat(Math.max(1, Math.min(6, level))) + ' ' + text.replace(/\n/g, ' ');
}

function codeBlockMarkdown(pre: Element, ctx: Context): string {
  const codeElement = Array.from(pre.children).find(child => tagName(child) === 'code') ?? pre;
  const code = extractText(codeElement, { breaks: true }).replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
  if (!code.trim()) return '';
  const className = `${codeElement.getAttribute('class') ?? ''} ${pre.getAttribute('class') ?? ''} ${codeElement.getAttribute('data-lang') ?? ''}`;
  const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(className)?.[1] ?? '';
  const runs = code.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  void ctx;
  return `${fence}${language}\n${code}\n${fence}`;
}

function convertBlock(element: Element, ctx: Context): string[] {
  const tag = tagName(element);
  if (DROP_TAGS.has(tag) || /^[vw]:/.test(tag)) return [];
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      styleInfo(element, ctx);
      const heading = headingMarkdown(Number(tag.slice(1)), inlineNodes(Array.from(element.childNodes), ctx));
      return heading ? [heading] : [];
    }
    case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'aside': case 'main':
    case 'nav': case 'figure': case 'figcaption': case 'form': case 'fieldset': case 'legend': case 'address':
    case 'dl': case 'dt': case 'dd': case 'details': case 'summary': case 'hgroup': case 'search': case 'menu':
    case 'center': case 'o:p': {
      const style = element.getAttribute('style') ?? '';
      const className = element.getAttribute('class') ?? '';
      // Word 标题：MsoHeading*、MsoTitle 或 mso-outline-level。
      const msoHeading = /Mso(?:Heading|Title)\s*([1-9])?/i.exec(className);
      const outline = /mso-outline-level\s*:\s*([1-9])/i.exec(style);
      if (tag === 'p' && (msoHeading || outline)) {
        const level = Number(msoHeading?.[1] ?? outline?.[1] ?? 1) || 1;
        styleInfo(element, ctx);
        const heading = headingMarkdown(level, inlineNodes(Array.from(element.childNodes), ctx));
        return heading ? [heading] : [];
      }
      styleInfo(element, ctx, { });
      if (hasBlockChild(element) || BLOCK_TAGS.has(tag) && tag !== 'p') {
        const inside = convertBlocks(element, ctx);
        if (inside.length) return tag === 'center' ? inside : inside;
      }
      const paragraph = paragraphMarkdown(inlineNodes(Array.from(element.childNodes), ctx));
      return paragraph ? [paragraph] : [];
    }
    case 'li': {
      styleInfo(element, ctx);
      const paragraph = paragraphMarkdown(inlineNodes(Array.from(element.childNodes), ctx));
      return paragraph ? [paragraph] : [];
    }
    case 'ul': case 'ol': {
      styleInfo(element, ctx);
      const list = renderList(element, ctx, '');
      return list ? [list] : [];
    }
    case 'blockquote': {
      styleInfo(element, ctx);
      const inside = convertBlocks(element, ctx);
      if (!inside.length) return [];
      return [inside.join('\n\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n')];
    }
    case 'pre': {
      styleInfo(element, ctx);
      const code = codeBlockMarkdown(element, ctx);
      return code ? [code] : [];
    }
    case 'table': {
      styleInfo(element, ctx, { tableCell: true });
      return renderTable(element, ctx);
    }
    case 'hr': return ['---'];
    case 'br': return [];
    case 'img': {
      const image = imageMarkdown(element, ctx);
      return image ? [image] : [];
    }
    default: {
      // 未识别元素：有块级子节点时按容器处理，否则按段落。
      if (hasBlockChild(element)) return convertBlocks(element, ctx);
      const paragraph = paragraphMarkdown(inlineNodes(Array.from(element.childNodes), ctx));
      return paragraph ? [paragraph] : [];
    }
  }
}

function convertBlocks(parent: Element | DocumentFragment, ctx: Context): string[] {
  const blocks: string[] = [];
  let buffer: Node[] = [];
  let index = 0;
  const flush = () => {
    if (!buffer.length) return;
    const paragraph = paragraphMarkdown(inlineNodes(buffer, ctx));
    buffer = [];
    if (paragraph) blocks.push(paragraph);
  };
  const children = Array.from(parent.childNodes);
  index = 0;
  while (index < children.length) {
    const node = children[index];
    if (node.nodeType === 3) {
      if (!isWhitespaceNode(node)) buffer.push(node);
      index++;
      continue;
    }
    if (node.nodeType !== 1) { index++; continue; }
    const element = node as Element;
    if (isBlockElement(element)) {
      flush();
      const tag = tagName(element);
      if (/^(?:p|h[1-6]|li)$/.test(tag) && wordListInfo(element)) {
        const collected = collectWordList(children, index, ctx);
        if (collected.items.length) blocks.push(renderWordList(collected.items));
        index = Math.max(collected.next, index + 1);
        continue;
      }
      blocks.push(...convertBlock(element, ctx));
      index++;
      continue;
    }
    buffer.push(node);
    index++;
  }
  flush();
  return blocks;
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * 将剪贴板 HTML 转换为 Markdown。
 * 图片位置在结果中是占位符：调用方必须先替换 `images` 再写入源码。
 */
export function htmlToMarkdown(html: string): HtmlConversion {
  if (typeof html !== 'string' || !html.trim()) return emptyConversion();
  let bytes = 0;
  try { bytes = byteLength(html); } catch { bytes = html.length; }
  if (bytes > CLIPBOARD_HTML_LIMIT) return emptyConversion({ oversized: true });
  const document = parseAndClean(html);
  if (!document) return emptyConversion();
  const ctx = newContext();
  const blocks = convertBlocks(document.body, ctx);
  const markdown = normalizeMarkdown(blocks.join('\n\n'));
  const totalImages = ctx.images.length + ctx.remoteImages + ctx.skippedImages;
  if (totalImages > CLIPBOARD_IMAGE_LIMIT) {
    return emptyConversion({ overImageLimit: true, ignored: ctx.ignored, remoteImages: ctx.remoteImages, tables: ctx.tables, mergedTables: ctx.mergedTables });
  }
  return {
    markdown,
    ignored: ctx.ignored,
    images: ctx.images,
    remoteImages: ctx.remoteImages,
    tables: ctx.tables,
    mergedTables: ctx.mergedTables,
    skippedImages: ctx.skippedImages,
    oversized: false,
    overImageLimit: false,
  };
}

/** 供回退路径使用的纯文本提取（忽略标记、脚本与样式）。 */
export function htmlToPlainText(html: string): string {
  if (typeof html !== 'string' || !html.trim()) return '';
  const document = parseAndClean(html);
  if (!document) return '';
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) { parts.push(normalizeText((node as Text).data)); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = tagName(element);
    if (DROP_TAGS.has(tag) || /^[vw]:/.test(tag)) return;
    if (tag === 'br') { parts.push('\n'); return; }
    if (tag === 'img') {
      const alt = (element.getAttribute('alt') ?? '').trim();
      if (alt) parts.push(alt);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) parts.push('\n');
  };
  walk(document.body);
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 纯文本按 Markdown 字面量插入时的转义（保留用户输入的任何标记字符）。 */
export function plainTextToMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map(line => escapeLineStarts(escapeInlineText(normalizeText(line).replace(/^\s+|\s+$/g, '')) ))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
