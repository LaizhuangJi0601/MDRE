import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';

// 标点、符号与 emoji 已是完整输入；拼音字母和中文候选仍由输入法正常确认。
export function completeSymbol(text: string | null): boolean {
  return !!text && /[\p{P}\p{S}]/u.test(text) && /^[\p{P}\p{S}\p{M}\u200d\ufe0e\ufe0f]+$/u.test(text);
}

export function commitSymbolComposition(view: EditorView, active: () => boolean) {
  let pending = 0;
  view.dom.addEventListener('input', genericEvent => {
    const event = genericEvent as InputEvent;
    clearTimeout(pending);
    if (event.inputType !== 'insertCompositionText' || !completeSymbol(event.data) || !active()) return;
    pending = window.setTimeout(() => {
      if (!active() || !view.composing || !view.hasFocus()) return;
      const selection = view.dom.ownerDocument.getSelection();
      if (!selection?.rangeCount || !view.dom.contains(selection.focusNode)) return;
      // Chromium/WebView2 的标点候选可一直保留高亮组合区。暂时结束编辑器焦点让
      // 浏览器提交该组合，再显式恢复右侧空光标，避免下一次打字/Enter 替换符号。
      view.dom.blur();
      selection.collapseToEnd();
      if (selection.focusNode && view.dom.contains(selection.focusNode)) {
        const at = view.posAtDOM(selection.focusNode, selection.focusOffset);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
      }
      view.focus();
    }, 0);
  });
}
