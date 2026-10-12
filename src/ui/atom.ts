import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { renderMath, tocEntries, tocHtml } from '../render/markdown';

export type AtomOptions = {
  readOnly: () => boolean;
  model: () => { doc: PMNode };
  fail: (reason: unknown) => void;
};

// 原子节点通过自定义事件交给 main.ts，避免模块间直接依赖。
const request = (pos: number, kind: string) => window.dispatchEvent(new CustomEvent('mdre:atom-edit', { detail: { pos, kind } }));

// 行内公式由 KaTeX 渲染；双击打开可视化编辑器。
export function mathInlineView(initial: PMNode, _view: EditorView, getPos: () => number | undefined, options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('span');
  dom.className = 'math-inline';
  const paint = () => {
    const latex = String(node.attrs.latex ?? '');
    dom.innerHTML = renderMath(latex, false);
    dom.dataset.latex = latex;
    dom.title = `${latex}\n（双击可视化编辑）`;
    dom.setAttribute('role', 'button');
    dom.setAttribute('aria-label', `公式：${latex}`);
    dom.contentEditable = 'false';
  };
  dom.addEventListener('mousedown', event => { event.preventDefault(); });
  dom.addEventListener('dblclick', event => {
    event.preventDefault();
    if (options.readOnly()) return;
    const pos = getPos();
    if (typeof pos === 'number') request(pos, 'math_inline');
  });
  paint();
  return {
    dom, stopEvent: event => ['mousedown', 'click', 'dblclick'].includes(event.type), ignoreMutation: () => true,
    update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; },
  };
}

// 块级公式由 KaTeX 渲染；双击打开可视化编辑器。
export function mathBlockView(initial: PMNode, _view: EditorView, getPos: () => number | undefined, options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('div');
  dom.className = 'math-block';
  dom.contentEditable = 'false';
  const paint = () => {
    const latex = String(node.attrs.latex ?? '');
    dom.innerHTML = renderMath(latex, true);
    dom.dataset.latex = latex;
    dom.dataset.block = String(node.attrs.id);
    dom.title = `${latex}\n（双击可视化编辑）`;
    dom.setAttribute('aria-label', `块级公式：${latex}`);
  };
  dom.addEventListener('mousedown', event => event.preventDefault());
  dom.addEventListener('dblclick', event => {
    event.preventDefault();
    if (options.readOnly()) return;
    const pos = getPos();
    if (typeof pos === 'number') request(pos, 'math_block');
  });
  paint();
  return {
    dom, stopEvent: event => event.type === 'mousedown' || event.type === 'dblclick', ignoreMutation: () => true,
    update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; },
  };
}

// S-4：脚注引用显示为编号上标，点击定位到对应定义。
export function footnoteRefView(initial: PMNode, _view: EditorView, _getPos: () => number | undefined, _options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('sup');
  dom.className = 'footnote-ref';
  const paint = () => {
    const index = Number(node.attrs.index ?? 0);
    const label = String(node.attrs.label ?? '');
    dom.textContent = String(index);
    dom.id = `footnote-ref-${label}`;
    dom.dataset.label = label;
    dom.setAttribute('role', 'doc-noteref');
    dom.setAttribute('aria-label', `脚注 ${index}：${label}`);
    dom.onclick = event => {
      event.preventDefault();
      const target = document.getElementById(`footnote-def-${index}`);
      target?.scrollIntoView({ block: 'center' });
    };
  };
  paint();
  return { dom, stopEvent: event => event.type === 'click', ignoreMutation: () => true, update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; } };
}

// S-4：定义列表由全部脚注定义渲染成文末有序表，并带 ↩ 回链。
export function footnoteDefsView(initial: PMNode, _view: EditorView, _getPos: () => number | undefined, options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('div');
  dom.className = 'footnote-defs';
  // 编号按首次引用顺序，与模型和导出一致。
  const indexOf = (label: string) => {
    const labels: string[] = [];
    options.model().doc.descendants(child => {
      if (child.type.name === 'footnote_ref') {
        const key = String(child.attrs.label);
        if (!labels.includes(key)) labels.push(key);
      }
      return true;
    });
    return labels.indexOf(label) + 1;
  };
  const paint = () => {
    const items = (node.attrs.items ?? []) as { label: string; text: string }[];
    const ordered = items.slice().sort((a, b) => indexOf(a.label) - indexOf(b.label));
    dom.innerHTML = `<hr class="footnote-defs-hr"><ol class="footnote-defs-ol">${ordered.map(item => {
      const index = indexOf(item.label);
      return `<li id="footnote-def-${index}" value="${index}"><span class="footnote-def-text">${escapeHtml(item.text)}</span> <a class="footnote-backref" href="#footnote-ref-${escapeHtml(item.label)}" aria-label="返回引用">↩</a></li>`;
    }).join('')}</ol>`;
    dom.dataset.block = String(node.attrs.id);
  };
  paint();
  return {
    dom, stopEvent: () => false, ignoreMutation: () => true,
    update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; },
  };
}

// S-3：文档内目录块，按标题层级生成可点击目录。
export function tocView(initial: PMNode, _view: EditorView, _getPos: () => number | undefined, options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('nav');
  dom.className = 'toc-block';
  dom.setAttribute('aria-label', '目录');
  const paint = () => {
    const entries = tocEntries(options.model() as never);
    dom.innerHTML = tocHtml(entries).replace(/^<nav[^>]*>|<\/nav>$/g, '');
  };
  paint();
  return { dom, stopEvent: () => false, ignoreMutation: () => true, update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; } };
}

// S-5：front matter 以折叠条呈现，不把 YAML 正文铺到渲染栏。
export function frontMatterView(initial: PMNode, _view: EditorView, getPos: () => number | undefined, options: AtomOptions): NodeView {
  let node = initial;
  const dom = document.createElement('div');
  dom.className = 'front-matter';
  const paint = () => {
    const fields = (node.attrs.fields ?? []) as { key: string; value: string }[];
    dom.innerHTML = `<button type="button" class="front-matter-toggle" aria-expanded="false">文档元数据 · ${fields.length} 项</button><dl class="front-matter-body" hidden>${fields.map(field => `<dt>${escapeHtml(field.key)}</dt><dd>${escapeHtml(field.value)}</dd>`).join('') || '<dd class="dialog-hint">未解析到键值对</dd>'}</dl>`;
    const toggle = dom.querySelector<HTMLButtonElement>('.front-matter-toggle')!;
    const body = dom.querySelector<HTMLElement>('.front-matter-body')!;
    toggle.onclick = event => {
      event.preventDefault();
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    dom.dataset.block = String(node.attrs.id);
    dom.title = '双击编辑元数据源码';
  };
  dom.addEventListener('dblclick', event => {
    event.preventDefault();
    if (options.readOnly()) return;
    const pos = getPos();
    if (typeof pos === 'number') request(pos, 'front_matter');
  });
  paint();
  return { dom, stopEvent: event => event.type === 'dblclick', ignoreMutation: () => true, update(next) { if (next.type !== node.type) return false; node = next; paint(); return true; } };
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
