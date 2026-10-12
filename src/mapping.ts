import type { Model, Range } from './model';
import type { Selection } from './session';

export function mapOffset(offset: number, edit: Range & { insert: string }): number {
  return offset < edit.from ? offset : offset <= edit.to ? edit.from + edit.insert.length : offset + edit.insert.length - (edit.to - edit.from);
}

export function viewOffset(model: Model, raw: number): number {
  let from = 0, to = model.offsets.length - 1;
  while (from < to) { const middle = (from + to) >>> 1; if (model.offsets[middle] < raw) from = middle + 1; else to = middle; }
  return from;
}
export function sourceToRender(model: Model, offset: number, side = 1): number {
  const char = model.chars.find(c => c.from <= offset && offset < c.to);
  if (char) return offset > char.from && side < 0 ? model.chars.filter(c => c.from === char.from && c.to === char.to).at(-1)!.pos + 1 : char.pos;
  const block = model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).find(b => offset >= b.from && (offset < b.to || offset === b.from));
  if (block) {
    const chars = model.chars.filter(c => c.block === block.id);
    const right = chars.find(c => c.from >= offset);
    return right?.pos ?? (chars.at(-1) ? chars.at(-1)!.pos + 1 : block.pos + (block.node.isTextblock ? 1 : 0));
  }
  const next = model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).find(b => b.from > offset);
  return next ? next.pos + (next.node.isTextblock ? 1 : 0) : model.doc.content.size - 1;
}
export function renderToSource(model: Model, pos: number, side = 1): number {
  const right = model.chars.find(c => c.pos === pos), left = model.chars.find(c => c.pos + 1 === pos);
  if (side < 0 && left) return left.to;
  if (right) return right.from;
  if (left) return left.to;
  const block = model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).find(b => pos >= b.pos && pos < b.pos + b.node.nodeSize);
  return block?.from ?? model.source.length;
}
export function mapRenderRange(before: Model, next: Model, range: Range, edit: Range & { insert: string }): Range {
  const endpoint = (pos: number, side: number) => {
    const block = before.blocks.find(b => b.node.isTextblock && pos >= b.pos + 1 && pos <= b.pos + b.node.nodeSize - 1);
    const moved = block && next.blocks.find(b => b.id === block.id);
    if (block && moved && block.node.content.eq(moved.node.content)) return moved.pos + pos - block.pos;
    return sourceToRender(next, mapOffset(renderToSource(before, pos, side), edit), side);
  };
  const from = endpoint(range.from, 1), to = range.from === range.to ? from : endpoint(range.to, -1);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}
export function projectSelection(model: Model, selection: Selection): Selection {
  const active: Range = selection[selection.active];
  if (selection.active === 'source') {
    const from = sourceToRender(model, active.from), to = active.from === active.to ? from : sourceToRender(model, active.to, -1);
    return { source: active, render: { from, to }, active: 'source' };
  }
  const from = renderToSource(model, active.from), to = active.from === active.to ? from : renderToSource(model, active.to, -1);
  return { render: active, source: { from, to }, active: 'render' };
}
