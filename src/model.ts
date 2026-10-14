import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { Schema, Node as PMNode, Mark } from 'prosemirror-model';
import { sanitizeHtml, htmlInlineTags } from './render/html';
import { absoluteImagePath } from './image-path';

export type Range = { from: number; to: number };
export type Character = Range & { pos: number; text: string; marks: readonly Mark[]; block: string };
// 行内原子节点（图片、内联 HTML）同样保留源码区间，供源码弹窗与图片宽度手柄使用。
export type Atom = Range & { pos: number; block: string; kind: 'image' | 'html' | 'math' | 'footnote' };
export type Block = Range & { id: string; type: string; pos: number; node: PMNode; parent: string | null };
export type Model = { source: string; doc: PMNode; chars: Character[]; atoms: Atom[]; blocks: Block[]; offsets: number[]; nextId: number };

const blockAttrs = { id: { default: '' } };

// S-1：显式标题 ID 原样保留（不做 slug 规范化），自动锚点只做保守归一。
export function headingAnchor(text: string, explicit: string | null, index: number): string {
  if (explicit) return explicit;
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return `sec-${base || 'section'}-${index}`;
}
// 标题源码末尾的显式 ID：`## 方法 {#sec-method}`。只匹配行尾，避免误判正文花括号。
const headingIdPattern = /\s*\{#([^\s}]+)\}\s*$/;
export function splitHeadingId(raw: string): { text: string; anchor: string | null } {
  const match = headingIdPattern.exec(raw.replace(/(?:\r\n|\r|\n)[ \t]*$/, ''));
  if (!match) return { text: raw, anchor: null };
  return { text: raw.slice(0, match.index), anchor: match[1] };
}

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', attrs: blockAttrs, toDOM: n => ['p', { 'data-block': n.attrs.id }, 0] },
    heading: { content: 'inline*', group: 'block', attrs: { ...blockAttrs, level: { default: 1 }, anchor: { default: null }, explicitAnchor: { default: null } }, toDOM: n => [`h${n.attrs.level}`, { 'data-block': n.attrs.id, ...(n.attrs.anchor ? { id: n.attrs.anchor } : {}) }, 0] },
    blockquote: { content: 'block+', group: 'block', attrs: blockAttrs, toDOM: n => ['blockquote', { 'data-block': n.attrs.id }, 0] },
    bullet_list: { content: 'list_item+', group: 'block', attrs: blockAttrs, toDOM: n => ['ul', { 'data-block': n.attrs.id }, 0] },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { ...blockAttrs, order: { default: 1 } }, toDOM: n => ['ol', { start: n.attrs.order, 'data-block': n.attrs.id }, 0] },
    list_item: { content: 'block+', attrs: { ...blockAttrs, checked: { default: null } }, toDOM: n => ['li', { 'data-block': n.attrs.id, 'data-item': n.attrs.id, 'data-checked': n.attrs.checked }, 0] },
    table: { content: 'table_row+', group: 'block', attrs: blockAttrs, toDOM: n => ['table', { 'data-block': n.attrs.id }, ['tbody', 0]] },
    table_row: { content: 'table_cell+', attrs: { ...blockAttrs, header: { default: false } }, toDOM: n => ['tr', { 'data-block': n.attrs.id }, 0] },
    table_cell: { content: 'inline*', isolating: true, attrs: { ...blockAttrs, header: { default: false }, align: { default: '' } }, toDOM: n => [n.attrs.header ? 'th' : 'td', { 'data-block': n.attrs.id, 'data-cell': n.attrs.id, ...(n.attrs.align ? { style: `text-align:${n.attrs.align}` } : {}) }, 0] },
    opaque: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, raw: { default: '' }, kind: { default: 'source' }, content: { default: '' }, info: { default: '' } }, toDOM: n => ['div', { class: 'opaque', 'data-block': n.attrs.id }, `${n.attrs.kind} · 双击编辑源码`] },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: {}, alt: { default: '' }, title: { default: '' }, width: { default: null }, dimensions: { default: null } }, toDOM: n => ['img', { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title, ...(n.attrs.width ? { width: n.attrs.width } : {}) }] },
    raw_inline: { inline: true, group: 'inline', atom: true, attrs: { raw: {} }, toDOM: n => ['code', { class: 'raw-inline' }, n.attrs.raw] },
    // S-2：数学公式。行内与块级分开，便于块级参与顶层结构操作。
    math_inline: { inline: true, group: 'inline', atom: true, attrs: { latex: {} }, toDOM: n => ['span', { class: 'math-inline' }, n.attrs.latex] },
    math_block: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, latex: { default: '' } }, toDOM: n => ['div', { class: 'math-block', 'data-block': n.attrs.id }, n.attrs.latex] },
    // S-3：文档内目录块，内容由标题层级在渲染时生成。
    toc_block: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, title: { default: '目录' } }, toDOM: n => ['nav', { class: 'toc-block', 'data-block': n.attrs.id }, n.attrs.title] },
    // S-4：脚注引用与定义。定义按源码顺序渲染为文末列表并带回链。
    footnote_ref: { inline: true, group: 'inline', atom: true, attrs: { label: {}, index: { default: 0 } }, toDOM: n => ['sup', { class: 'footnote-ref', 'data-label': n.attrs.label }, String(n.attrs.index)] },
    footnote_def: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, label: { default: '' }, text: { default: '' } }, toDOM: n => ['div', { class: 'footnote-def', 'data-block': n.attrs.id, 'data-label': n.attrs.label }, n.attrs.text] },
    footnote_defs: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, items: { default: [] } }, toDOM: n => ['ol', { class: 'footnote-defs', 'data-block': n.attrs.id }] },
    // S-5：文首 YAML 元数据，渲染为折叠条，导出时不输出。
    front_matter: { group: 'block', atom: true, selectable: true, attrs: { ...blockAttrs, raw: { default: '' }, fields: { default: [] } }, toDOM: n => ['div', { class: 'front-matter', 'data-block': n.attrs.id }, n.attrs.raw] },
    hard_break: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
    text: { group: 'inline' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0] }, em: { toDOM: () => ['em', 0] },
    strike: { toDOM: () => ['s', 0] }, code: { toDOM: () => ['code', 0] },
    underline: { toDOM: () => ['u', 0] },
    highlight: { toDOM: () => ['mark', 0] },
    // C-14/C-15/C-16：颜色、背景色、字号与上下标。参数经同一套白名单校验后进入受控样式。
    color: { attrs: { color: {} }, toDOM: m => ['span', { style: `color:${m.attrs.color}` }, 0] },
    bg: { attrs: { bg: {} }, toDOM: m => ['mark', { class: 'bg', style: `background-color:${m.attrs.bg}` }, 0] },
    size: { attrs: { size: {} }, toDOM: m => ['span', { style: `font-size:${m.attrs.size}` }, 0] },
    sup: { toDOM: () => ['sup', 0] },
    sub: { toDOM: () => ['sub', 0] },
    // HTML 保留原始属性；工具栏颜色和高亮仍使用 MDRE 自定义标签。
    html: { attrs: { open: {}, close: {} }, excludes: '', toDOM: mark => {
      const template = document.createElement('template');
      template.innerHTML = sanitizeHtml(String(mark.attrs.open));
      const element = template.content.firstElementChild;
      return [element?.tagName.toLowerCase() || 'span', element ? Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])) : {}, 0];
    } },
    link: { attrs: { href: {}, title: { default: '' } }, inclusive: false, toDOM: m => ['a', { ...m.attrs, rel: 'noopener noreferrer' }, 0] },
  },
});

