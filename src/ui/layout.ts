import type { DocumentSession } from '../session';
import type { EditorView } from 'prosemirror-view';
import type { EditorView as CMView } from '@codemirror/view';
import { icon } from './icons';

// 以可见块及块内像素偏移记录阅读位置，切换宽度后仍定位相同内容。
export function captureView(doc: DocumentSession, render: EditorView, source: CMView) {
  if (!doc.readOnly && source.dom.getClientRects().length) doc.sourceScroll = { top: source.scrollDOM.scrollTop, left: source.scrollDOM.scrollLeft };
  if (doc.renderRevision !== doc.revision) return;
  const pane = render.dom.closest<HTMLElement>('#render')!, top = pane.getBoundingClientRect().top;
  const block = doc.model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).find(b => {
    const dom = render.nodeDOM(b.pos);
    return dom instanceof HTMLElement && dom.getBoundingClientRect().bottom > top;
  });
  const dom = block && render.nodeDOM(block.pos);
  if (block && dom instanceof HTMLElement) doc.readingAnchor = { block: block.id, source: block.from, offset: dom.getBoundingClientRect().top - top };
}
export function restoreView(doc: DocumentSession, render: EditorView, source: CMView) {
  source.scrollDOM.scrollTop = doc.sourceScroll.top; source.scrollDOM.scrollLeft = doc.sourceScroll.left;
  const anchor = doc.readingAnchor; if (!anchor) return;
  const leaves = doc.model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).sort((a, b) => a.pos - b.pos);
  const block = leaves.find(b => b.id === anchor.block && b.from === anchor.source) ?? leaves.find(b => b.from >= anchor.source) ?? leaves.at(-1);
  const dom = block && render.nodeDOM(block.pos);
  if (dom instanceof HTMLElement) {
    const pane = render.dom.closest<HTMLElement>('#render')!;
    pane.scrollTop += dom.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
  }
}
// S-34：分隔条比例可记忆；拖动结束与键盘调整后回调持久化。
export function divider(main: HTMLElement, handle: HTMLElement, options: { initial?: number; persist?: (ratio: number) => void } = {}) {
  let ratio = 50;
  const resize = (value: number) => { ratio = Math.max(20, Math.min(80, value)); main.style.setProperty('--split', `${ratio}%`); main.style.setProperty('--left-fr', `${ratio}fr`); main.style.setProperty('--right-fr', `${100 - ratio}fr`); handle.setAttribute('aria-valuenow', String(Math.round(ratio))); };
  const commit = () => options.persist?.(Math.round(ratio));
  const reset = () => { resize(50); commit(); };
  handle.onpointerdown = event => { handle.setPointerCapture(event.pointerId); };
  handle.onpointermove = event => { if (handle.hasPointerCapture(event.pointerId)) { const rect = main.getBoundingClientRect(), outline = main.querySelector<HTMLElement>('#outline-panel')!; const width = outline.hidden ? 0 : outline.getBoundingClientRect().width; resize((event.clientX - rect.left - width) / (rect.width - width) * 100); } };
  handle.onpointerup = event => { handle.releasePointerCapture(event.pointerId); commit(); };
  handle.ondblclick = reset;
  handle.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); event.key === 'Home' ? reset() : (resize(ratio + (event.key === 'ArrowRight' ? 5 : -5)), commit()); } };
  resize(Number.isFinite(options.initial) ? options.initial! : 50);
  return { resize };
}
// S-35：专注只影响界面可见性，不改变可编辑性与文档状态。
// 工具栏与标题栏在该模式下都被隐藏，因此提供一个悬浮出口按钮，避免用户“进去出不来”。
export function applyFocusMode(on: boolean) {
  document.body.classList.toggle('focus-mode', on);
  const button = document.getElementById('focus-toggle');
  button?.setAttribute('aria-pressed', String(on));
  button?.setAttribute('data-tooltip', on ? '退出专注模式 (F11)' : '专注 (F11)');
  let exit = document.getElementById('focus-exit');
  if (!exit) {
    exit = document.createElement('button');
    exit.id = 'focus-exit'; exit.dataset.tooltip = '退出专注模式 (F11)';
    exit.setAttribute('aria-label', '退出专注模式');
    exit.innerHTML = `${icon('fullscreen')}<span>退出专注模式</span>`;
    exit.onclick = () => applyFocusMode(false);
    document.body.append(exit);
  }
  exit.hidden = !on;
}
