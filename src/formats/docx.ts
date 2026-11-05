// 文件格式模块：DOCX（Word）只读渲染。mammoth 负责 OOXML→HTML，本模块负责白名单清洗、标题锚点与告警汇总。
// 纯模块：不访问 Tauri/vscode API、不 import 项目内其他文件；mammoth 浏览器构建按需动态加载。
import type { Mammoth } from 'mammoth/mammoth.browser.min.js';

export interface DocxHeading {
  level: number;
  text: string;
  id: string;
}

export interface DocxRenderOptions {
  /** 覆盖内置文案；键名见 docxLabels（docx.error.* / docx.warning.* / docx.headingFallback）。 */
  labels?: Record<string, string>;
}

export interface DocxRenderResult {
  html: string;
  headings: DocxHeading[];
  warnings: string[];
}

/** 内置文案（宿主可整体替换为本地化文案）。 */
export const docxLabels = {
  'docx.error.empty': '无法转换 Word 文档：文件内容为空。',
  'docx.error.corrupt': '无法读取 Word 文档：文件已损坏或不是有效的 .docx 文件（旧版 .doc 请先另存为 .docx）。',
  'docx.error.convert': '无法转换 Word 文档：{message}',
  'docx.warning.removedEmbed': '已移除文档中的不安全嵌入内容（脚本、框架或对象）。',
  'docx.warning.remoteImage': '文档包含外链图片（已限制为不发送来源信息）：{src}',
  'docx.warning.droppedImage': '已忽略 {count} 个不安全或不受支持的图片地址。',
  'docx.warning.droppedLink': '已忽略 {count} 个不安全的链接地址。',
  'docx.headingFallback': '标题',
} as const;

type Labels = Record<string, string> | undefined;

// ── 白名单 ────────────────────────────────────────────────────────────────
const allowedTags = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'strike', 'code', 'pre', 'mark', 'small',
  'sub', 'sup', 'span', 'div', 'a', 'img', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'section', 'article', 'details', 'summary', 'nav', 'header', 'footer', 'address', 'cite',
  'abbr', 'kbd', 'samp', 'var', 'q', 'time', 'wbr',
  // MathML（mammoth 可输出公式；只保留展示用元素）
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup',
  'munder', 'mover', 'munderover', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'menclose',
  'mfenced', 'mstyle', 'mpadded', 'mphantom', 'mmultiscripts', 'mprescripts', 'none',
]);

const voidTags = new Set(['br', 'hr', 'img', 'wbr', 'col']);

const allowedAttributes = new Set([
  'href', 'title', 'alt', 'src', 'width', 'height', 'class', 'colspan', 'rowspan', 'start', 'align', 'valign',
  'dir', 'lang', 'style', 'abbr', 'datetime', 'cite', 'scope', 'headers', 'open', 'reversed', 'type', 'value', 'span',
  // MathML 属性
  'encoding', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel',
  'linethickness', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines',
  'frame', 'framespacing', 'equalrows', 'equalcolumns', 'side', 'minlabelspacing', 'stretchy', 'symmetric',
  'fence', 'separator', 'notation', 'largeop', 'movablelimits', 'accent', 'accentunder', 'form', 'lspace',
  'rspace', 'voffset', 'minsize', 'maxsize', 'display', 'overflow', 'alttext', 'xmlns',
]);

const booleanAttributes = new Set(['open', 'reversed']);

const blockedSubtrees = /<(script|style|iframe|object|embed|noscript|template|svg|form|meta|link|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const unclosedBlocked = /<(script|style|iframe|object|embed|noscript|template|svg|form)\b[^>]*>[\s\S]*$/gi;

const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][-a-zA-Z0-9:]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

