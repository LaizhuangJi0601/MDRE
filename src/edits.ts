import { wrapCell } from './table-alignment';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import type { Atom, Model, Range, Block } from './model';
import { parse, semantics, schema, imageDimensions } from './model';
import { Transform } from 'prosemirror-transform';
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';

export type Patch = Range & { insert: string };
export function patch(source: string, edit: Patch): string { return source.slice(0, edit.from) + edit.insert + source.slice(edit.to); }
export function difference(before: string, after: string): Patch {
  let from = 0, oldEnd = before.length, newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  // 不在 UTF-16 代理对中间截断补丁。
  if (from > 0 && /[\uDC00-\uDFFF]/.test(before[from] || after[from])) from--;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (/[\uDC00-\uDFFF]/.test(before[oldEnd] || after[newEnd])) { oldEnd++; newEnd++; }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function sameMarks(a: readonly Mark[], b: readonly Mark[]) { return MarkSet(a) === MarkSet(b); }
function MarkSet(marks: readonly Mark[]) { return JSON.stringify(marks.map(m => m.toJSON())); }
export function escapeText(text: string): string { return text.replace(/[\\`*_[\]{}<>~=!|$^]/g, '\\$&').replace(/&/g, '&amp;'); }

export function validated(model: Model, edit: Patch, expected: PMNode): { source: string; model: Model; edit: Patch } {
  const source = patch(model.source, edit), next = parse(source, model, edit);
  if (!equal(semantics(next.doc), semantics(expected))) throw new Error('当前操作无法可靠映射到 Markdown，请使用源码栏或源码弹窗。原文未改变。', { cause: { source, actual: semantics(next.doc), expected: semantics(expected) } });
  return { source, model: next, edit };
}
// 结构操作先保留最小源码补丁；Markdown 会合并相邻容器时，统一编码容器边界再校验。
export function validatedStructure(model: Model, edit: Patch, expected: PMNode): ReturnType<typeof validated> {
  const source = patch(model.source, edit), next = parse(source, model, edit);
  return equal(semantics(next.doc), semantics(expected)) ? { source, model: next, edit } : renderedStructure(model, expected);
}

// 逐字修改优先使用字符映射；跨格式边界才序列化单个完整段落。
export function renderedEdit(model: Model, expected: PMNode): ReturnType<typeof validated> {
  const from = model.doc.content.findDiffStart(expected.content);
  const ends = model.doc.content.findDiffEnd(expected.content);
  if (from === null || !ends) return { source: model.source, model, edit: { from: 0, to: 0, insert: '' } };
  let oldEnd = ends.a, newEnd = ends.b;
  const overlap = from - Math.min(oldEnd, newEnd);
  if (overlap > 0) { oldEnd += overlap; newEnd += overlap; }
  const removed = model.chars.filter(c => c.pos >= from && c.pos < oldEnd);
  const inserted: { text: string; marks: readonly Mark[] }[] = [];
  const nodes: PMNode[] = [];
  let inlineOnly = true;
  expected.nodesBetween(from, newEnd, (node, pos) => {
    if (node.isText) {
      const startAt = Math.max(0, from - pos), endAt = Math.min(node.nodeSize, newEnd - pos);
      // 区间为空时 Node.cut 会立即构造零长度文本节点并抛
      // RangeError: Empty text nodes are not allowed —— 必须在调用前判断。
      // 对外部编辑器写成的文档，删除恰好落在文本节点边界时就会命中这里。
      if (endAt <= startAt) return;
      const cut = node.cut(startAt, endAt);
      nodes.push(cut); inserted.push({ text: cut.text!, marks: node.marks });
    } else if (node.isInline) { nodes.push(node); if (node.type.name !== 'image' && node.type.name !== 'raw_inline') inlineOnly = false; }
  });
  const left = model.chars.find(c => c.pos === from - 1), right = model.chars.find(c => c.pos === oldEnd);
  const marks = inserted[0]?.marks || removed[0]?.marks || right?.marks || left?.marks || [];
  const text = inserted.map(c => c.text).join('');
  // 纯行内原子插入（图片、内联 HTML）按字符边界插入，不整段重写，保留未修改区域的原始写法。
  const atomic = nodes.length > 0 && nodes.every(node => node.type.name === 'image' || node.type.name === 'raw_inline');
  if (atomic && !removed.length) {
    const at = right?.from ?? left?.to;
    if (at !== undefined) {
      const edit = { from: at, to: at, insert: serializeInline(schema.nodes.paragraph.create(null, nodes)) };
      const source = patch(model.source, edit), next = parse(source, model, edit);
      if (equal(semantics(next.doc), semantics(expected))) return { source, model: next, edit };
    }
  }
  // 逐字分支：removed 与 expected 的重合区间不一致时直接跳过，改走整块重写。
  if (inlineOnly && nodes.every(node => node.isText) && removed.length === oldEnd - from && removed.every(c => sameMarks(c.marks, marks)) && inserted.every(c => sameMarks(c.marks, marks))) {
    const at = removed[0]?.from ?? (right && sameMarks(right.marks, marks) ? right.from : left?.to);
    if (at !== undefined) {
      const edit = { from: at, to: removed.at(-1)?.to ?? at, insert: marks.some(m => m.type.name === 'code') ? text : escapeText(text) };
      const source = patch(model.source, edit), next = parse(source, model, edit);
      if (equal(semantics(next.doc), semantics(expected))) return { source, model: next, edit };
    }
  }
  const block = model.blocks.find(b => b.node.isTextblock && from >= b.pos + 1 && oldEnd <= b.pos + b.node.nodeSize - 1);
  if (block) {
    const nextBlock = expected.nodeAt(block.pos);
    if (nextBlock?.isTextblock) {
      // 只有旧格式全部保留时才能沿用外层标签；换色/清除不能把新标签嵌入旧标签。
      const preservesMarks = removed.every(char => char.marks.every(mark => inserted.every(part => mark.isInSet(part.marks))));
      if (removed.length && inserted.length && removed.length === oldEnd - from && preservesMarks) {
        // 只加格式时先保留现有外层标记，补丁限于被选文字。
        const shared = removed[0].marks.filter(mark => removed.every(c => mark.isInSet(c.marks)) && inserted.every(c => mark.isInSet(c.marks)));
        const edit = { from: removed[0].from, to: removed.at(-1)!.to, insert: serializeInline(nextBlock.cut(from - block.pos - 1, newEnd - block.pos - 1), shared) };
        const source = patch(model.source, edit), next = parse(source, model, edit);
        if (equal(semantics(next.doc), semantics(expected))) return { source, model: next, edit };
      }
      const raw = model.source.slice(block.from, block.to);
      // 段落中的数字不是列表前缀；仅沿实际容器保留缩进与标记。
      const inList = model.blocks.some(parent => parent.id === block.parent && parent.type === 'list_item');
      const prefix = /^(?:\uFEFF)?(?:[ \t]*>[ \t]?)*[ \t]*/.exec(raw)![0]
        + (inList ? /^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(raw.trimStart())?.[0] ?? '' : '')
        + (block.type === 'heading' ? /^(?:#{1,6})[ \t]+/.exec(raw.trimStart())?.[0] ?? '' : '');
      const ending = /(?:\r\n|\r|\n)$/.exec(raw)?.[0] || '';
      const id = nextBlock.type.name === 'heading' && nextBlock.attrs.explicitAnchor ? ` {#${nextBlock.attrs.explicitAnchor}}` : '';
      const edit = { from: block.from, to: block.to, insert: prefix + (nextBlock.type.name === 'table_cell' ? wrapCell(serializeInline(nextBlock), nextBlock.attrs.cellAlign) : serializeInline(nextBlock)) + id + ending };
      const source = patch(model.source, edit), next = parse(source, model, edit);
      if (equal(semantics(next.doc), semantics(expected))) return { source, model: next, edit };
    }
  }
  return renderedStructure(model, expected);
}

// 标准富文本事务按受影响的顶层容器回写；未修改的容器逐字保留。
export function renderedStructure(model: Model, expected: PMNode): ReturnType<typeof validated> {
  const before = Array.from({ length: model.doc.childCount }, (_, i) => model.doc.child(i));
  const after = Array.from({ length: expected.childCount }, (_, i) => expected.child(i));
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && equal(semantics(before[start]), semantics(after[start]))) start++;
  while (oldEnd > start && newEnd > start && equal(semantics(before[oldEnd - 1]), semantics(after[newEnd - 1]))) { oldEnd--; newEnd--; }
  const emptyParagraph = (node: PMNode | undefined) => node?.type.name === 'paragraph' && !node.content.size;
  // 块增删或段落被删空时，包含相邻块，独立编码空段所需的空行边界。
  if (oldEnd - start !== newEnd - start || before.slice(start, oldEnd).some(emptyParagraph) || after.slice(start, newEnd).some(emptyParagraph) || before[start]?.type !== after[start]?.type) {
    if (start > 0) start--;
    if (oldEnd < before.length && newEnd < after.length) { oldEnd++; newEnd++; }
    // 连续空段没有自身文本；扩展到最近的非空块，避免依赖被删代码块的分隔符。
    while (start > 0 && emptyParagraph(after[start])) start--;
    while (oldEnd < before.length && newEnd < after.length && emptyParagraph(after[newEnd - 1])) { oldEnd++; newEnd++; }
  }
  const roots = model.blocks.filter(b => b.parent === null).sort((a, b) => a.pos - b.pos);
  const from = roots[start]?.from ?? model.source.length, to = oldEnd > start ? roots[oldEnd - 1].to : from;
  const newline = model.source.includes('\r\n') ? '\r\n' : '\n';
  const makeEdit = (canonical: boolean) => {
  let previousType = '', marker = '-', orderedMarker = '.';
  const body = after.slice(start, newEnd).map(node => {
    if (node.type.name === 'bullet_list') marker = previousType === 'bullet_list' ? (marker === '-' ? '+' : '-') : '-';
    if (node.type.name === 'ordered_list') {
      const original = model.blocks.find(block => block.id === node.attrs.id);
      const originalMarker = original && /^\s*\d+([.)])\s/.exec(model.source.slice(original.from, original.to))?.[1];
      orderedMarker = previousType === 'ordered_list' ? (orderedMarker === '.' ? ')' : '.') : originalMarker || '.';
    }
    const result = serializeBlock(node, model, canonical, node.type.name === 'bullet_list' ? marker : '-', orderedMarker);
    // 原片段可能使用 +、* 或 1)；下一个独立列表必须与实际输出的标记区分。
    if (node.type.name === 'bullet_list') marker = /^\s*([-+*])\s/.exec(result)?.[1] || marker;
    if (node.type.name === 'ordered_list') orderedMarker = /^\s*\d+([.)])\s/.exec(result)?.[1] || orderedMarker;
    if (node.content.size) previousType = node.type.name;
    return result;
  }).join('\n\n');
  let insert = body.replace(/\n/g, newline);
  if (after[start]?.type.name === 'paragraph' && !after[start].content.size && newEnd > start + 1) insert = newline + newline + insert;
  if (from === 0 && model.source.startsWith('\uFEFF')) insert = '\uFEFF' + insert;
  if (to < model.source.length && insert && !insert.endsWith(newline)) insert += newline;
  else if (to === model.source.length && insert && !insert.endsWith(newline) && /(?:\r\n|\r|\n)$/.test(model.source)) insert += newline;
  return { from, to, insert };
  };
  const edit = makeEdit(false), source = patch(model.source, edit), next = parse(source, model, edit);
  if (equal(semantics(next.doc), semantics(expected))) return { source, model: next, edit };
  // 实体转义用于分隔符相邻的歧义场景；仍须证明重解析语义一致才能提交。
  const canonicalEdit = makeEdit(true), canonicalSource = patch(model.source, canonicalEdit);
  const canonicalNext = parse(canonicalSource, model, canonicalEdit);
  if (equal(semantics(canonicalNext.doc), semantics(expected))) return { source: canonicalSource, model: canonicalNext, edit: canonicalEdit };
  return validated(model, canonicalEdit, expected);
}
function serializeBlock(node: PMNode, model: Model, canonical = false, bulletMarker = '-', orderedMarker = '.'): string {
  const original = model.blocks.find(b => b.id === node.attrs.id && equal(semantics(b.node), semantics(node)));
  const originalRaw = original && model.source.slice(original.from, original.to);
  if (original?.parent === null && bulletMarker === '-' && (node.type.name !== 'ordered_list' || /^\s*\d+([.)])\s/.exec(originalRaw!)?.[1] === orderedMarker)) return originalRaw!.replace(/(?:\r\n|\r|\n)+$/, '').replace(/\r\n|\r/g, '\n');
  const children = () => Array.from({ length: node.childCount }, (_, i) => serializeBlock(node.child(i), model, canonical));
  switch (node.type.name) {
    case 'paragraph': return serializeInline(node, [], canonical);
    case 'heading': return '#'.repeat(node.attrs.level) + ' ' + serializeInline(node, [], canonical).replace(/  \n/g, '<br>') + (node.attrs.explicitAnchor ? ` {#${node.attrs.explicitAnchor}}` : '');
    case 'opaque': return String(node.attrs.raw).replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
    // S-2/S-3/S-4/S-5：新增块级结构各自回写为原始语法。
    case 'math_block': return `$$\n${String(node.attrs.latex ?? '')}\n$$`;
    case 'toc_block': return '[toc]';
    case 'front_matter': return String(node.attrs.raw ?? '').replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
    case 'footnote_defs': return ((node.attrs.items ?? []) as { label: string; text: string }[]).map(item => `[^${item.label}]: ${item.text}`).join('\n');
    case 'blockquote': { let body = children().join('\n\n'); if (node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size && node.childCount > 1) body = '\n\n' + body; return body.split('\n').map(line => line ? '> ' + line : '>').join('\n'); }
    case 'bullet_list': case 'ordered_list': {
      return Array.from({ length: node.childCount }, (_, i) => {
        const item = node.child(i), marker = node.type.name === 'ordered_list' ? `${Number(node.attrs.order) + i}${orderedMarker} ` : bulletMarker + ' ';
        const task = item.attrs.checked === null ? '' : item.attrs.checked ? '[x] ' : '[ ] ';
        const content = Array.from({ length: item.childCount }, (_, j) => {
          const child = item.child(j);
          // 子块的原文包含父列表缩进，序列化时由当前容器统一重新加前缀。
          return child.type.name === 'paragraph' ? (!child.content.size && item.childCount > 1 ? '<p></p>' : serializeInline(child, [], canonical)) : serializeBlock(child, { ...model, blocks: [] }, canonical);
        }).join('\n\n').split('\n');
        return marker + task + content[0] + content.slice(1).map(line => '\n' + (line ? ' '.repeat(marker.length) + line : '')).join('');
      }).join('\n');
    }
    case 'table': {
      const rows = Array.from({ length: node.childCount }, (_, i) => node.child(i));
      const row = (r: PMNode) => '| ' + Array.from({ length: r.childCount }, (_, i) => wrapCell(serializeInline(r.child(i), [], canonical).replace(/(?<!\\)\|/g, '\\|').replace(/  \n/g, '<br>'), r.child(i).attrs.cellAlign)).join(' | ') + ' |';
      const aligns = Array.from({ length: rows[0].childCount }, (_, i) => ({ left: ':---', right: '---:', center: ':---:' }[String(rows[0].child(i).attrs.align)] ?? '---'));
      return [row(rows[0]), '| ' + aligns.join(' | ') + ' |', ...rows.slice(1).map(row)].join('\n');
    }
    default: throw new Error(`未支持的容器：${node.type.name}`);
  }
}

