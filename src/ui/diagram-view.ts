import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
import { renderDiagramImage } from '../render/mermaid';

// 渲染栏仅展示图表；源码仍由源码栏或统一源码弹窗编辑。
export function diagramView(initial: PMNode, measured?: (milliseconds: number) => void): NodeView {
  let node = initial, drawing = 0, theme = '';
  const dom = document.createElement('div');
  dom.className = 'opaque mermaid-view'; dom.contentEditable = 'false';
  function paint() {
    theme = document.documentElement.dataset.theme ?? 'light';
    dom.dataset.block = node.attrs.id;
    dom.textContent = '正在绘制图表…';
    const token = ++drawing, code = String(node.attrs.content), started = performance.now();
    void renderDiagramImage(code, 'diagram').then(image => {
      if (token !== drawing) return;
      if (!image) throw new Error('图表含不支持的内容');
      dom.innerHTML = image;
      measured?.(performance.now() - started);
    }).catch(reason => {
      if (token !== drawing) return;
      const message = document.createElement('p'), raw = document.createElement('pre');
      message.className = 'diagram-error'; message.textContent = `图表渲染失败：${String(reason)}。请在源码栏修正。`;
      raw.textContent = code; dom.replaceChildren(message, raw);
    });
  }
  paint();
  return { dom, ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type || next.attrs.kind !== 'mermaid' || next.attrs.id !== node.attrs.id) return false;
      const changed = next.attrs.content !== node.attrs.content || theme !== (document.documentElement.dataset.theme ?? 'light'); node = next;
      if (changed) paint(); return true;
    }, destroy() { drawing++; } };
}