type Trace = { range: Range; units: Range[] };
type Traced = Token & { meta: Trace | null };
export const markdown = new MarkdownIt('commonmark', { html: true, linkify: false, typographer: false, xhtmlOut: false }).enable(['table', 'strikethrough']);
(markdown.options as typeof markdown.options & { maxNesting: number }).maxNesting = 100;
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = value => /^file:/i.test(value) && !!absoluteImagePath(value) || validateLink(value);
const colors = /^(?:red|blue|green|yellow|orange|purple|black|white|gray|grey|#[0-9a-f]{3}(?:[0-9a-f]{3})?)$/i;
// S-38：字号只接受正有限数值加 em 或 px，与 C.2 的字号参数约束一致。
const sizes = /^(?:\d+(?:\.\d+)?|\.\d+)(?:em|px)$/;
// C-14/C-15/C-16：颜色、背景色、字号共用同一套「成对标签 + 参数白名单」机制。
type TagSpec = { opening: RegExp; closing: string; validate: (value: string) => boolean };
const tagSpecs: Record<string, TagSpec> = {
  // CommonMark 没有下划线标记，使用通用 HTML <u>，并纳入富文本字符映射。
  underline: { opening: /^<u>()/, closing: '</u>', validate: () => true },
  color: { opening: /^\{color:([^}]+)\}/, closing: '{/color}', validate: value => colors.test(value) },
  bg: { opening: /^\{bg:([^}]+)\}/, closing: '{/bg}', validate: value => colors.test(value) },
  size: { opening: /^\{size:([^}]+)\}/, closing: '{/size}', validate: value => sizes.test(value) },
};
const parameterTags = Object.keys(tagSpecs);

function extensionEnd(state: StateInline, kind: string, length: number): number {
  const start = state.pos, stack = [{ kind, from: start + length }];
  state.pos += length;
  try {
    while (state.pos < state.posMax) {
      const pos = state.pos, equal = state.src.startsWith('==', pos);
      let opened: { kind: string; size: number; value?: string } | null = null;
      for (const name of parameterTags) {
        const match = tagSpecs[name].opening.exec(state.src.slice(pos, state.posMax));
        if (match && tagSpecs[name].validate(match[1])) { opened = { kind: name, size: match[0].length, value: match[1] }; break; }
      }
      let closed = '';
      for (const name of parameterTags) if (state.src.startsWith(tagSpecs[name].closing, pos)) { closed = name; break; }
      if (!closed) closed = equal && stack.some(item => item.kind === 'highlight') ? 'highlight' : '';
      if (closed) {
        const top = stack.at(-1)!;
        if (top.kind !== closed || top.from === pos) return -1;
        stack.pop();
        if (!stack.length) return pos;
        state.pos += closed === 'highlight' ? 2 : tagSpecs[closed].closing.length;
      } else if (opened || equal) {
        if (stack.length + state.level >= thisMax(state)) return -1;
        const size = opened ? opened.size : 2;
        stack.push({ kind: opened ? opened.kind : 'highlight', from: pos + size }); state.pos += size;
      } else if (/[\\`<!\[&]/.test(state.src[pos])) {
        // 与原生规则共用代码、转义、HTML 和链接边界，内部的标记不参与外层配对。
        state.md.inline.skipToken(state);
      } else state.pos++;
    }
    return -1;
  } finally { state.pos = start; }
}

// 扩展与 Markdown 共用同一行内规则链；未闭合标签按字面量解析。
markdown.inline.ruler.before('text', 'extensions', (state, silent) => {
  const start = state.pos;
  let opening: { kind: string; text: string; closing: string; value?: string } | null = null;
  for (const name of parameterTags) {
    const match = tagSpecs[name].opening.exec(state.src.slice(start, state.posMax));
    if (match && tagSpecs[name].validate(match[1])) { opening = { kind: name, text: match[0], closing: tagSpecs[name].closing, value: match[1] }; break; }
  }
  if (!opening && state.src.startsWith('==', start)) opening = { kind: 'highlight', text: '==', closing: '==' };
  if (!opening) return false;
  const end = extensionEnd(state, opening.kind, opening.text.length);
  if (end < 0) return false;
  if (!silent) {
    const kind = opening.kind;
    const oldMax = state.posMax;
    const token = state.push(`${kind}_open`, kind === 'highlight' ? 'mark' : kind === 'underline' ? 'u' : 'span', 1) as Traced;
    if (kind === 'color') token.attrSet('color', opening.value!);
    else if (kind === 'bg') token.attrSet('bg', opening.value!);
    else if (kind === 'size') token.attrSet('size', opening.value!);
    token.meta = { range: { from: start, to: start + opening.text.length }, units: [] };
    state.pos = start + opening.text.length;
    state.posMax = end;
    state.md.inline.tokenize(state);
    const close = state.push(`${kind}_close`, kind === 'highlight' ? 'mark' : kind === 'underline' ? 'u' : 'span', -1) as Traced;
    close.meta = { range: { from: end, to: end + opening.closing.length }, units: [] };
    state.posMax = oldMax;
  }
  state.pos = end + opening.closing.length;
  return true;
});

// S-38：上标 `^x^` 与下标 `~x~`。成对同字符、内容非空且不含未转义空白；
// `~~` 仍优先判为删除线，代码与转义优先于装饰语法。
markdown.inline.ruler.before('text', 'sup_sub', (state, silent) => {
  const marker = state.src[state.pos];
  if (marker !== '^' && marker !== '~') return false;
  if (marker === '~' && state.src[state.pos + 1] === '~') return false;
  const kind = marker === '^' ? 'sup' : 'sub';
  let end = state.pos + 1;
  while (end < state.posMax) {
    const at = state.src.indexOf(marker, end);
    if (at < 0 || at >= state.posMax) return false;
    if (state.src[at - 1] === '\\') { end = at + 1; continue; }
    const content = state.src.slice(state.pos + 1, at);
    if (!content || /[\s]/.test(content)) return false;
    if (silent) return true;
    const token = state.push(`${kind}_open`, kind, 1) as Traced;
    token.meta = { range: { from: state.pos, to: at + 1 }, units: [] };
    const inner = state.push('text', '', 0) as Traced;
    inner.content = content;
    inner.meta = { range: { from: state.pos + 1, to: at }, units: Array.from({ length: content.length }, (_, index) => ({ from: state.pos + 1 + index, to: state.pos + 2 + index })) };
    const close = state.push(`${kind}_close`, kind, -1) as Traced;
    close.meta = { range: { from: at, to: at + 1 }, units: [] };
    state.pos = at + 1;
    return true;
  }
  return false;
});

// 原生 text 规则不会在 = / { 处停下，增加终止符而不改变其它语法。
markdown.inline.ruler.before('text', 'extension_text', (state, silent) => {
  if (silent) return false;
  const rest = state.src.slice(state.pos, state.posMax);
  const stop = rest.search(/[\n\\`*\[\]!<&_~={}$^]/);
  if (stop === 0) return false;
  const length = stop < 0 ? rest.length : stop;
  state.pending += rest.slice(0, length);
  state.pos += length;
  return true;
});

// S-2：行内公式 `$...$`。`$$` 交由块级规则处理；转义、代码与行内 HTML 优先。
markdown.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  if (/\s/.test(state.src[state.pos + 1] ?? '')) return false;
  let end = state.pos + 1;
  while (end < state.posMax) {
    const at = state.src.indexOf('$', end);
    if (at < 0 || at >= state.posMax) return false;
    if (state.src[at - 1] === '\\') { end = at + 1; continue; }
    if (at === state.pos + 1) return false;
    const latex = state.src.slice(state.pos + 1, at);
    // `$4\\times4$` 是合法公式；金额 `$5 和 $10` 由结束符后的数字及空白边界消歧。
    if (/\s$/.test(latex) || /[0-9]/.test(state.src[at + 1] ?? '')) return false;
    if (!silent) {
      const token = state.push('math_inline', 'span', 0) as Traced;
      token.content = latex;
      token.meta = { range: { from: state.pos, to: at + 1 }, units: [] };
    }
    state.pos = at + 1;
    return true;
  }
  return false;
});