function serializeInline(node: PMNode, skip: readonly Mark[] = [], canonical = false): string {
  const order: Record<string, number> = { html: -1, size: 0, link: 1, color: 2, bg: 3, highlight: 4, em: 5, strong: 6, strike: 7, underline: 8, sup: 9, sub: 10, code: 11 };
  const children: PMNode[] = [];
  node.forEach(child => {
    const marked = child.mark(child.marks.filter(mark => !mark.isInSet(skip)).sort((a, b) => order[a.type.name] - order[b.type.name]));
    // Node.cut 在 from === to 时会产出零长度文本节点，ProseMirror 的 TextNode 构造会抛
    // RangeError("Empty text nodes are not allowed")。这里过滤掉，避免整次编辑被拦下。
    if (marked.isText && !marked.text) return;
    children.push(marked);
  });
  const codeFence = (child: PMNode, opening: boolean) => {
    const text = child.text ?? '', longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length));
    const pad = !/^ *$/.test(text) && (longest > 0 || /^[ \n]|[ \n]$/.test(text));
    return opening ? '`'.repeat(longest + 1) + (pad ? ' ' : '') : (pad ? ' ' : '') + '`'.repeat(longest + 1);
  };
  const serializer = new MarkdownSerializer({
    paragraph: (state, parent) => state.renderInline(parent),
    text: (state, child) => {
      let text = child.text!;
      if (canonical) {
        // 实体只用于发生冲突的容器边界，消除 CommonMark 的分隔符相邻歧义。
        const chars = [...text];
        text = chars.map((char, index) => index === 0 || index === chars.length - 1 || char === '&' ? `&#${char.codePointAt(0)};` : state.esc(char)).join('');
        state.write(text);
      } else state.text(text.replace(/&/g, '&amp;'));
    },
    image: (state, child) => {
      if (/^file:/i.test(String(child.attrs.src))) {
        const title = child.attrs.title ? ` "${String(child.attrs.title).replace(/(["\\])/g, '\\$1')}"` : '';
        // 标准尖括号目的地址保留路径内的括号，富文本和源码插入使用同一种写法。
        state.write(`![${state.esc(String(child.attrs.alt || ''))}](<${String(child.attrs.src).replace(/</g, '%3C').replace(/>/g, '%3E')}>${title})`);
      } else defaultMarkdownSerializer.nodes.image(state, child, node, 0);
      if (child.attrs.dimensions) state.write(String(child.attrs.dimensions)); else if (child.attrs.width) state.write(`{w:${child.attrs.width}}`);
    },
    raw_inline: (state, child) => state.write(String(child.attrs.raw)),
    math_inline: (state, child) => state.write(`$${child.attrs.latex}$`),
    footnote_ref: (state, child) => state.write(`[^${child.attrs.label}]`),
    hard_break: state => state.write('  \n'),
  }, {
    ...defaultMarkdownSerializer.marks,
    code: { open: (_state, _mark, parent, index) => codeFence(parent.child(index), true), close: (_state, _mark, parent, index) => codeFence(parent.child(index - 1), false), escape: false },
    strong: { ...defaultMarkdownSerializer.marks.strong, expelEnclosingWhitespace: false },
    em: { ...defaultMarkdownSerializer.marks.em, open: canonical ? '_' : '*', close: canonical ? '_' : '*', expelEnclosingWhitespace: false },
    strike: { open: '~~', close: '~~', mixable: true },
    underline: { open: '<u>', close: '</u>', mixable: true },
    highlight: { open: '==', close: '==', mixable: true },
    color: { open: (_state, mark) => `{color:${mark.attrs.color}}`, close: '{/color}', mixable: true },
    // S-37/S-38：背景色与字号沿用同一套成对标签写法。
    bg: { open: (_state, mark) => `{bg:${mark.attrs.bg}}`, close: '{/bg}', mixable: true },
    size: { open: (_state, mark) => `{size:${mark.attrs.size}}`, close: '{/size}', mixable: true },
    sup: { open: '^', close: '^', mixable: true },
    sub: { open: '~', close: '~', mixable: true },
    html: { open: (_state, mark) => String(mark.attrs.open), close: (_state, mark) => String(mark.attrs.close), mixable: false, expelEnclosingWhitespace: false },
  // ProseMirror 已转义 ~；额外再转义会留下多余反斜杠，导致分段回写校验失败。
  }, { escapeExtraCharacters: /[={}<>!|$^]/g });
  // MarkdownSerializer 的行内入口没有块首上下文；数字段首单独转义句点。
  return serializer.serialize(schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, children)))
    .replace(/^(\d{1,9})([.)])(?=\s|$)/gm, '$1\\$2');
}

