import type { EditorState, Transaction } from 'prosemirror-state';

// 颜色是明确的赋值，不是开关；高亮覆盖旧 == 标记，避免内层旧底色遮住新颜色。
export function colorTransaction(state: EditorState, kind: 'color' | 'bg', value: string | null): Transaction {
  const type = state.schema.marks[kind], tr = state.tr, { from, to, empty } = state.selection;
  const mark = value === null ? null : type.create({ [kind]: value });
  if (empty) {
    tr.removeStoredMark(type);
    if (kind === 'bg') tr.removeStoredMark(state.schema.marks.highlight);
    if (mark) tr.addStoredMark(mark);
  } else {
    tr.removeMark(from, to, type);
    if (kind === 'bg') tr.removeMark(from, to, state.schema.marks.highlight);
    if (mark) tr.addMark(from, to, mark);
  }
  return !empty && tr.doc.eq(state.doc) ? state.tr : tr;
}
