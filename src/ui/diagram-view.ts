import {markUi,languageAttributes,t} from '../i18n/ui';
import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
import { renderDiagramImage } from '../render/mermaid';

// 渲染栏仅展示图表；源码仍由源码栏或统一源码弹窗编辑。
export function diagramView(initial: PMNode, options: { readOnly: () => boolean; edit: () => void; remove: () => void; select: () => void }, measured?: (milliseconds: number) => void): NodeView {
  let node = initial, drawing = 0, theme = '';
  const dom = document.createElement('div');
  dom.className = 'opaque mermaid-view'; dom.contentEditable = 'false';
  const actions = document.createElement('div'); actions.className = 'diagram-actions';markUi(actions);
  const edit = document.createElement('button'), remove = document.createElement('button');
  edit.textContent = '编辑图表'; edit.setAttribute('aria-label', '编辑 Mermaid 图');
  remove.textContent = '删除'; remove.setAttribute('aria-label', '删除 Mermaid 图');
  actions.append(edit, remove);
  const preview = document.createElement('div'); preview.className = 'diagram-preview'; dom.append(actions, preview);
  edit.onclick = event => { event.stopPropagation(); options.edit(); };
  remove.onclick = event => { event.stopPropagation(); if (!options.readOnly()) options.remove(); };
  preview.onclick = () => options.select();
  preview.ondblclick = () => options.edit();
  const controls = () => { edit.textContent = options.readOnly() ? '查看图表源码' : '编辑图表'; remove.hidden = options.readOnly(); };
  function paint() {
    controls();
    theme = document.documentElement.dataset.theme ?? 'light';
    dom.dataset.block = node.attrs.id;
    preview.textContent = t('正在绘制图表…');
    const token = ++drawing, code = String(node.attrs.content), started = performance.now();
    void renderDiagramImage(code, 'diagram').then(image => {
      if (token !== drawing) return;
      if (!image) throw new Error('图表含不支持的内容');
      preview.innerHTML = image;
      measured?.(performance.now() - started);
    }).catch(reason => {
      if (token !== drawing) return;
      const message = document.createElement('p');
      message.className = 'diagram-error'; message.textContent = `${t('图表渲染失败：')}${String(reason)}${t('。请在源码栏修正。')}`;
      preview.replaceChildren(message);
    });
  }
  paint();
  return { dom, ignoreMutation: () => true, stopEvent: event => event.target instanceof Node && actions.contains(event.target),
    update(next) {
      if (next.type !== node.type || next.attrs.kind !== 'mermaid' || next.attrs.id !== node.attrs.id) return false;
      const changed = next.attrs.content !== node.attrs.content || theme !== (document.documentElement.dataset.theme ?? 'light'); node = next;
      controls();
      if (changed) paint(); return true;
    }, destroy() { drawing++; } };
}
