import { Transform } from 'prosemirror-transform';
import { type Model, type Range } from './model';
import { validated } from './edits';
import { splitFormulaTag, mathUnsupported } from './math-tag';

export { mathUnsupported } from './math-tag';
export type FormulaTarget = { pos: number; kind: 'math_inline' | 'math_block'; latex: string; range: Range; prefix: string; eol: string };

// 只替换分隔符内部；保留 BOM、引用/列表前缀、分隔符及原有换行。
export function formulaTarget(model: Model, pos: number): FormulaTarget {
  const node = model.doc.nodeAt(pos);
  if (!node || !['math_inline', 'math_block'].includes(node.type.name)) throw new Error('公式位置已变化，请刷新渲染后重试。');
  const latex = String(node.attrs.latex);
  if (node.type.name === 'math_inline') {
    const atom = model.atoms.find(a => a.kind === 'math' && a.pos === pos);
    if (!atom || model.source[atom.from] !== '$' || model.source[atom.to - 1] !== '$') throw new Error(mathUnsupported);
    return { pos, kind: 'math_inline', latex, range: { from: atom.from + 1, to: atom.to - 1 }, prefix: '', eol: '' };
  }
  const block = model.blocks.find(b => b.type === 'math_block' && b.pos === pos);
  if (!block) throw new Error(mathUnsupported);
  const raw = model.source.slice(block.from, block.to);
  const opening = /^[^\r\n]*\$\$[ \t]*(\r\n|\r|\n)/.exec(raw);
  const closing = /(?:^|\r\n|\r|\n)([^\r\n]*?)\$\$[ \t]*(?:(?:\r\n|\r|\n))?$/.exec(raw);
  if (!opening || !closing || closing.index < opening[0].length - opening[1].length) throw new Error(mathUnsupported);
  const end = closing.index + (/^\r\n/.test(closing[0]) ? 2 : /^[\r\n]/.test(closing[0]) ? 1 : 0);
  return { pos, kind: 'math_block', latex, range: { from: block.from + opening[0].length, to: block.from + end }, prefix: closing[1], eol: opening[1] };
}

export function formulaEdit(model: Model, target: FormulaTarget, latex: string) {
  const node = model.doc.nodeAt(target.pos);
  if (!node || node.type.name !== target.kind || node.attrs.latex !== target.latex) throw new Error('公式已变化，修改未提交。');
  // 空公式、占位符和分隔符不能可靠写回现有 Markdown 公式节点。
  if (!latex.trim() || /\\placeholder\b/.test(latex) || /(^|[^\\])(?:\\\\)*\$/.test(latex) || (target.kind === 'math_inline' && /[\r\n]/.test(latex))) throw new Error(mathUnsupported);
  let content = latex.split(/\r\n|\r|\n/).map(line => line.trim()).join('\n');
  let insert = target.kind === 'math_inline' ? latex : content.split('\n').map(line => target.prefix + line).join(target.eol) + target.eol;
  if (target.kind === 'math_block') {
    const before = splitFormulaTag(target.latex, true), after = splitFormulaTag(latex, true);
    if (before.body.trimEnd() === after.body.trimEnd()) {
      // 仅改编号时在原始片段上替换，保留主体的缩进、空格与换行。
      const raw = model.source.slice(target.range.from, target.range.to), originalTag = splitFormulaTag(raw, true).tag;
      const replacement = after.tag?.raw.split(/\r\n|\r|\n/).join(target.eol + target.prefix) ?? '';
      insert = originalTag ? raw.slice(0, originalTag.from) + replacement + raw.slice(originalTag.to) : raw + (replacement ? target.prefix + replacement + target.eol : '');
      content = insert.slice(0, -target.eol.length).split(/\r\n|\r|\n/).map(line => (line.startsWith(target.prefix) ? line.slice(target.prefix.length) : line).trim()).join('\n');
    }
  }
  const expected = new Transform(model.doc).setNodeMarkup(target.pos, undefined, { ...node.attrs, latex: target.kind === 'math_inline' ? latex : content }).doc;
  try { return validated(model, { ...target.range, insert }, expected); }
  catch (cause) { throw new Error(mathUnsupported, { cause }); }
}