// S-4：脚注引用 `[^label]`，必须先于原生 link 规则。
markdown.inline.ruler.before('link', 'footnote_ref', (state, silent) => {
  if (!state.src.startsWith('[^', state.pos)) return false;
  const match = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) {
    const token = state.push('footnote_ref', 'sup', 0) as Traced;
    token.content = match[1];
    token.meta = { range: { from: state.pos, to: state.pos + match[0].length }, units: [] };
  }
  state.pos += match[0].length;
  return true;
});

type BlockItem = { label: string; text: string; from: number; to: number };
type BlockState = { src: string; bMarks: number[]; eMarks: number[]; tShift: number[]; sCount: number[]; line: number; lineMax: number };
type CoreState = { tokens: Traced[]; env: Record<string, unknown>; src: string };

// S-5：文首 YAML front matter 必须位于文件第 0 字节，且首尾均为恰好三个连字符。
// 规则用数组语法注册：本项目 style 是「规则函数 + 规则名」，与 ruler 的 alt 约定一致。
markdown.block.ruler.before('table', 'front_matter', (state) => {
  const start = (state as unknown as BlockState).bMarks[(state as unknown as BlockState).line];
  if (start !== 0) return false;
  if (!/^---[ \t]*(?:\r?\n|$)/.test((state as unknown as BlockState).src)) return false;
  const lines = (state as unknown as BlockState).src.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break; }
  if (end < 0) return false;
  // 没有 YAML 字段的分隔线/Setext 标题组合仍是 CommonMark 正文。
  if (!lines.slice(1, end).some(line => /^[A-Za-z_][\w.-]*\s*:/.test(line))) return false;
  const token = state.push('front_matter', 'div', 0) as Traced;
  const offsets = (state as unknown as BlockState);
  token.content = lines.slice(0, end + 1).join('\n');
  token.map = [0, end + 1];
  token.meta = { range: { from: 0, to: offsets.bMarks[Math.min(end + 1, offsets.bMarks.length - 1)] ?? (state as unknown as BlockState).src.length }, units: [] };
  (state as unknown as BlockState).line = end + 1;
  return true;
}, { alt: ['paragraph', 'reference'] });

type BlockToken = Traced & { map?: number[]; content: string; type: string };
// S-3 / S-2 / S-4：目录段落、块级公式、脚注定义三种独立成段的块。前置扫描避免与原段落规则产生“终止规则”歧义。
markdown.block.ruler.before('table', 'special_blocks', (state, startLine, endLine, silent) => {
  const s = state as unknown as BlockState;
  const from = s.bMarks[startLine] + s.tShift[startLine];
  const to = s.eMarks[startLine];
  const line = state.src.slice(from, to).trim();
  // S-3：[toc] 必须独占一个段落。
  if (/^\[toc\]$/i.test(line)) {
    if (silent) return true;
    const token = state.push('toc_block', 'nav', 0) as BlockToken;
    token.map = [startLine, startLine + 1];
    token.content = 'toc';
    state.line = startLine + 1;
    return true;
  }
  // S-4：连续的 `[^label]: 文本` 行合成一个定义组。
  const first = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
  if (first) {
    if (silent) return true;
    const items: BlockItem[] = [];
    let cursor = startLine;
    // 定义块在第一个空行处结束，避免把后文误并入脚注。
    while (cursor < endLine) {
      const lineFrom = s.bMarks[cursor] + s.tShift[cursor];
      const raw = state.src.slice(lineFrom, s.eMarks[cursor]);
      if (!raw.trim()) break;
      const match = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(raw.trim());
      if (!match) break;
      const textParts = [match[2]];
      if (cursor + 1 < endLine) {
        const rawNext = state.src.slice(s.bMarks[cursor + 1], s.eMarks[cursor + 1]);
        // 缩进续行属于同一条脚注。
        if (/^(?: {2,}|\t)/.test(rawNext) && rawNext.trim()) {
          cursor++;
          textParts.push(rawNext.trim());
        }
      }
      items.push({ label: match[1], text: textParts.join(' '), from: lineFrom, to: s.eMarks[cursor] });
      cursor++;
    }
    const token = state.push('footnote_defs', 'ol', 0) as BlockToken;
    token.map = [startLine, cursor];
    token.content = JSON.stringify(items);
    state.line = cursor;
    return true;
  }
  // S-2：`$$` 独占一行时按块级公式处理，直到闭合的 `$$`。
  if (/^\$\$[ \t]*$/.test(line)) {
    let cursor = startLine + 1, body: string[] = [], closed = false;
    while (cursor < endLine) {
      const raw = state.src.slice(s.bMarks[cursor] + s.tShift[cursor], s.eMarks[cursor]);
      if (/^\$\$[ \t]*$/.test(raw.trim())) { closed = true; break; }
      body.push(raw.trim());
      cursor++;
    }
    if (!closed) return false;
    if (silent) return true;
    const token = state.push('math_block', 'div', 0) as BlockToken;
    token.map = [startLine, cursor + 1];
    token.content = body.join('\n');
    state.line = cursor + 1;
    return true;
  }
  return false;
}, { alt: ['paragraph', 'reference'] });

