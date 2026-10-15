export type CellAlignment = 'left' | 'center' | 'right';

// 用标准行内 HTML 保存单格对齐，保留格内 Markdown；其它阅读器也能显示位置。
export function alignedCell(raw: string): { text: string; align: CellAlignment | null } {
  const match = /^<span style="display:block;text-align:(left|center|right)">([\s\S]*)<\/span>$/.exec(raw);
  return match ? { text: match[2], align: match[1] as CellAlignment } : { text: raw, align: null };
}
export function wrapCell(text: string, align: CellAlignment | null): string {
  return align ? `<span style="display:block;text-align:${align}">${text}</span>` : text;
}