const headingPattern = /<h([1-6])((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/h\1\s*>/gi;

const allowedStyleProperties = new Set([
  'color', 'background-color', 'background', 'font-weight', 'font-style', 'font-family', 'font-size',
  'text-decoration', 'text-decoration-line', 'text-align', 'vertical-align', 'line-height', 'white-space',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top',
  'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'border-color', 'border-style', 'border-width', 'border-collapse', 'border-spacing', 'width',
  'height', 'max-width', 'min-width', 'text-indent', 'word-break', 'overflow-wrap', 'list-style-type',
  'text-transform', 'letter-spacing', 'opacity',
]);

const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', bull: '•', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', infin: '∞', ne: '≠',
  le: '≤', ge: '≥', asymp: '≈', sum: '∑', prod: '∏', radic: '√', int: '∫', part: '∂', nabla: '∇',
  isin: '∈', notin: '∉', cap: '∩', cup: '∪', and: '∧', or: '∨', not: '¬', forall: '∀', exist: '∃', empty: '∅',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

// ── 基础工具 ──────────────────────────────────────────────────────────────
function textOfLabel(labels: Labels, key: string, values?: Record<string, string | number>): string {
  const fallback = (docxLabels as Record<string, string>)[key] ?? key;
  const template = labels?.[key] ?? fallback;
  return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] === undefined ? match : String(values[name])) : template;
}

/** 解码 HTML 实体（数字实体 + 常见命名字体）；未知实体原样保留。 */
export function decodeDocxEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return ''; }
      }
      return match;
    }
    return namedEntities[body] ?? namedEntities[body.toLowerCase()] ?? match;
  });
}

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));

/** 只保留安全的样式声明；危险值（url()/expression()/js 协议等）整条丢弃。 */
function sanitizeStyle(value: string): string {
  const declarations: string[] = [];
  for (const part of value.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const raw = part.slice(colon + 1).trim();
    if (!allowedStyleProperties.has(property) || !raw || raw.length > 200) continue;
    if (/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:/i.test(raw)) continue;
    if (/[<>{}]/.test(raw)) continue;
    declarations.push(`${property}:${raw}`);
  }
  return declarations.join(';');
}

/** 链接协议：只允许 http(s)/mailto/tel、页内锚点与相对地址。 */
function isSafeLink(value: string): boolean {
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (!compact) return false;
  if (compact.startsWith('#')) return true;
  if (/^(?:https?:|mailto:|tel:)/.test(compact)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/.test(compact)) return true;
  return false;
}