// S-5：把 front matter 内 `key: value` 解析成字段表，供导出命名与展示使用。
export function frontMatterFields(raw: string): { key: string; value: string }[] {
  const lines = raw.replace(/\r\n|\r/g, '\n').split('\n');
  const fields: { key: string; value: string }[] = [];
  for (const line of lines.slice(1)) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) break;
    const match = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (match && match[2] !== '') fields.push({ key: match[1], value: match[2].replace(/^["']|["']$/g, '') });
  }
  return fields;
}

const tracedInlineStates = new WeakSet<StateInline>();
// 中文紧贴标点时允许粗体边界；其余分隔符配对仍走 markdown-it 原规则。
function cjkStrongDelimiters(state: StateInline) {
  if (tracedInlineStates.has(state)) return;
  tracedInlineStates.add(state);
  const scan = state.scanDelims;
  state.scanDelims = function (start, canSplitWord) {
    const result = scan.call(this, start, canSplitWord);
    if (result.length !== 2 || !/[*_]/.test(this.src[start])) return result;
    const before = this.src[start - 1] ?? '', after = this.src[start + result.length] ?? '';
    if (/\p{Script=Han}/u.test(after) && /\p{P}/u.test(before)) result.can_close = true;
    if (/\p{Script=Han}/u.test(before) && /\p{P}/u.test(after)) result.can_open = true;
    return result;
  };
}

// 仅替换 markdown-it 的分词循环以附加位置；所有语法仍由原规则判定。
markdown.inline.tokenize = function (state) {
  cjkStrongDelimiters(state);
  const rules = this.ruler.getRules('');
  while (state.pos < state.posMax) {
    const start = state.pos;
    const pendingFrom = start - state.pending.length;
    const first = state.tokens.length;
    let matched = false;
    if (state.level < thisMax(state)) {
      for (const rule of rules) if (rule(state, false)) { matched = true; break; }
    }
    if (!matched) state.pending += state.src[state.pos++];
    const end = state.pos;
    let cursor = pendingFrom;
    for (const base of state.tokens.slice(first)) {
      const token = base as Traced;
      if (token.meta) continue;
      let from = cursor, to = end;
      if (token.type === 'link_open') { from = start; to = start + 1; }
      else if (token.type === 'link_close') { from = state.src.lastIndexOf(']', end - 1); to = end; }
      else if (token.type === 'softbreak' || token.type === 'hardbreak') { from = start; to = start + 1; }
      else if (token.type === 'code_inline') {
        from = start + token.markup.length;
        to = end - token.markup.length;
        if (state.src.slice(from, to).startsWith(' ') && state.src.slice(from, to).endsWith(' ') && token.content.trim()) { from++; to--; }
      } else if (token.type === 'text') to = from + token.content.length;
      const same = state.src.slice(from, to).replace(/\n/g, ' ') === token.content;
      token.meta = { range: { from, to }, units: Array.from({ length: token.content.length }, (_, i) => same ? { from: from + i, to: from + i + 1 } : { from, to }) };
      cursor = to;
    }
  }
  if (state.pending) {
    const from = state.pos - state.pending.length, token = state.pushPending() as Traced;
    token.meta = { range: { from, to: state.pos }, units: Array.from({ length: token.content.length }, (_, i) => ({ from: from + i, to: from + i + 1 })) };
  }
};
function thisMax(state: { md: MarkdownIt }) { return (state.md.options as { maxNesting: number }).maxNesting; }
// 不合并相邻 token，否则实体和转义的精确映射会被抹掉。
markdown.inline.ruler2.disable('fragments_join');
// 图片尺寸只接受明确的长度单位。Pandoc 属性保留原文，渲染时换算为 CSS 像素。
export function imageDimensions(text: string): { raw: string; width: number | null } | null {
  const short = /^\{w:(\d+)\}/.exec(text);
  if (short && Number(short[1]) > 0) return { raw: short[0], width: Number(short[1]) };
  const attributes = /^\{((?:\s*(?:width|height)="[\d.]+(?:px|in|cm|mm|pt)"\s*)+)\}/.exec(text);
  if (!attributes) return null;
  let width: number | null = null;
  const units: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72 };
  for (const attribute of attributes[1].matchAll(/(width|height)="([\d.]+)(px|in|cm|mm|pt)"/g)) {
    const value = Number(attribute[2]) * units[attribute[3]];
    if (!Number.isFinite(value) || value <= 0) return null;
    if (attribute[1] === 'width') width = value;
  }
  return { raw: attributes[0], width };
}
// C.1 / Pandoc 图片尺寸参数不进入正文文本，只作为图片属性。
markdown.inline.ruler2.push('image_width', state => {
  for (let i = 0; i < state.tokens.length - 1; i++) {
    const image = state.tokens[i] as Traced, text = state.tokens[i + 1] as Traced;
    if (image.type !== 'image' || text.type !== 'text' || !text.meta) continue;
    const match = imageDimensions(text.content);
    if (!match) continue;
    if (match.width) image.attrSet('width', String(match.width));
    if (!match.raw.startsWith('{w:')) image.attrSet('dimensions', match.raw);
    text.content = text.content.slice(match.raw.length);
    text.meta.range.from += match.raw.length;
    text.meta.units = text.meta.units.slice(match.raw.length);
    if (!text.content) state.tokens.splice(i + 1, 1);
  }
  return false;
});
markdown.core.ruler.at('text_join', state => {
  for (const block of state.tokens) for (const child of block.children || []) if (child.type === 'text_special') child.type = 'text';
});
// S-1：剥离标题末尾的 `{#id}`，让锚点不进入正文文本；同时为每个标题确定唯一锚点。
// 必须早于 text_join，否则子 token 已被合并。
markdown.core.ruler.before('text_join', 'heading_anchor', state => {
  const lines = state.src.split('\n');
  const tokens = state.tokens as Traced[];
  const used = new Set<string>();
  let index = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open' || !token.map) continue;
    index++;
    const at = headingIdPattern.exec((lines[token.map[0]] ?? '').replace(/\r$/, ''));
    const inline = tokens[i + 1];
    if (at && inline?.type === 'inline' && inline.children) {
      let excess = at[0].length;
      for (let j = inline.children.length - 1; j >= 0 && excess > 0; j--) {
        const child = inline.children[j] as Traced;
        if (child.type !== 'text' || !child.meta) continue;
        const remove = Math.min(excess, child.content.length);
        child.content = child.content.slice(0, child.content.length - remove);
        child.meta.units = child.meta.units.slice(0, child.meta.units.length - remove);
        child.meta.range.to = child.meta.range.from + child.content.length;
        excess -= remove;
      }
      inline.children = inline.children.filter(child => child.type !== 'text' || child.content.length > 0);
    }
    const text = inline?.type === 'inline'
      ? (inline.children ?? []).map(child => child.type === 'hardbreak' || child.type === 'softbreak' ? ' ' : child.type === 'image' ? (child.content || '') : child.type.endsWith('_close') ? '' : child.content).join('')
        // 与 ProseMirror 的 textContent 对齐：实体解码后参与锚点归一。
        .replace(/<[^>]*>/g, '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec, hex, name) => {
          if (dec) return String.fromCodePoint(Number(dec));
          if (hex) return String.fromCodePoint(parseInt(hex, 16));
          const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
          return named[String(name).toLowerCase()] ?? whole;
        })
      : '';
    const explicit = at ? at[1] : null;
    let anchor = headingAnchor(text, explicit, index);
    if (used.has(anchor)) { const base = anchor; let suffix = 1; while (used.has(anchor)) anchor = `${base}-${++suffix}`; }
    used.add(anchor);
    token.attrSet('anchor', anchor);
    if (explicit) token.attrSet('explicit-anchor', explicit);
  }
});
// 新块级 token 在静态导出中的占位与语义输出；公式与脚注在导出管线中重建。
markdown.renderer.rules.math_inline = (tokens, i) => `<span class="math-inline" data-latex="${markdown.utils.escapeHtml(tokens[i].content)}"></span>`;
markdown.renderer.rules.math_block = (tokens, i) => `<div class="math-block" data-latex="${markdown.utils.escapeHtml(tokens[i].content)}"></div>\n`;
markdown.renderer.rules.toc_block = () => `<nav class="toc-block" data-toc="1"></nav>\n`;
markdown.renderer.rules.front_matter = () => '';
// S-4：脚注引用与定义组共用同一套编号（按首次引用顺序），导出与预览结果一致。
markdown.renderer.rules.footnote_ref = (tokens, i, _options, env) => {
  const labels = (env.footnoteOrder ??= [] as string[]) as string[];
  const label = tokens[i].content;
  if (!labels.includes(label)) labels.push(label);
  const index = labels.indexOf(label) + 1;
  return `<sup class="footnote-ref" id="footnote-ref-${escapeAttr(label)}"><a href="#footnote-def-${index}">${index}</a></sup>`;
};
markdown.renderer.rules.footnote_defs = (tokens, i, _options, env) => {
  const items = JSON.parse(tokens[i].content || '[]') as { label: string; text: string }[];
  const order = (env.footnoteOrder ??= [] as string[]) as string[];
  for (const item of items) if (!order.includes(item.label)) order.push(item.label);
  const index = (label: string) => order.indexOf(label) + 1;
  const sorted = items.slice().sort((a, b) => index(a.label) - index(b.label));
  return `<div class="footnote-defs"><hr class="footnote-defs-hr"><ol class="footnote-defs-ol">${sorted.map(item => `<li id="footnote-def-${index(item.label)}">${markdown.renderInline(item.text)} <a class="footnote-backref" href="#footnote-ref-${escapeAttr(item.label)}">↩</a></li>`).join('')}</ol></div>\n`;
};
const escapeAttr = (text: string) => markdown.utils.escapeHtml(text);
// S-1：标题输出锚点 id，供文档内跳转、目录与导出 HTML 使用。
markdown.renderer.rules.heading_open = (tokens, i, options, _env, renderer) => {
  const token = tokens[i];
  const anchor = token.attrGet('anchor');
  // `anchor` 是内部属性，不出现在 HTML 中，只映射为 `id`。
  if (token.attrs) token.attrs = token.attrs.filter(attr => attr[0] !== 'anchor' && attr[0] !== 'explicit-anchor');
  if (anchor) token.attrSet('id', anchor);
  return renderer.renderToken(tokens, i, options);
};
markdown.renderer.rules.underline_open = () => '<u>';
markdown.renderer.rules.underline_close = () => '</u>';
markdown.renderer.rules.highlight_open = () => '<mark>';
markdown.renderer.rules.highlight_close = () => '</mark>';
for (const kind of ['color', 'bg', 'size']) {
  markdown.renderer.rules[`${kind}_open`] = (tokens, i) => {
    if (kind === 'color') return `<span style="color:${tokens[i].attrGet('color')}">`;
    if (kind === 'bg') return `<mark class="bg" style="background-color:${tokens[i].attrGet('bg')}">`;
    return `<span style="font-size:${tokens[i].attrGet('size')}">`;
  };
  markdown.renderer.rules[`${kind}_close`] = () => kind === 'bg' ? '</mark>' : '</span>';
}
for (const kind of ['sup', 'sub']) {
  markdown.renderer.rules[`${kind}_open`] = () => `<${kind}>`;
  markdown.renderer.rules[`${kind}_close`] = () => `</${kind}>`;
}
markdown.renderer.rules.html_block = (tokens, i) => sanitizeHtml(tokens[i].content);
markdown.renderer.rules.html_inline = (tokens, i) => sanitizeHtml(tokens[i].content);

