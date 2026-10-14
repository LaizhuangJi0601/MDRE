import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { lift, splitBlock, wrapIn } from 'prosemirror-commands';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import { normalize, parse, semantics, schema, type Block, type Model } from './model';
import { setHeading, validated, validatedStructure, renderedStructure, difference, patch, type Patch } from './edits';
import { renderToSource } from './mapping';

export type BlockKind = 'paragraph' | 'heading' | 'quote' | 'bullet' | 'ordered' | 'task' | 'code' | 'hr';
type ItemPrefix = { indent: string; marker: string; space: string; checked: boolean | null };

export function lineEnding(model: Model, at: number): string {
  const index = model.source.indexOf('\n', at);
  return index > 0 && model.source[index - 1] === '\r' ? '\r\n' : '\n';
}
function endingOf(raw: string): string { return /(?:\r\n|\r|\n)$/.exec(raw)?.[0] ?? ''; }
function textblockAt(model: Model, pos: number): Block | undefined {
  return model.blocks.filter(b => b.node.isTextblock && pos >= b.pos + 1 && pos <= b.pos + b.node.nodeSize - 1).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
}
function containerAt(model: Model, pos: number, type: string): Block | undefined {
  return model.blocks.filter(b => b.type === type && pos >= b.pos && pos < b.pos + b.node.nodeSize).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
}
function siblingsOf(model: Model, block: Block): Block[] {
  return model.blocks.filter(b => b.parent === block.parent).sort((a, b) => a.from - b.from);
}
export function itemPrefix(raw: string): ItemPrefix | null {
  const match = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/.exec(raw);
  if (!match) return null;
  return { indent: match[1], marker: match[2], space: match[3], checked: match[4] ? !/\[ \]/.test(match[4]) : null };
}
function stateAt(doc: PMNode, pos: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.near(doc.resolve(Math.max(1, Math.min(pos, doc.content.size - 1))), 1) });
}
function expectedFrom(doc: PMNode, pos: number, command: Command): PMNode {
  const holder: { doc?: PMNode } = {};
  command(stateAt(doc, pos), transaction => { holder.doc = transaction.doc; });
  if (!holder.doc) throw new Error('当前结构不支持该操作，请在源码栏调整。');
  return holder.doc;
}
// 按行重建块源码：只改变行首缩进或前缀，块内其余原文逐字保留。
function rewriteLines(model: Model, block: Block, change: (line: string) => string): Patch {
  const raw = model.source.slice(block.from, block.to);
  const ending = endingOf(raw);
  const body = ending ? raw.slice(0, -ending.length) : raw;
  const separator = /(\r\n|\r|\n)/.exec(body)?.[0] ?? lineEnding(model, block.from);
  return { from: block.from, to: block.to, insert: body.split(/\r\n|\r|\n/).map(change).join(separator) + ending };
}
function indented(model: Model, block: Block, delta: number): Patch {
  return rewriteLines(model, block, line => {
    if (!line.trim()) return line;
    if (delta > 0) return ' '.repeat(delta) + line;
    return line.slice(Math.min(-delta, /^[ \t]*/.exec(line)![0].length));
  });
}

