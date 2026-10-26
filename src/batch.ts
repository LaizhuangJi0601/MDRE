import { parse, type Model, type Range } from './model';
import { difference, patch, setHeading, type Patch } from './edits';
import { convertBlock, type BlockKind } from './blocks';
import { renderToSource } from './mapping';

// 选区右端恰在下一段开头时不包含下一段；表格、公式与源码块不参与段落转换。
export function selectedBlocks(model: Model, range: Range) {
  return model.blocks.filter(b => ['paragraph', 'heading'].includes(b.type)
    && (range.from === range.to ? range.from >= b.pos + 1 && range.from <= b.pos + b.node.nodeSize - 1
      : range.from < b.pos + b.node.nodeSize - 1 && range.to > b.pos + 1));
}
export function batchHeading(model: Model, range: Range, level: number): Patch {
  if (!Number.isInteger(level) || level < 0 || level > 6) throw new Error('标题级别需为 0–6。');
  const blocks = selectedBlocks(model, range);
  if (!blocks.length) throw new Error('请选择可编辑的段落或标题。');
  if (range.from === range.to) return level ? setHeading(model, range.from, level) : convertBlock(model, blocks[0].id, 'paragraph');
  const start = renderToSource(model, range.from, 1), end = renderToSource(model, range.to, -1);
  let source = model.source;
  for (const block of blocks.sort((a,b) => b.from - a.from)) {
    let at = block.from;
    const lines = model.source.slice(block.from, block.to).match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);
    const replacement = lines.map(line => {
      const offset = at; at += line.length;
      // Setext 下划线在改成 ATX 标题/正文时删除。
      if (block.type === 'heading' && /^\s*[=-]+\s*$/.test(line)) return '';
      if (at <= start || offset >= end || !line.trim()) return line;
      return line.replace(/^(\uFEFF?(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?)(?:#{1,6}[ \t]+)?/, (_match, prefix) => prefix + (level ? '#'.repeat(level) + ' ' : ''));
    }).join('');
    source = source.slice(0, block.from) + replacement + source.slice(block.to);
  }
  return difference(model.source, source);
}
export function batchConvert(model: Model, range: Range, kind: BlockKind, options?: {level?: number; info?: string}): Patch {
  if (kind === 'heading') return batchHeading(model, range, options?.level ?? 1);
  const blocks = selectedBlocks(model, range).sort((a,b) => b.from - a.from);
  if (!blocks.length) throw new Error('请选择可编辑段落。');
  let next = model;
  for (const original of blocks) {
    const block = next.blocks.find(b => b.from === original.from && ['paragraph','heading'].includes(b.type));
    if (!block) continue;
    if(block.parent===null && ['bullet','ordered','task','quote'].includes(kind)) {
      const raw=next.source.slice(block.from,block.to),ending=raw.endsWith('\r\n')?'\r\n':raw.endsWith('\n')?'\n':'';
      const lines=raw.replace(/(?:\r\n|\n)$/,'').split(/\r?\n/);
      if(lines.length>1) {
        const marker=kind==='quote'?'> ':kind==='task'?'- [ ] ':kind==='ordered'?'1. ':'- ';
        const edit={from:block.from,to:block.to,insert:lines.map(line=>line.trim()?marker+line:line).join(raw.includes('\r\n')?'\r\n':'\n')+ending};
        next=parse(patch(next.source,edit),next,edit);continue;
      }
    }
    const edit = convertBlock(next, block.id, kind, { ...options, followingParagraph: false });
    next = parse(patch(next.source, edit), next, edit);
  }
  return difference(model.source, next.source);
}