// 源码 ↔ 视图偏移映射是纯函数；大文档下每次按键会被反复调用，按同一字符串记忆化。
let cachedNormalize: { source: string; value: { text: string; offsets: number[] } } | null = null;
export function normalize(source: string): { text: string; offsets: number[] } {
  if (cachedNormalize && cachedNormalize.source === source) return cachedNormalize.value;
  let text = '';
  const offsets: number[] = [];
  for (let i = 0; i < source.length; i++) {
    offsets.push(i);
    if (source[i] === '\r') { text += '\n'; if (source[i + 1] === '\n') i++; }
    else text += source[i];
  }
  offsets.push(source.length);
  const value = { text, offsets };
  cachedNormalize = { source, value };
  return value;
}

// 与 markdown-it 表格规则一致：去掉引用前缀与首尾空白后，按未转义 `|` 切分并返回每个单元格内容的源码区间。
export function cellSpans(text: string, start: number, end: number): Range[] {
  const line = text.slice(start, end).replace(/(?:\r\n|\r|\n)$/, '');
  const quote = /^(?:[ \t]*>[ \t]?)+/.exec(line)?.[0] ?? '';
  const content = line.slice(quote.length);
  const lead = content.length - content.replace(/^[ \t]+/, '').length;
  const body = content.replace(/[ \t]+$/, '');
  const base = start + quote.length + lead;
  const parts: Range[] = [];
  let from = 0;
  for (let i = 0; i < body.length; i++) if (body[i] === '|' && body[i - 1] !== '\\') { parts.push({ from, to: i }); from = i + 1; }
  parts.push({ from, to: body.length });
  if (parts.length && body.slice(parts[0].from, parts[0].to) === '') parts.shift();
  if (parts.length && body.slice(parts.at(-1)!.from, parts.at(-1)!.to) === '') parts.pop();
  return parts.map(part => {
    let a = part.from, b = part.to;
    while (a < b && /[ \t]/.test(body[a])) a++;
    while (b > a && /[ \t]/.test(body[b - 1])) b--;
    return { from: base + a, to: base + b };
  });
}

