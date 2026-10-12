export const mathUnsupported = '该公式无法用可视化编辑器编辑，请在源码栏中修改';

export type FormulaTag = { from: number; to: number; argument: string; starred: boolean; raw: string };
export type TaggedFormula = { source: string; body: string; tag?: FormulaTag };
export const plainFormulaNumber = (value: string) => /^[\p{L}\p{N}\p{M} .,，:：;；()（）\[\]+=/\-]+$/u.test(value);

// 按 TeX 控制序列与分组扫描，跳过注释、转义字符和 verb 字面量。
function token(source: string, from: number) {
  const match = /^\\(?:[a-zA-Z]+|[^\r\n])/.exec(source.slice(from));
  if (!match) throw new Error(mathUnsupported);
  let to = from + match[0].length;
  if (match[0] === '\\verb') {
    if (source[to] === '*') to++;
    const delimiter = source[to++];
    if (!delimiter || /\s/.test(delimiter)) throw new Error(mathUnsupported);
    const end = source.indexOf(delimiter, to);
    if (end < 0) throw new Error(mathUnsupported);
    to = end + 1;
  }
  return { command: match[0], to };
}
function commentEnd(source: string, from: number) {
  const end = source.slice(from).search(/[\r\n]/);
  return end < 0 ? source.length : from + end;
}
function group(source: string, from: number) {
  if (source[from] !== '{') throw new Error(mathUnsupported);
  let depth = 1, at = from + 1;
  while (at < source.length) {
    if (source[at] === '\\') { at = token(source, at).to; continue; }
    if (source[at] === '%') { at = commentEnd(source, at); continue; }
    if (source[at] === '{') depth++;
    if (source[at] === '}' && --depth === 0) return { argument: source.slice(from + 1, at), to: at + 1 };
    at++;
  }
  throw new Error(mathUnsupported);
}

export function splitFormulaTag(source: string, display: boolean): TaggedFormula {
  let at = 0, depth = 0, environments = 0, tag: FormulaTag | undefined;
  while (at < source.length) {
    const char = source[at];
    if (char === '%') { at = commentEnd(source, at); continue; }
    if (char === '\\') {
      const control = token(source, at);
      if (control.command === '\\tag') {
        if (!display || depth || environments || tag) throw new Error(mathUnsupported);
        let next = control.to;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        const starred = source[next] === '*';
        if (starred) next++;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        const argument = group(source, next);
        tag = { from: at, to: argument.to, starred, argument: argument.argument, raw: source.slice(at, argument.to) };
        at = argument.to; continue;
      }
      if (control.command === '\\begin' || control.command === '\\end') {
        let next = control.to;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        const name = group(source, next);
        environments += control.command === '\\begin' ? 1 : -1;
        if (environments < 0) throw new Error(mathUnsupported);
        at = name.to; continue;
      }
      at = control.to; continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth < 0) throw new Error(mathUnsupported);
    at++;
  }
  if (depth || environments) throw new Error(mathUnsupported);
  return { source, tag, body: tag ? source.slice(0, tag.from) + source.slice(tag.to) : source };
}

export function joinFormulaTag(formula: TaggedFormula, body: string, enabled: boolean, number: string, starred: boolean): string {
  const original = formula.tag;
  let raw = '';
  if (enabled) {
    const argument = original && number === original.argument ? original.argument : number.trim();
    if ((!original || number !== original.argument) && !plainFormulaNumber(argument)) throw new Error('请输入普通公式编号，例如 1、3a 或 A.1；复杂编号请在源码栏中修改。');
    raw = original && argument === original.argument && starred === original.starred ? original.raw : `\\tag${starred ? '*' : ''}{${argument}}`;
  }
  // 仅改编号时，主体每个字节以及编号的原位置均保持不变。
  if (body === formula.body) return original ? formula.source.slice(0, original.from) + raw + formula.source.slice(original.to) : formula.source + (raw ? `\n${raw}` : '');
  // 单独换行避免主体末尾注释吞掉编号；仍是标准 LaTeX。
  return body + (raw ? `\n${raw}` : '');
}