export function convertBlock(model: Model, id: string, kind: BlockKind, options: { level?: number; info?: string; followingParagraph?: boolean } = {}): Patch {
  const block = model.blocks.find(b => b.id === id);
  if (!block) throw new Error('未找到目标块。');
  if (kind === 'hr') {
    const edit = insertRule(model, block);
    const position = block.node.isTextblock && !block.node.content.size ? block.pos : block.pos + block.node.nodeSize;
    return options.followingParagraph ? withFollowingParagraph(model, edit, position) : edit;
  }
  if (!block.node.isTextblock || block.type === 'table_cell') throw new Error('“转为”只作用于段落与标题；其他结构请在源码栏调整。');
  if (block.parent !== null) throw new Error('容器内部的“转为”请在源码栏调整。');
  const raw = model.source.slice(block.from, block.to);
  const ending = endingOf(raw);
  const body = ending ? raw.slice(0, -ending.length) : raw;
  const finish = (edit: Patch, expected: PMNode) => {
    const result = validatedStructure(model, edit, expected).edit;
    return options.followingParagraph ? withFollowingParagraph(model, result, block.pos) : result;
  };
  if (kind === 'paragraph') {
    if (block.type === 'paragraph') return { from: block.from, to: block.from, insert: '' };
    const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(raw)![0];
    const atx = /^(#{1,6})[ \t]+/.exec(raw.slice(prefix.length));
    const edit: Patch = atx
      ? { from: block.from + prefix.length, to: block.from + prefix.length + atx[0].length, insert: '' }
      : { from: block.from, to: block.to, insert: body.replace(/(?:\r\n|\r|\n)[ \t]*[=-]+[ \t]*$/, '') + ending };
    validated(model, edit, new Transform(model.doc).setNodeMarkup(block.pos, schema.nodes.paragraph).doc);
    return edit;
  }
  if (kind === 'heading') return setHeading(model, block.pos + 1, options.level ?? 1);
  if (kind === 'quote') {
    const edit: Patch = { from: block.from, to: block.to, insert: body.split(/\r\n|\r|\n/).map(line => `> ${line}`).join(ending || lineEnding(model, block.from)) + ending };
    return finish(edit, expectedFrom(model.doc, block.pos + 1, wrapIn(schema.nodes.blockquote)));
  }
  if (kind === 'code') {
    const info = options.info ?? '';
    if (/[\r\n`]/.test(info)) throw new Error('代码语言不能包含换行或反引号。');
    const newline = ending || lineEnding(model, block.from);
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map(run => run.length + 1)));
    const content = body.split(/\r\n|\r|\n/).join('\n') + '\n';
    const following = model.blocks.filter(item => item.parent === null && item.pos > block.pos).sort((a, b) => a.pos - b.pos)[0];
    const append = options.followingParagraph && !(following?.type === 'paragraph' && !following.node.content.size);
    const raw = fence + info + newline + body + newline + fence + (append ? newline : ending);
    // 沿用现有空段的换行表示；与代码块在同一个补丁内提交，单次撤销即可还原。
    const gapLines = (model.source.slice(block.to, following?.from ?? model.source.length).match(/\n/g) ?? []).length;
    const extra = append ? newline.repeat(Math.max(0, (following ? 4 : 2) - 1 - gapLines)) : '';
    const insert = raw + extra;
    const node = schema.nodes.opaque.create({ id: '', kind: 'code', raw, content, info });
    const edit: Patch = { from: block.from, to: block.to, insert };
    const replacement = append ? [node, schema.nodes.paragraph.create({ id: '' })] : [node];
    validated(model, edit, new Transform(model.doc).replaceWith(block.pos, block.pos + block.node.nodeSize, replacement).doc);
    return edit;
  }
  const insert = kind === 'ordered' ? '1. ' : kind === 'task' ? '- [ ] ' : '- ';
  const paragraph = block.type === 'heading' && kind === 'task' ? schema.nodes.paragraph.create({ id: block.id }, block.node.content) : block.node;
  const expected = kind === 'task'
    ? new Transform(model.doc).replaceWith(block.pos, block.pos + block.node.nodeSize, schema.nodes.bullet_list.create({ id: '' }, schema.nodes.list_item.create({ id: '', checked: false }, [paragraph]))).doc
    : expectedFrom(model.doc, block.pos + 1, wrapInList(kind === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list));
  const edit: Patch = block.type === 'heading' && kind === 'task'
    ? renderedStructure(model, expected).edit
    : { from: block.from, to: block.from, insert };
  return finish(edit, expected);
}

// 与代码块一致：插入后的空段是独立根节点，与块插入合并为一次源码提交。
export function withFollowingParagraph(model: Model, edit: Patch, position: number): Patch {
  const next = parse(patch(model.source, edit), model, edit);
  const block = next.blocks.find(item => item.parent === null && item.pos === position);
  if (!block) throw new Error('未找到插入后的顶层块。');
  const following = next.blocks.filter(item => item.parent === null && item.pos > position).sort((a,b) => a.pos-b.pos)[0];
  if (following?.type === 'paragraph' && !following.node.content.size) return edit;
  const newline = next.source.includes('\r\n') ? '\r\n' : '\n';
  const ending = /(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*$/.exec(next.source.slice(block.from, block.to))?.[0] ?? '';
  const gap = next.source.slice(block.to, following?.from ?? next.source.length);
  const count = ((ending + gap).match(/\r\n|\r|\n/g) ?? []).length;
  const insert = newline.repeat(Math.max(0, (following ? 4 : 2) - count));
  const expected = new Transform(next.doc).insert(block.pos + block.node.nodeSize, schema.nodes.paragraph.create({id:''})).doc;
  const result = validated(next, {from:block.to,to:block.to,insert}, expected);
  return validated(model, difference(model.source, result.source), expected).edit;
}

function insertRule(model: Model, block: Block): Patch {
  const newline = lineEnding(model, block.from);
  const rule = schema.nodes.opaque.create({ id: '', kind: 'hr', raw: '---' + newline, content: '', info: '' });
  if (block.node.isTextblock && block.type !== 'table_cell' && block.node.textContent === '') {
    const edit: Patch = { from: block.from, to: block.to, insert: '---' + newline };
    return validatedStructure(model, edit, new Transform(model.doc).replaceWith(block.pos, block.pos + block.node.nodeSize, rule).doc).edit;
  }
  const separator = /(?:\r\n|\r|\n)$/.test(model.source.slice(0, block.to)) ? newline : newline + newline;
  const edit: Patch = { from: block.to, to: block.to, insert: separator + '---' + newline };
  return validatedStructure(model, edit, new Transform(model.doc).insert(block.pos + block.node.nodeSize, rule).doc).edit;
}

export function moveBlock(model: Model, id: string, direction: -1 | 1): Patch {
  const block = model.blocks.find(b => b.id === id);
  if (!block) throw new Error('未找到目标块。');
  const siblings = siblingsOf(model, block);
  const other = siblings[siblings.indexOf(block) + direction];
  if (!other) throw new Error(direction < 0 ? '已经是第一个块。' : '已经是最后一个块。');
  const [a, b]: Block[] = [block, other].sort((x, y) => x.from - y.from);
  const edit: Patch = { from: a.from, to: b.to, insert: model.source.slice(b.from, b.to) + model.source.slice(a.to, b.from) + model.source.slice(a.from, a.to) };
  validated(model, edit, new Transform(model.doc).replaceWith(a.pos, b.pos + b.node.nodeSize, [b.node, a.node]).doc);
  return edit;
}

export function deleteBlock(model: Model, id: string): Patch {
  const block = model.blocks.find(b => b.id === id);
  if (!block) throw new Error('未找到目标块。');
  if (block.parent !== null) throw new Error('请只删除顶层块；容器内部请在源码栏调整。');
  let from = block.from, to = block.to;
  const following = /^(?:\r\n|\r|\n)/.exec(model.source.slice(to))?.[0];
  const preceding = /(?:\r\n|\r|\n)$/.exec(model.source.slice(0, from))?.[0];
  if (following) to += following.length;
  else if (preceding && /(?:\r\n|\r|\n)$/.test(model.source.slice(0, from - preceding.length))) from -= preceding.length;
  const edit: Patch = { from, to, insert: '' };
  const removed = new Transform(model.doc).delete(block.pos, block.pos + block.node.nodeSize).doc;
  const expected = removed.childCount ? removed : schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ id: 'empty' })]);
  const next = parse(model.source.slice(0, from) + model.source.slice(to), model, edit);
  if (JSON.stringify(semantics(next.doc)) === JSON.stringify(semantics(expected))) return edit;
  // 块删除后，独立空段可能成为文首空段；按相邻块重新编码空行，保留段落本身。
  return renderedStructure(model, expected).edit;
}

export function splitListItemAt(model: Model, pos: number): Patch {
  const item = containerAt(model, pos, 'list_item');
  if (!item) throw new Error('请在列表项文字内回车。');
  const list = model.blocks.find(b => b.id === item.parent);
  if (!list) throw new Error('未找到列表容器。');
  if (list.parent !== null) throw new Error('嵌套列表的分段请在源码栏操作。');
  const prefix = itemPrefix(model.source.slice(item.from, item.to));
  if (!prefix) throw new Error('未识别的列表标记，请在源码栏分段。');
  const newline = lineEnding(model, item.from);
  const block = textblockAt(model, pos);
  if (!block || block.parent !== item.id) throw new Error('请在列表项文字内回车。');
  const task = prefix.checked === null ? '' : '[ ] ';
  if (block.node.textContent === '') return exitListItem(model, item, list);
  const onlyParagraph = item.node.childCount === 1 && item.node.firstChild!.type.name === 'paragraph';
  if (onlyParagraph) {
    const at = renderToSource(model, pos), offset = pos - block.pos - 1, first = item.node.firstChild!, size = first.content.size;
    const edit: Patch = { from: at, to: at, insert: newline + prefix.indent + prefix.marker + prefix.space + task };
    const expected = new Transform(model.doc).replaceWith(item.pos, item.pos + item.node.nodeSize, [
      schema.nodes.list_item.create({ ...item.node.attrs, id: '' }, schema.nodes.paragraph.create({ id: '' }, first.content.cut(0, offset))),
      schema.nodes.list_item.create({ ...item.node.attrs, id: '', checked: prefix.checked === null ? null : false }, schema.nodes.paragraph.create({ id: '' }, first.content.cut(offset, size))),
    ]).doc;
    validated(model, edit, expected);
    return edit;
  }
  const children = model.blocks.filter(b => b.parent === item.id).sort((a, b) => a.from - b.from);
  const anchor = children[0].id === block.id || children.at(-1)!.id === block.id;
  if (!anchor || pos !== block.pos + block.node.nodeSize - 1) throw new Error('请在列表项最末一段的段末回车，其他情况请使用源码栏。');
  const at = item.to, tail = model.source.slice(at);
  const edit: Patch = { from: at, to: at, insert: prefix.indent + prefix.marker + prefix.space + task + (tail.startsWith('\n') || tail === '' ? '' : newline) };
  const empty = schema.nodes.list_item.create({ ...item.node.attrs, id: '', checked: prefix.checked === null ? null : false }, schema.nodes.paragraph.create({ id: '' }));
  validated(model, edit, new Transform(model.doc).replaceWith(item.pos, item.pos + item.node.nodeSize, [item.node, empty]).doc);
  return edit;
}

function exitListItem(model: Model, item: Block, list: Block): Patch {
  const raw = model.source.slice(item.from, item.to);
  if (/[\r\n]/.test(raw.slice(0, -endingOf(raw).length))) throw new Error('多项列表项退出请在源码栏操作。');
  const lineEnd = /^(?:\r\n|\r|\n)/.exec(model.source.slice(item.to))?.[0] ?? '';
  // CRLF 文件里空项范围可能停在 \r 后，尾部的 \n 要补齐为完整换行再删除或保留。
  const full = raw.endsWith('\r') && lineEnd === '\n' ? '\r\n' : lineEnd;
  const trailing = list.node.lastChild === item.node && list.parent === null;
  // 列表已到文末时留下一行空白，使解析得到可继续输入的段落；否则整行删除，避免多余空行。
  const edit: Patch = { from: item.from, to: item.to + lineEnd.length, insert: trailing ? full || lineEnding(model, item.from) : '' };
  const transform = new Transform(model.doc);
  const removed = list.node.childCount > 1
    ? transform.delete(item.pos, item.pos + item.node.nodeSize).doc
    : transform.delete(list.pos, list.pos + list.node.nodeSize).doc;
  const source = model.source.slice(0, edit.from) + edit.insert + model.source.slice(edit.to);
  const expected = !removed.childCount
    ? schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ id: 'empty' })])
    : /\n[ \t]*\n$/.test(normalize(source).text) ? removed.type.create(removed.attrs, removed.content.append(Fragment.from(schema.nodes.paragraph.create({ id: '' })))) : removed;
  validated(model, edit, expected);
  return edit;
}

export function indentListItem(model: Model, pos: number, direction: -1 | 1): Patch {
  const item = containerAt(model, pos, 'list_item');
  if (!item) throw new Error('请在列表项文字内使用 Tab。');
  const list = model.blocks.find(b => b.id === item.parent)!;
  const items = siblingsOf(model, item).filter(b => b.type === 'list_item');
  if (direction === 1) {
    const previous = items[items.indexOf(item) - 1];
    if (!previous) throw new Error('已经是同级第一项，无法再缩进。');
    const prefix = itemPrefix(model.source.slice(previous.from, previous.to));
    if (!prefix) throw new Error('未识别的上级列表标记，请在源码栏调整。');
    const edit = indented(model, item, prefix.indent.length + prefix.marker.length + 1);
    validated(model, edit, expectedFrom(model.doc, pos, sinkListItem(schema.nodes.list_item)));
    return edit;
  }
  const parent = list.parent === null ? null : model.blocks.find(b => b.id === list.parent)!;
  if (!parent) throw new Error('已经是第一级列表。');
  const prefix = itemPrefix(model.source.slice(parent.from, parent.to));
  if (!prefix) throw new Error('未识别的上级列表标记，请在源码栏调整。');
  const edit = indented(model, item, -(prefix.marker.length + prefix.space.length + (prefix.checked === null ? 0 : 4)));
  validated(model, edit, expectedFrom(model.doc, pos, liftListItem(schema.nodes.list_item)));
  return edit;
}

export function splitQuoteAt(model: Model, pos: number): Patch {
  if (!containerAt(model, pos, 'blockquote')) throw new Error('请在引用块内回车。');
  const block = textblockAt(model, pos);
  if (!block || block.node.textContent === '') throw new Error('空引用行请使用源码栏退出引用。');
  const depth = model.blocks.filter(b => b.type === 'blockquote' && pos >= b.pos && pos < b.pos + b.node.nodeSize).length;
  const at = renderToSource(model, pos);
  // 引用内分段需要一条空引用行，否则连续 > 行只会得到软换行。
  const edit: Patch = { from: at, to: at, insert: lineEnding(model, block.from) + '> '.repeat(depth - 1) + '>' + lineEnding(model, block.from) + '> '.repeat(depth) };
  validated(model, edit, expectedFrom(model.doc, pos, splitBlock));
  return edit;
}

export function nestQuote(model: Model, pos: number, direction: -1 | 1): Patch {
  const block = textblockAt(model, pos);
  if (!block || !containerAt(model, pos, 'blockquote')) throw new Error('请在引用块内的文字中操作。');
  if (direction === 1) {
    const edit = rewriteLines(model, block, line => `> ${line}`);
    validated(model, edit, expectedFrom(model.doc, pos, wrapIn(schema.nodes.blockquote)));
    return edit;
  }
  const edit = rewriteLines(model, block, line => {
    const match = /^[ \t]*>[ \t]?/.exec(line);
    if (!match) throw new Error('未识别的引用标记，请在源码栏调整。');
    return line.slice(match[0].length);
  });
  validated(model, edit, expectedFrom(model.doc, pos, lift));
  return edit;
}