export function parse(source: string, previous?: Model, edit?: Range & { insert: string }): Model {
  const view = normalize(source);
  // BOM 属于原文件编码，解析时略过；编辑器偏移仍包含它。
  const normalized = source.startsWith('\uFEFF') ? { text: view.text.slice(1), offsets: view.offsets.slice(1) } : view;
  const lines = [0];
  for (let i = 0; i < normalized.text.length; i++) if (normalized.text[i] === '\n') lines.push(i + 1);
  lines.push(normalized.text.length);
  const tokens = markdown.parse(normalized.text, {});
  const chars: Character[] = [], atoms: Atom[] = [], blocks: Block[] = [];
  type Frame = { type: string; attrs: Record<string, unknown>; nodes: PMNode[]; range: Range; parent: string | null };
  const stack: Frame[] = [{ type: 'doc', attrs: {}, nodes: [], range: { from: 0, to: source.length }, parent: null }];
  let sequence = 0;
  function addBlock(type: string, token: Token, attrs: Record<string, unknown> = {}, bounds?: Range) {
    const map = token.map!;
    const range = bounds ?? { from: normalized.offsets[lines[map[0]]], to: normalized.offsets[lines[map[1]]] };
    const id = `b${sequence++}`;
    const parent = stack.at(-1)!.attrs.id as string || null;
    stack.push({ type, attrs: { id, ...attrs }, nodes: [], range, parent });
  }
  function finish() {
    const f = stack.pop()!;
    // markdown-it 的空引用范围可能包含后续裸空行；这些空行属于顶层段落。
    if (f.type === 'blockquote') {
      const ending = /(?:[ \t]*(?:\r\n|\r|\n))+$/.exec(source.slice(f.range.from, f.range.to));
      if (ending) { const first = /\r\n|\r|\n/.exec(ending[0])!; f.range.to = f.range.from + ending.index + first.index + first[0].length; }
    }
    if (f.type === 'blockquote') {
      const children = f.nodes.slice(); f.nodes = [];
      const childBlocks = new Map(blocks.filter(b => b.parent === f.attrs.id).map(b => [b.id, b]));
      let end = f.range.from;
      const addEmpty = (at: number) => { const id = `b${sequence++}`, node = schema.nodes.paragraph.create({ id }); f.nodes.push(node); blocks.push({ id, type: 'paragraph', from: at, to: at, pos: 0, node, parent: f.attrs.id as string }); };
      for (const child of children) {
        const block = childBlocks.get(child.attrs.id)!;
        const gap = source.slice(end, block.from).replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
        const count = /^\s*$/.test(gap) ? Math.floor(((gap.match(/\n/g) ?? []).length + (end > f.range.from ? 1 : 0) - 2) / 2) : 0;
        for (let i = 0; i < count; i++) addEmpty(end);
        f.nodes.push(child); end = block.to;
      }
      const tail = source.slice(end, f.range.to).replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
      const count = /^\s*$/.test(tail) ? Math.floor(((tail.match(/\n/g) ?? []).length + (children.length ? 1 : 0)) / 2) : 0;
      for (let i = 0; i < count; i++) addEmpty(end);
      if (!f.nodes.length) addEmpty(f.range.from);
    }
    if (f.type === 'list_item' || f.type === 'bullet_list' || f.type === 'ordered_list') {
      const ending = /(?:[ \t]*(?:\r\n|\r|\n))+$/.exec(source.slice(f.range.from, f.range.to));
      if (ending) { const first = /\r\n|\r|\n/.exec(ending[0])!; f.range.to = f.range.from + ending.index + first.index + first[0].length; }
      // 空列表项在 Markdown 中合法；补一个空段落使其可继续输入，与 M3 的空段一致。
      if (f.type === 'list_item' && !f.nodes.length) {
        const id = `b${sequence++}`, node = schema.nodes.paragraph.create({ id });
        f.nodes.push(node);
        blocks.push({ ...f.range, id, type: 'paragraph', pos: 0, node, parent: f.attrs.id as string });
      }
    }
    const node = schema.nodes[f.type].create(f.attrs, f.nodes);
    stack.at(-1)!.nodes.push(node);
    blocks.push({ ...f.range, id: f.attrs.id as string, type: f.type, pos: 0, node, parent: f.parent });
  }
  let table: { header: boolean; line: number; spans: Range[]; index: number } | null = null;
  // S-4：脚注编号按首次引用顺序，而不是定义顺序。
  const footnoteOrder: string[] = [];
  const collectFootnotes = (list: Token[]) => {
    for (const token of list) {
      if (token.type === 'footnote_ref' && !footnoteOrder.includes(token.content)) footnoteOrder.push(token.content);
      if (token.children) collectFootnotes(token.children);
    }
  };
  collectFootnotes(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'table_open') { addBlock('table', token); table = { header: false, line: token.map![0], spans: [], index: 0 }; continue; }
    if (table) {
      if (token.type === 'thead_open') { table.header = true; continue; }
      if (token.type === 'tbody_open') { table.header = false; continue; }
      if (token.type === 'tr_open') {
        table.line = token.map![0]; table.spans = cellSpans(normalized.text, lines[table.line], lines[table.line + 1]); table.index = 0;
        addBlock('table_row', token, { header: table.header }); continue;
      }
      if (token.type === 'th_open' || token.type === 'td_open') {
        const caret = lines[table.line + 1] - 1;
        const span = table.spans[table.index++] ?? { from: caret, to: caret };
        addBlock('table_cell', { map: [table.line, table.line + 1] } as Token, { header: token.type === 'th_open', align: /text-align:(\w+)/.exec(token.attrGet('style') || '')?.[1] ?? '', cell: span }, { from: normalized.offsets[span.from], to: normalized.offsets[span.to] });
        continue;
      }
      if (token.type === 'th_close' || token.type === 'td_close' || token.type === 'tr_close') { finish(); continue; }
      if (token.type === 'table_close') { finish(); table = null; continue; }
      if (token.type === 'thead_close' || token.type === 'tbody_close') continue;
    }
    if (token.nesting === 1) {
      const type = token.type.replace(/_open$/, '');
      const attrs: Record<string, unknown> = type === 'heading' ? { level: Number(token.tag.slice(1)) } : type === 'ordered_list' ? { order: Number(token.attrGet('start') || 1) } : {};
      if (type === 'list_item') {
        const raw = normalized.text.slice(lines[token.map![0]], lines[token.map![1]]);
        const task = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\](?:\s|$)/.exec(raw);
        attrs.checked = task ? task[1] !== ' ' : null;
      }
      if (type === 'heading') {
        // S-1：锚点由 heading_anchor / heading_anchor_auto 核心规则写在 token 属性上。
        attrs.anchor = token.attrGet('anchor') || null;
        attrs.explicitAnchor = token.attrGet('explicit-anchor') || null;
      }      addBlock(type, token, attrs);
    } else if (token.nesting === -1) finish();
    else if (token.type === 'front_matter') {
      addBlock('front_matter', token, { raw: token.content, fields: frontMatterFields(token.content) });
      finish();
    } else if (token.type === 'math_block') {
      addBlock('math_block', token, { latex: token.content });
      finish();
    } else if (token.type === 'toc_block') {
      addBlock('toc_block', token, { title: '目录' });
      finish();
    } else if (token.type === 'footnote_defs') {
      const items = JSON.parse(token.content || '[]') as BlockItem[];
      addBlock('footnote_defs', token, { items });
      finish();
    } else if (token.type === 'inline') {
      const frame = stack.at(-1)!;
      const cell = frame.attrs.cell as Range | undefined;
      // token.content 已去除列表/引用前缀；逐行定位到原始行内内容。
      const inlineOffsets: number[] = [];
      let taskPrefix = 0;
      if (cell) {
        // 表格单元格的 inline token 无 map，直接按已扫描到的单元格源码范围逐字映射。
        const width = cell.to - cell.from;
        for (let c = 0; c < token.content.length; c++) inlineOffsets.push(normalized.offsets[width === token.content.length ? cell.from + c : cell.from]);
        inlineOffsets.push(normalized.offsets[cell.to]);
      } else {
        const firstLine = token.map![0];
        const lastLine = token.map![1];
        const contentLines = token.content.split('\n');
        let line = firstLine, unmapped = false;
        for (const part of contentLines) {
          const rawLine = normalized.text.slice(lines[line], lines[line + 1]).replace(/\n$/, '');
          const column = rawLine.indexOf(part);
          if (column < 0) { unmapped = true; break; }
          for (let c = 0; c < part.length; c++) inlineOffsets.push(normalized.offsets[lines[line] + column + c]);
          if (line + 1 < lastLine) inlineOffsets.push(normalized.offsets[lines[line + 1] - 1]);
          line++;
        }
        if (unmapped) {
          frame.type = 'opaque'; frame.attrs = { ...frame.attrs, kind: 'source', raw: source.slice(frame.range.from, frame.range.to) }; frame.nodes = [];
          continue;
        }
        inlineOffsets.push(normalized.offsets[lines[lastLine - 1] + normalized.text.slice(lines[lastLine - 1], lines[lastLine]).replace(/\n$/, '').length]);
        taskPrefix = frame.type === 'paragraph' && stack.at(-2)?.type === 'list_item' && stack.at(-2)?.attrs.checked !== null
          ? /^\[[ xX]\](?:[ \t]+|$)/.exec(token.content)?.[0].length ?? 0 : 0;
      }
      let marks: readonly Mark[] = [], local = 0;
      const markStack: Mark[] = [];
      const children = token.children || [];
      // 成对的行内 HTML 包住实际可编辑文字，两个标签不再显示成源码框。
      const htmlStack: { token: Token; tag: string }[] = [];
      const pairs = new Map<Token, { open: string; close: string; opening: boolean }>();
      for (const html of children) {
        if (html.type !== 'html_inline') continue;
        const open = /^<([a-z][a-z0-9]*)(?:\s[^>]*)?>$/i.exec(html.content);
        const close = /^<\/(\w+)\s*>$/.exec(html.content);
        if (open && htmlInlineTags.has(open[1].toLowerCase())) htmlStack.push({ token: html, tag: open[1].toLowerCase() });
        else if (close && htmlStack.at(-1)?.tag === close[1].toLowerCase()) {
          const first = htmlStack.pop()!.token;
          const attrs = { open: first.content, close: html.content };
          pairs.set(first, { ...attrs, opening: true }); pairs.set(html, { ...attrs, opening: false });
        }
      }
      for (let childIndex = 0; childIndex < children.length; childIndex++) {
        const child = children[childIndex] as Traced;
        const component = child.type === 'html_inline' && /^<(svg|math|picture|audio|video|select|textarea|button|meter|progress|datalist)(?:\s[^>]*)?>$/i.exec(child.content);
        if (component) {
          let depth = 1, end = childIndex + 1;
          for (; end < children.length; end++) {
            const item = children[end]; if (item.type !== 'html_inline') continue;
            if (new RegExp(`^<${component[1]}(?:\\s[^>]*)?>$`, 'i').test(item.content)) depth++;
            if (new RegExp(`^</${component[1]}\\s*>$`, 'i').test(item.content) && --depth === 0) break;
          }
          if (depth === 0) {
            const range = { from: child.meta!.range.from, to: (children[end] as Traced).meta!.range.to };
            frame.nodes.push(schema.nodes.raw_inline.create({ raw: token.content.slice(range.from, range.to) }, null, marks));
            atoms.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, block: frame.attrs.id as string, kind: 'html' });
            childIndex = end; continue;
          }
        }
        const html = pairs.get(child);
        if (html) {
          const mark = schema.marks.html.create({ open: html.open, close: html.close });
          if (html.opening) markStack.push(mark);
          else { let index = markStack.length - 1; while (index >= 0 && !markStack[index].eq(mark)) index--; if (index >= 0) markStack.splice(index, 1); }
          marks = markStack.reduce((active, mark) => mark.addToSet(active), [] as readonly Mark[]);
          continue;
        }
        const name = child.type.replace(/_(open|close)$/, '');
        const kind = name === 's' ? 'strike' : name;
        if (child.nesting === 1 && schema.marks[kind]) {
          const attrs = kind === 'link' ? { href: child.attrGet('href'), title: child.attrGet('title') || '' }
            : kind === 'color' ? { color: child.attrGet('color') }
            : kind === 'bg' ? { bg: child.attrGet('bg') }
            : kind === 'size' ? { size: child.attrGet('size') }
            : {};
          markStack.push(schema.marks[kind].create(attrs));
          marks = markStack.reduce((active, mark) => mark.addToSet(active), [] as readonly Mark[]);
        } else if (child.nesting === -1 && schema.marks[kind]) {
          let index = markStack.length - 1;
          while (index >= 0 && markStack[index].type !== schema.marks[kind]) index--;
          if (index >= 0) markStack.splice(index, 1);
          marks = markStack.reduce((active, mark) => mark.addToSet(active), [] as readonly Mark[]);
        }
        else if (child.type === 'text' || child.type === 'code_inline' || child.type === 'softbreak') {
          const content = child.type === 'softbreak' ? '\n' : child.content;
          const active = child.type === 'code_inline' ? schema.marks.code.create().addToSet(marks) : marks;
          let output = '';
          for (let c = 0; c < content.length; c++) {
            const range = child.meta?.units[c] || child.meta!.range;
            if (range.from < taskPrefix) continue;
            chars.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, text: content[c], marks: active, block: frame.attrs.id as string });
            output += content[c];
          }
          if (output) frame.nodes.push(schema.text(output, active));
        } else if (child.type === 'hardbreak') { frame.nodes.push(schema.nodes.hard_break.create(null, null, marks)); local++; }
        else if (child.type === 'image') {
          const width = child.attrGet('width');
          frame.nodes.push(schema.nodes.image.create({ src: child.attrGet('src'), alt: child.content, title: child.attrGet('title') || '', width: width ? Number(width) : null, dimensions: child.attrGet('dimensions') || null }, null, marks));
          const range = child.meta!.range;
          atoms.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, block: frame.attrs.id as string, kind: 'image' });
        } else if (child.type === 'math_inline') {
          frame.nodes.push(schema.nodes.math_inline.create({ latex: child.content }, null, marks));
          const range = child.meta!.range;
          atoms.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, block: frame.attrs.id as string, kind: 'math' });
        } else if (child.type === 'footnote_ref') {
          const index = footnoteOrder.indexOf(child.content) + 1;
          frame.nodes.push(schema.nodes.footnote_ref.create({ label: child.content, index }, null, marks));
          const range = child.meta!.range;
          atoms.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, block: frame.attrs.id as string, kind: 'footnote' });
        } else if (child.type === 'html_inline') {
          if (/^<br\s*\/?>$/i.test(child.content)) { frame.nodes.push(schema.nodes.hard_break.create(null, null, marks)); local++; continue; }
          frame.nodes.push(schema.nodes.raw_inline.create({ raw: child.content }, null, marks));
          const range = child.meta!.range;
          atoms.push({ from: inlineOffsets[range.from], to: inlineOffsets[range.to], pos: local++, block: frame.attrs.id as string, kind: 'html' });
        }
      }
    } else if (['fence', 'code_block', 'html_block', 'hr'].includes(token.type)) {
      const range = token.map!;
      addBlock('opaque', token, { kind: token.type === 'fence' ? token.info.trim() === 'mermaid' ? 'mermaid' : 'code' : token.type === 'code_block' ? 'code' : token.type, raw: source.slice(normalized.offsets[lines[range[0]]], normalized.offsets[lines[range[1]]]), content: token.content, info: token.info }); finish();
    }
  }
  if (!stack[0].nodes.length) {
    const node = schema.nodes.paragraph.create({ id: 'empty' }); stack[0].nodes.push(node);
    blocks.push({ id: 'empty', type: 'paragraph', from: source.length, to: source.length, pos: 0, node, parent: null });
  } else if (/\n[ \t]*\n$/.test(normalized.text)) {
    // 末尾空段是可继续输入的编辑位置；导出仍由原始 Markdown 生成。
    const count = Math.floor((/\n(?:[ \t]*\n)*$/.exec(normalized.text)![0].match(/\n/g) ?? []).length / 2);
    for (let i = 0; i < count; i++) {
      const id = `b${sequence++}`, node = schema.nodes.paragraph.create({ id }); stack[0].nodes.push(node);
      blocks.push({ id, type: 'paragraph', from: source.length, to: source.length, pos: 0, node, parent: null });
    }
  }
  // 连续四个换行表示编辑中的一个空段；普通 Markdown 的双换行仍只是块分隔。
  const roots = stack[0].nodes.slice(); stack[0].nodes = [];
  const rootBlocks = new Map(blocks.filter(b => b.parent === null).map(b => [b.id, b]));
  let previousEnd = normalized.text.startsWith('\n') ? 0 : -1;
  for (const node of roots) {
    const block = rootBlocks.get(node.attrs.id)!;
    const gap = source.slice(Math.max(0, previousEnd), block.from);
    const breaks = Array.from(gap.matchAll(/\r\n|\r|\n/g));
    const count = block.from < source.length && /^\s*$/.test(gap) ? Math.floor((breaks.length + (previousEnd > 0 ? 1 : 0) - 2) / 2) : 0;
    for (let i = 0; i < count; i++) {
      const id = `b${sequence++}`, empty = schema.nodes.paragraph.create({ id });
      // 空段的输入位置落在完整换行之后，不能把 CRLF 切半，也不能忽略文首 BOM。
      const boundary = breaks[(previousEnd > 0 ? 1 : 2) + i * 2 - 1];
      const at = Math.max(0, previousEnd) + boundary.index! + boundary[0].length;
      stack[0].nodes.push(empty); blocks.push({ id, type: 'paragraph', from: at, to: at, pos: 0, node: empty, parent: null });
    }
    stack[0].nodes.push(node); previousEnd = block.to;
  }
  const doc = schema.nodes.doc.create(null, stack[0].nodes);
  const headings = blocks.filter(block => block.type === 'heading').sort((a, b) => a.from - b.from);
  const anchors = new Map<string, string>();
  const usedAnchors = new Set<string>();
  headings.forEach(block => {
    // 锚点由 heading_anchor 核心规则唯一确定，导出与预览不会出现两套 slug。
    const anchor = (block.node.attrs.anchor as string | null) ?? headingAnchor(block.node.textContent || '', null, headings.indexOf(block) + 1);
    if (usedAnchors.has(anchor)) { const base = anchor; let suffix = 1; let unique = anchor; while (usedAnchors.has(unique)) unique = `${base}-${++suffix}`; usedAnchors.add(unique); anchors.set(block.id, unique); return; }
    usedAnchors.add(anchor);
    anchors.set(block.id, anchor);
  });
  const rebuildAnchors = (node: PMNode): PMNode => node.isText ? node
    : node.type.create(node.type.name === 'heading' ? { ...node.attrs, anchor: anchors.get(node.attrs.id as string) ?? node.attrs.anchor } : node.attrs,
      Array.from({ length: node.childCount }, (_, i) => rebuildAnchors(node.child(i))), node.marks);
  const anchored = headings.length ? rebuildAnchors(doc) : doc;
  const doc0 = anchored;
  const positions = new Map<string, number>();
  doc0.descendants((node, pos) => { if (node.attrs.id) positions.set(node.attrs.id, pos); });
  const nodes = new Map<string, PMNode>(); doc0.descendants(node => { if (node.attrs.id) nodes.set(node.attrs.id, node); });
  for (const block of blocks) { block.pos = positions.get(block.id)!; block.node = nodes.get(block.id) ?? block.node; }
  for (const char of chars) char.pos += positions.get(char.block)! + 1;
  for (const atom of atoms) atom.pos += positions.get(atom.block)! + 1;
  const model = { source, doc: doc0, chars, atoms, blocks, offsets: view.offsets, nextId: sequence };
  return previous && edit ? retainBlockIds(previous, model, edit) : model;
}