export function splitParagraph(model: Model, pos: number): Patch {
  const block = model.blocks.find(b => b.node.isTextblock && b.parent === null && pos >= b.pos + 1 && pos <= b.pos + b.node.nodeSize - 1);
  if (!block) throw new Error('分段支持顶层段落与标题；复杂容器请使用源码栏。');
  if (pos === block.pos + 1) throw new Error('段首分段请使用源码栏。');
  const char = model.chars.find(c => c.pos === pos);
  const left = model.chars.find(c => c.pos === pos - 1);
  const at = char?.from ?? left?.to ?? block.from;
  const newline = model.source.includes('\r\n') ? '\r\n' : '\n';
  const expected = new Transform(model.doc).split(pos, 1, [{ type: schema.nodes.paragraph }]).doc;
  if (block.type === 'paragraph' && !char?.marks.length && !left?.marks.length) {
    const edit = { from: at, to: at, insert: newline + newline };
    validated(model, edit, expected); return edit;
  }
  const offset = pos - block.pos - 1, first = block.node.cut(0, offset), second = block.node.cut(offset);
  const original = model.source.slice(block.from, block.to), ending = /(?:\r\n|\r|\n)$/.exec(original)?.[0] ?? '';
  const prefix = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const edit = { from: block.from, to: block.to, insert: prefix + (block.type === 'heading' ? '#'.repeat(block.node.attrs.level) + ' ' : '') + serializeInline(first) + newline + newline + serializeInline(second) + ending };
  validated(model, edit, expected); return edit;
}
export function joinParagraph(model: Model, pos: number): Patch {
  const tops = model.blocks.filter(b => b.parent === null).sort((a, b) => a.pos - b.pos);
  const index = tops.findIndex(b => b.type === 'paragraph' && pos >= b.pos && pos <= b.pos + b.node.nodeSize);
  const left = tops[index - 1], right = tops[index];
  if (!left || left.type !== 'paragraph' || !right) throw new Error('请选择与上一普通段落相邻的段落。');
  const a = model.chars.filter(c => c.block === left.id).at(-1), b = model.chars.find(c => c.block === right.id);
  if (!a || !b || a.marks.length || b.marks.length) {
    const first = model.source.slice(left.from, left.to), ending = /(?:\r\n|\r|\n)$/.exec(model.source.slice(right.from, right.to))?.[0] ?? '';
    const edit = { from: left.from, to: right.to, insert: (first.startsWith('\uFEFF') ? '\uFEFF' : '') + serializeInline(left.node.copy(left.node.content.append(right.node.content))) + ending };
    validated(model, edit, new Transform(model.doc).join(right.pos).doc); return edit;
  }
  const edit = { from: a.to, to: b.from, insert: '' };
  validated(model, edit, new Transform(model.doc).join(right.pos).doc);
  return edit;
}
export function setHeading(model: Model, pos: number, level: number): Patch {
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('标题级别需为 1–6。');
  const block = model.blocks.find(b => b.node.isTextblock && pos >= b.pos + 1 && pos <= b.pos + b.node.nodeSize - 1);
  if (!block) throw new Error('请在可编辑段落或标题内设置级别。');
  const raw = model.source.slice(block.from, block.to);
  const prefix = /^(?:\uFEFF)?(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(raw)![0];
  const old = /^(#{1,6})[ \t]+/.exec(raw.slice(prefix.length));
  let edit: Patch = { from: block.from + prefix.length, to: block.from + prefix.length + (old?.[0].length ?? 0), insert: '#'.repeat(level) + ' ' };
  const ending0 = /(?:\r\n|\r|\n)$/.exec(raw)?.[0] ?? '';
  if (block.type === 'heading' && !old) {
    const content = raw.replace(/(?:\r\n|\r|\n)[ \t]*(?:>[ \t]*)*[=-]+[ \t]*(?:\r\n|\r|\n)?$/, '');
    edit = { from: block.from, to: block.to, insert: prefix + '#'.repeat(level) + ' ' + content.slice(prefix.length) + ending0 };
  }
  // S-1：期望模型从补丁后的源码重新解析得到，锚点因此按新文本重算，无需手工推导。
  const parsed = parse(patch(model.source, edit));
  const at = parsed.blocks.find(item => item.type === 'heading' && item.from <= edit.from + edit.insert.length && item.to >= edit.from);
  if (!at) throw new Error('未能定位被修改的标题，请使用源码栏编辑。');
  const expected = new Transform(parsed.doc).setNodeMarkup(at.pos, schema.nodes.heading, { ...at.node.attrs, level }).doc;
  validated(model, edit, expected);
  return edit;
}
// D-6/D-7：图片宽度写回扩展语法 {w:N}，不改动图片其余源码。
export function setImageWidth(model: Model, atom: Atom, width: number | null): Patch {
  const node = model.doc.nodeAt(atom.pos);
  if (!node || node.type.name !== 'image') throw new Error('未找到图片节点。');
  const suffix = imageDimensions(model.source.slice(atom.to));
  const edit: Patch = { from: atom.to, to: suffix ? atom.to + suffix.raw.length : atom.to, insert: width ? `{w:${Math.round(width)}}` : '' };
  validated(model, edit, new Transform(model.doc).setNodeMarkup(atom.pos, undefined, { ...node.attrs, width: width ? Math.round(width) : null, dimensions: null }).doc);
  return edit;
}
export function setInlineHtml(model: Model, atom: Atom, text: string): Patch {
  const node = model.doc.nodeAt(atom.pos);
  if (!node || node.type.name !== 'raw_inline') throw new Error('未找到内联 HTML 片段。');
  const edit: Patch = { from: atom.from, to: atom.to, insert: text };
  validated(model, edit, new Transform(model.doc).replaceWith(atom.pos, atom.pos + node.nodeSize, schema.nodes.raw_inline.create({ raw: text })).doc);
  return edit;
}
// S-2：用新源码替换一个行内原子（公式），只覆盖它自己的区间。
export function replaceAtomRange(model: Model, atom: Atom, text: string): Patch {
  const edit: Patch = { from: atom.from, to: atom.to, insert: text };
  validated(model, edit, parse(patch(model.source, edit)).doc);
  return edit;
}
export function toggleTask(model: Model, id: string): Patch {
  const item = model.blocks.find(b => b.id === id && b.type === 'list_item')!;
  const raw = model.source.slice(item.from, item.to);
  const task = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/.exec(raw);
  if (!task) throw new Error('当前列表项不是任务项。');
  const from = item.from + task[1].length;
  const edit = { from, to: from + 1, insert: task[2] === ' ' ? 'x' : ' ' };
  validated(model, edit, new Transform(model.doc).setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: !item.node.attrs.checked }).doc);
  return edit;
}
export function swapSibling(model: Model, id: string, direction: -1 | 1): Patch {
  const block = model.blocks.find(b => b.id === id)!;
  const siblings = model.blocks.filter(b => b.parent === block.parent && b.type === 'list_item').sort((a, b) => a.from - b.from);
  const other = siblings[siblings.indexOf(block) + direction];
  if (!other) throw new Error('没有相邻的同级列表项。');
  const [a, b]: Block[] = [block, other].sort((x, y) => x.from - y.from);
  const edit = { from: a.from, to: b.to, insert: model.source.slice(b.from, b.to) + model.source.slice(a.to, b.from) + model.source.slice(a.from, a.to) };
  validated(model, edit, new Transform(model.doc).replaceWith(a.pos, b.pos + b.node.nodeSize, [b.node, a.node]).doc);
  return edit;
}