/** 图片地址：仅允许 base64 位图 data URL 或 https 外链（后者由调用方补 referrerpolicy 并告警）。 */
function classifyImageSource(value: string): 'data' | 'https' | 'other' {
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)(?:;[a-z0-9=._-]+)*;base64,[a-z0-9+/=]+$/i.test(compact)) return 'data';
  if (/^https:\/\/[^\s"'<>]+$/i.test(compact)) return 'https';
  return 'other';
}

interface SanitizeCounters {
  droppedImages: number;
  droppedLinks: number;
  remoteImages: string[];
}

function sanitizeAttributes(tag: string, rawAttributes: string, counters: SanitizeCounters): string[] {
  const attributes: string[] = [];
  attributePattern.lastIndex = 0;
  for (let match = attributePattern.exec(rawAttributes); match; match = attributePattern.exec(rawAttributes)) {
    const name = match[1].toLowerCase();
    const hasValue = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined;
    const value = decodeDocxEntities(match[2] ?? match[3] ?? match[4] ?? '');
    // 事件属性、脚本入口、表单目标与预加载类属性一律丢弃。
    if (name.startsWith('on') || ['srcdoc', 'formaction', 'action', 'srcset', 'ping', 'background', 'poster', 'xlink:href'].includes(name)) continue;
    // id 由 annotateDocxHeadings 统一生成；data-/aria- 前缀属性保留。
    if (name === 'id') continue;
    if (!allowedAttributes.has(name) && !name.startsWith('data-') && !name.startsWith('aria-')) continue;
    if (name === 'href') {
      if (!isSafeLink(value)) { counters.droppedLinks++; continue; }
      attributes.push(`href="${escapeHtml(value)}"`);
      continue;
    }
    if (name === 'src') {
      if (tag !== 'img') continue;
      const kind = classifyImageSource(value);
      if (kind === 'data') { attributes.push(`src="${escapeHtml(value)}"`); continue; }
      if (kind === 'https') {
        counters.remoteImages.push(value);
        attributes.push(`src="${escapeHtml(value)}"`, 'referrerpolicy="no-referrer"', 'loading="lazy"');
        continue;
      }
      counters.droppedImages++;
      continue;
    }
    if (name === 'style') {
      const style = sanitizeStyle(value);
      if (style) attributes.push(`style="${escapeHtml(style)}"`);
      continue;
    }
    if (name === 'width' || name === 'height') {
      // HTML 尺寸（px/%）与 MathML 长度（em/ex/pt 等）共用；只接受数字加安全单位。
      const dimension = /^\d{1,6}(?:\.\d{1,3})?(?:px|%|em|ex|pt|pc|cm|mm|in|rem|vw|vh)?$/.exec(value.trim());
      if (dimension) attributes.push(`${name}="${dimension[0]}"`);
      continue;
    }
    if (name === 'colspan' || name === 'rowspan' || name === 'start' || name === 'span' || name === 'value') {
      if (/^\d{1,5}$/.test(value.trim())) attributes.push(`${name}="${value.trim()}"`);
      continue;
    }
    if (name === 'type') {
      if (/^[A-Za-z0-9]{1,8}$/.test(value.trim())) attributes.push(`type="${value.trim()}"`);
      continue;
    }
    if (name === 'class') {
      const classes = value.split(/\s+/).filter(part => /^[A-Za-z_][\w-]{0,63}$/.test(part)).slice(0, 8);
      if (classes.length) attributes.push(`class="${escapeHtml(classes.join(' '))}"`);
      continue;
    }
    if (name === 'xmlns') {
      if (/^https?:\/\/www\.w3\.org\/1998\/Math\/MathML$/.test(value.trim())) attributes.push(`xmlns="${escapeHtml(value.trim())}"`);
      continue;
    }
    if (!hasValue) {
      if (booleanAttributes.has(name)) attributes.push(name);
      continue;
    }
    if (value.length > 500) continue;
    attributes.push(`${name}="${escapeHtml(value)}"`);
  }
  return attributes;
}

/**
 * mammoth 输出的 HTML 白名单清洗（纯字符串实现，可在无 DOM 的 Node 单测中运行）。
 * 丢弃 script/style/iframe/object 等子树、on* 事件属性、危险 URL 与不安全的 style 声明；
 * 图片仅保留 base64 data URL 与 https 外链。返回清洗后的 HTML 与用户可见告警。
 */
export function sanitizeDocxHtml(html: string, labels?: Labels): { html: string; warnings: string[] } {
  const source = typeof html === 'string' ? html : '';
  const warnings: string[] = [];
  let removedEmbed = false;
  // 先整段移除危险子树（含其文本内容），再兜底处理没有闭合标签的同类元素。
  let body = source.replace(blockedSubtrees, () => { removedEmbed = true; return ''; });
  body = body.replace(unclosedBlocked, () => { removedEmbed = true; return ''; });
  if (removedEmbed) warnings.push(textOfLabel(labels, 'docx.warning.removedEmbed'));
  const counters: SanitizeCounters = { droppedImages: 0, droppedLinks: 0, remoteImages: [] };
  let output = '';
  let cursor = 0;
  tagPattern.lastIndex = 0;
  for (let match = tagPattern.exec(body); match; match = tagPattern.exec(body)) {
    output += body.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    const raw = match[0];
    if (raw.startsWith('<!--')) continue; // 注释整体丢弃
    const closing = raw.startsWith('</');
    const tag = match[1].toLowerCase();
    if (!allowedTags.has(tag)) continue; // 不在白名单内的标签丢弃（其文本内容保留）
    if (closing) {
      if (!voidTags.has(tag)) output += `</${tag}>`;
      continue;
    }
    const selfClosing = /\/\s*>$/.test(raw);
    const attributes = sanitizeAttributes(tag, match[2], counters);
    // 没有可用 src 的图片不渲染空占位。
    if (tag === 'img' && !attributes.some(attribute => attribute.startsWith('src='))) continue;
    const suffix = attributes.length ? ` ${attributes.join(' ')}` : '';
    output += `<${tag}${suffix}${selfClosing && !voidTags.has(tag) ? '/' : ''}>`;
  }
  output += body.slice(cursor);
  if (counters.droppedImages) warnings.push(textOfLabel(labels, 'docx.warning.droppedImage', { count: counters.droppedImages }));
  if (counters.droppedLinks) warnings.push(textOfLabel(labels, 'docx.warning.droppedLink', { count: counters.droppedLinks }));
  for (const remote of counters.remoteImages.slice(0, 3)) warnings.push(textOfLabel(labels, 'docx.warning.remoteImage', { src: remote.length > 160 ? `${remote.slice(0, 157)}…` : remote }));
  return { html: output, warnings };
}

/** 把标题文字规整为稳定、可读的锚点片段（保留 Unicode 字母/数字，中文可直接作为 id）。 */
export function docxHeadingSlug(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** 去掉内联标签、解码实体并压缩空白，得到标题纯文本。 */
export function headingText(innerHtml: string): string {
  return decodeDocxEntities(innerHtml.replace(/<\/?[a-zA-Z][^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * 为有序标题生成稳定 id 并回写到 `<hN>` 标签（同一文档内容重复渲染得到相同 id）。
 * 重复标题追加 `-2`、`-3`；空标题使用本地化的兜底文字生成 `docx-section` 一类 id。
 */
export function annotateDocxHeadings(html: string, labels?: Labels): { html: string; headings: DocxHeading[] } {
  const headings: DocxHeading[] = [];
  const used = new Map<string, number>();
  const fallbackSlug = docxHeadingSlug(textOfLabel(labels, 'docx.headingFallback')) || 'section';
  let output = '';
  let cursor = 0;
  headingPattern.lastIndex = 0;
  for (let match = headingPattern.exec(html); match; match = headingPattern.exec(html)) {
    output += html.slice(cursor, match.index);
    cursor = headingPattern.lastIndex;
    const level = Number(match[1]);
    const text = headingText(match[3]);
    const base = `docx-${(text ? docxHeadingSlug(text) : '') || fallbackSlug}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    headings.push({ level, text, id });
    output += `<h${level} id="${escapeHtml(id)}">${match[3]}</h${level}>`;
  }
  output += html.slice(cursor);
  return { html: output, headings };
}

// ── mammoth 按需加载与转换 ────────────────────────────────────────────────
let mammothLoader: Promise<Mammoth> | null = null;

/** 动态加载 mammoth 浏览器构建（首次约 405 KB，之后复用同一 Promise）。 */
async function loadMammoth(): Promise<Mammoth> {
  if (!mammothLoader) {
    mammothLoader = import('mammoth/mammoth.browser.min.js').then(module => {
      const imported = module as unknown as { default?: Mammoth };
      return imported.default ?? (module as unknown as Mammoth);
    });
  }
  return mammothLoader;
}

function normalizeArrayBuffer(buffer: ArrayBuffer): ArrayBuffer | null {
  if (buffer instanceof ArrayBuffer) return buffer;
  // 兼容传入 Uint8Array/DataView 的宿主（类型契约仍是 ArrayBuffer）。
  const view = buffer as unknown as ArrayBufferView;
  if (ArrayBuffer.isView(view)) return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  return null;
}

/**
 * 把 DOCX 字节转换为只读 HTML、标题大纲与告警。
 * 失败时抛出带可读中文说明的 Error（labels 可覆盖文案）。
 */
export async function renderDocx(buffer: ArrayBuffer, options: DocxRenderOptions = {}): Promise<DocxRenderResult> {
  const labels = options.labels;
  const arrayBuffer = normalizeArrayBuffer(buffer);
  if (!arrayBuffer || arrayBuffer.byteLength === 0) throw new Error(textOfLabel(labels, 'docx.error.empty'));
  let converted: { value: string; messages: { type: string; message: string }[] };
  try {
    const mammoth = await loadMammoth();
    converted = await mammoth.convertToHtml({ arrayBuffer });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const corrupt = /zip|corrupt|end of data|invalid|central directory|not a/i.test(message);
    throw new Error(textOfLabel(labels, corrupt ? 'docx.error.corrupt' : 'docx.error.convert', { message }));
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const item of converted.messages ?? []) {
    const message = item?.message ? String(item.message).trim() : '';
    if (!message || seen.has(message)) continue;
    seen.add(message);
    warnings.push(message);
  }
  const sanitized = sanitizeDocxHtml(converted.value ?? '', labels);
  warnings.push(...sanitized.warnings.filter(message => !seen.has(message)));
  const annotated = annotateDocxHeadings(sanitized.html, labels);
  return { html: annotated.html, headings: annotated.headings, warnings };
}