function retainBlockIds(before: Model, next: Model, edit: Range & { insert: string }): Model {
  const family = (b: Block) => b.node.isTextblock ? 'text' : b.type;
  const mapped = (offset: number) => offset <= edit.from ? offset : offset >= edit.to ? offset + edit.insert.length - (edit.to - edit.from) : edit.from;
  const originals = new Map<string, Block[]>();
  for (const block of before.blocks) {
    const key = `${family(block)}:${before.source.slice(block.from, block.to)}`;
    const group = originals.get(key) ?? []; group.push(block); originals.set(key, group);
  }
  const ids = new Map<string, string>(), used = new Set<string>();
  // 先匹配保留的原始片段，包括整块移动；再定位被编辑或分段的块。
  for (const block of next.blocks) {
    const candidates = originals.get(`${family(block)}:${next.source.slice(block.from, block.to)}`)?.filter(b => {
      if (used.has(b.id)) return false;
      if (b.to <= edit.from) return b.from === block.from && b.to === block.to;
      if (b.from >= edit.to) { const delta = edit.insert.length - (edit.to - edit.from); return b.from + delta === block.from && b.to + delta === block.to; }
      return true;
    });
    const match = candidates?.sort((a, b) => Math.abs(mapped(a.from) - block.from) - Math.abs(mapped(b.from) - block.from))[0];
    if (match) { ids.set(block.id, match.id); used.add(match.id); }
  }
  for (const block of [...next.blocks].sort((a, b) => a.pos - b.pos || b.node.nodeSize - a.node.nodeSize)) {
    if (ids.has(block.id)) continue;
    const match = before.blocks.find(b => !used.has(b.id) && family(b) === family(block) && mapped(b.from) === block.from);
    const id = match?.id ?? `b${next.nextId = Math.max(next.nextId, before.nextId) + 1}`;
    ids.set(block.id, id); if (match) used.add(match.id);
  }
  next.nextId = Math.max(next.nextId, before.nextId);
  const rebuild = (node: PMNode): PMNode => node.isText ? node : node.type.create(node.attrs.id ? { ...node.attrs, id: ids.get(node.attrs.id) } : node.attrs, Array.from({ length: node.childCount }, (_, i) => rebuild(node.child(i))), node.marks);
  next.doc = rebuild(next.doc);
  const nodes = new Map<string, PMNode>(); next.doc.descendants(node => { if (node.attrs.id) nodes.set(node.attrs.id, node); });
  for (const block of next.blocks) { block.id = ids.get(block.id)!; block.parent = block.parent ? ids.get(block.parent)! : null; block.node = nodes.get(block.id)!; }
  for (const char of next.chars) char.block = ids.get(char.block)!;
  for (const atom of next.atoms) atom.block = ids.get(atom.block)!;
  return next;
}

export function semantics(doc: PMNode): unknown {
  const value: Record<string, unknown> = { type: doc.type.name };
  const attrs = { ...doc.attrs }; delete attrs.id;
  // 自动锚点随正文和标题顺序重算，不是用户编辑事务中的语义；显式 ID 仍参与校验。
  if (doc.type.name === 'heading') delete attrs.anchor;
  if (doc.type.name === 'footnote_ref') delete attrs.index;
  if (doc.type.name === 'footnote_defs') attrs.items = (attrs.items as { label: string; text: string }[]).map(({ label, text }) => ({ label, text }));
  if (Object.keys(attrs).length) value.attrs = attrs;
  if (doc.isText) value.text = doc.marks.some(mark => mark.type.name === 'code') ? doc.text!.replace(/\n/g, ' ') : doc.text;
  if (doc.marks.length) value.marks = doc.marks.map(m => m.toJSON());
  if (doc.childCount) value.children = Array.from({ length: doc.childCount }, (_, i) => semantics(doc.child(i)));
  return value;
}
