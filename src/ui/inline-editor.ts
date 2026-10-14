import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { sanitizeHtml } from '../render/html';
import hljs from 'highlight.js';
import { codeLanguages, codeLanguageName } from './code-language';
import { icon } from './icons';
import { codeTheme, explicitCodeTheme, toggleCodeTheme } from './code-appearance';
import './code-theme.css';

// 原子块的源码编辑器位于渲染页内；输入法提交后才写回共享文档。
export function inlineEditor(initial: PMNode, view: EditorView, getPos: () => number | undefined,
  options: { docId?: () => string; resolveImage?: (source: string) => Promise<string | null>; readOnly: () => boolean; write: (pos: number, raw: string, final?: boolean) => boolean; fail: (reason: unknown) => void; history: (redo: boolean) => void; after: (pos: number) => void; remove: (pos: number) => void; copy: (text: string) => Promise<void>; composing: (active: boolean) => void; finished: () => void }): NodeView {
  let node = initial, composing = false, pending = false;
  const owner = options.docId?.();
  const inline = node.type.name === 'raw_inline';
  const isHtml = inline || node.attrs.kind === 'html_block';
  let editingHtml = false;
  const dom = document.createElement(inline ? 'span' : 'div');
  dom.className = inline ? 'inline-editor raw-inline-editor' : 'inline-editor opaque';
  dom.contentEditable = 'false';
  if (!inline) dom.dataset.block = node.attrs.id;
  const label = document.createElement('label'); label.className = 'opaque-label';
  const input = document.createElement('textarea'); input.spellcheck = false;
  const editor = document.createElement('div'); editor.className = 'inline-code-editor';
  const highlight = document.createElement('pre'); highlight.className = 'inline-code-highlight'; highlight.setAttribute('aria-hidden', 'true'); editor.append(highlight, input);
  input.setAttribute('aria-label', inline ? '内联 HTML 源码' : `${node.attrs.kind} 内容`);
  const language = document.createElement('select'); language.className = 'inline-language'; language.setAttribute('aria-label', '代码块语言');
  for (const [value, title] of codeLanguages) language.add(new Option(title, value));
  const preview = document.createElement('div'); preview.className = 'inline-preview';
  const htmlToggle = document.createElement('button'); htmlToggle.className = 'html-source-toggle'; htmlToggle.type = 'button';
  htmlToggle.onclick = () => { editingHtml = !editingHtml; paint(); if (editingHtml) input.focus(); };
  const fenced = () => !inline && /^(?:\s*>\s*)*\s*(`{3,}|~{3,})/.test(String(node.attrs.raw));
  const isCode = () => !inline && node.attrs.kind === 'code';
  let collapsed = isCode() && String(node.attrs.content).replace(/\n$/, '').split('\n').length >= 20;
  const header = document.createElement('div'); header.className = 'code-header';
  const fold = document.createElement('button'); fold.className = 'code-toggle';
  header.append(language, fold);
  const actions = document.createElement('div'); actions.className = 'code-actions';
  const button = (name: 'contrast' | 'trash' | 'copy', className: string, title: string) => {
    const control = document.createElement('button'); control.type = 'button'; control.className = `icon-button ${className}`;
    control.innerHTML = icon(name); control.title = title; control.dataset.tooltip = title; control.setAttribute('aria-label',title); actions.append(control); return control;
  };
  const themeButton = button('contrast','code-theme-toggle','切换代码块深浅主题');
  const deleteButton = button('trash','code-delete','删除代码块');
  const copyButton = button('copy','code-copy','复制全部代码');
  header.append(actions);
  themeButton.onclick = () => { dom.dataset.codeTheme = toggleCodeTheme(owner,String(node.attrs.id)); themeButton.setAttribute('aria-pressed',String(dom.dataset.codeTheme === 'dark')); };
  deleteButton.onclick = () => { const pos = getPos(); if (typeof pos === 'number' && !options.readOnly()) options.remove(pos); };
  copyButton.onclick = () => { void options.copy(isCode() ? input.value : String(node.attrs.content)).catch(options.fail); };
  const gutter = document.createElement('div'); gutter.className = 'code-line-numbers'; gutter.setAttribute('aria-hidden', 'true');
  const measure = document.createElement('div'); measure.className = 'code-line-measure'; measure.setAttribute('aria-hidden', 'true');
  editor.append(gutter, measure);
  const foldState = () => {
    const code = isCode(); header.hidden = !code; label.hidden = code;
    dom.classList.toggle('code-block', code);
    editor.hidden = code && collapsed; language.hidden = !code;
    const name = codeLanguageName(language.value);
    language.title = `代码语言：${name}`;
    fold.textContent = `${collapsed ? '▸ 展开' : '▾ 折叠'} · ${input.value.split('\n').length} 行`;
    fold.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${name} 代码块`);
    fold.title = collapsed ? '展开代码块' : '折叠代码块';
    fold.setAttribute('aria-expanded', String(!collapsed));
    editor.classList.toggle('with-lines', code);
    gutter.hidden = !code;
  };
  fold.onclick = () => { collapsed = !collapsed; foldState(); requestAnimationFrame(resize); };
  const raw = () => {
    if (!isCode()) return input.value;
    const old = String(node.attrs.raw), eol = old.includes('\r\n') ? '\r\n' : '\n';
    if (!fenced()) {
      if (language.value !== 'text') {
        const fence = '`'.repeat(Math.max(3, ...(input.value.match(/`+/g) ?? []).map(run => run.length + 1)));
        const prefix = /^((?:[ \t]*>[ \t]?)*)(?: {4}|\t)/.exec(old)?.[1] ?? '';
        return prefix + fence + language.value + eol + input.value.replace(/\r\n|\r/g, '\n').split('\n').map(line => prefix + line).join(eol) + eol + prefix + fence + (/\n$/.test(old) ? eol : '');
      }
      const prefix = /^([ \t]*>[ \t]?)*(?: {4}|\t)/.exec(old)?.[0] ?? '    ';
      return input.value.replace(/\r\n|\r/g, '\n').split('\n').map(line => prefix + line).join(eol) + (/\n$/.test(old) ? eol : '');
    }
    const match = /^((?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})/.exec(old)!;
    const prefix = match[1], char = match[2][0];
    const runs = input.value.match(char === '`' ? /`+/g : /~+/g) ?? [];
    const fence = char.repeat(Math.max(match[2].length, ...runs.map(run => run.length + 1)));
    return prefix + fence + language.value.trim().replace(/[\r\n`]/g, '') + eol + input.value.replace(/\r\n|\r/g, '\n').split('\n').map(line => prefix + line).join(eol) + eol + prefix + fence + (/\n$/.test(old) ? eol : '');
  };
  function resize() {
    foldState();
    if (editor.hidden) return;
    const scrollTop = input.scrollTop;
    input.style.height = 'auto';
    const naturalHeight = Math.max(inline ? 30 : 70, input.scrollHeight + 2);
    // 代码正文最多显示 20 个可见行，超出部分由 textarea 原生滚轮滚动。
    const style = getComputedStyle(input);
    const maxHeight = parseFloat(style.lineHeight) * 20 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    input.style.height = `${isCode() ? Math.min(naturalHeight, maxHeight) : naturalHeight}px`;
    editor.style.setProperty('--code-scrollbar-width', `${input.offsetWidth - input.clientWidth}px`);
    const lang = isCode() ? language.value.trim().split(/\s/)[0] || 'text' : 'xml';
    if (!inline && hljs.getLanguage(lang)) highlight.innerHTML = hljs.highlight(input.value + '\n', { language: lang }).value;
    else highlight.textContent = input.value + '\n';
    if (isCode()) {
      const lines = input.value.split('\n');
      measure.replaceChildren(...lines.map(line => { const row = document.createElement('span'); row.textContent = line || '\u200b'; return row; }));
      gutter.replaceChildren(...[...measure.children].map((line, index) => { const row = document.createElement('span'); row.textContent = String(index + 1); row.style.height = `${line.getBoundingClientRect().height}px`; return row; }));
    }
    input.scrollTop = scrollTop;
    syncScroll();
  }
  function paint() {
    const readonly = options.readOnly(); input.readOnly = readonly; language.disabled = readonly;
    deleteButton.disabled = readonly;
    const theme=explicitCodeTheme(owner,String(node.attrs.id));
    if(theme) dom.dataset.codeTheme=theme; else delete dom.dataset.codeTheme;
    themeButton.setAttribute('aria-pressed',String(codeTheme(owner,String(node.attrs.id)) === 'dark'));
    dom.querySelectorAll<HTMLButtonElement>('.inline-after').forEach(button => button.disabled = readonly);
    label.textContent = inline ? '内联 HTML' : `${node.attrs.kind} · 在此直接编辑`;
    const info = fenced() ? String(node.attrs.info ?? '') : 'text';
    if (![...language.options].some(option => option.value === info)) language.add(new Option(codeLanguageName(info), info));
    language.value = info;
    const text = isCode() ? String(node.attrs.content).replace(/\n$/, '') : String(node.attrs.raw);
    if (input.value !== text) { const from = input.selectionStart, to = input.selectionEnd; input.value = text; if (document.activeElement === input) input.setSelectionRange(Math.min(from, text.length), Math.min(to, text.length)); }
    resize(); preview.replaceChildren();
    if (node.attrs.kind === 'html_block' || inline) {
      preview.innerHTML = sanitizeHtml(String(node.attrs.content || node.attrs.raw));
      for (const image of preview.querySelectorAll<HTMLImageElement>('img[src]')) {
        const original = image.getAttribute('src')!;
        if (/^(?:https?:|data:)/i.test(original) || !options.resolveImage) continue;
        options.resolveImage(original).then(url => { if (url && image.isConnected && options.docId?.() === owner) image.src = url; }).catch(options.fail);
      }
      editor.hidden = !editingHtml; label.hidden = !editingHtml;
      htmlToggle.textContent = editingHtml ? '收起 HTML 源码' : '编辑 HTML 源码';
      htmlToggle.hidden = readonly;
    } else if (node.attrs.kind === 'hr') preview.append(document.createElement('hr'));
  }
  function write(final = false) { if (composing || options.readOnly()) return; const pos = getPos(); if (typeof pos !== 'number') return; try { pending = !options.write(pos, raw(), final); label.textContent = pending ? '正在编辑未完成的语法 · 离开编辑区后提交' : inline ? '内联 HTML' : `${node.attrs.kind} · 在此直接编辑`; } catch (reason) { options.fail(reason); } resize(); }
  input.addEventListener('input', () => write()); language.addEventListener('change', () => write());
  input.addEventListener('blur', () => { if (pending) write(true); });
  for (const control of [input, language]) {
    control.addEventListener('compositionstart', event => { event.stopPropagation(); composing = true; options.composing(true); });
    control.addEventListener('compositionend', event => { event.stopPropagation(); composing = false; options.composing(false); write(); options.finished(); });
    control.addEventListener('keydown', genericEvent => {
      const event = genericEvent as KeyboardEvent;
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); options.history(event.key.toLowerCase() === 'y' || event.shiftKey); }
      if (control === input && event.key === 'Tab' && !options.readOnly()) { event.preventDefault(); input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); write(); }
    });
  }
  dom.append(label, header, editor, preview);
  if (isHtml) dom.append(htmlToggle);
  if (!inline && !isCode()) { const after = document.createElement('button'); after.className = 'inline-after'; after.textContent = '下方新增段落'; after.onclick = () => { const pos = getPos(); if (typeof pos === 'number' && !options.readOnly()) options.after(pos); }; dom.append(after); }
  paint();
  let lastWidth = -1;
  const observer = new ResizeObserver(() => { const width = editor.clientWidth; if (width > 0 && width !== lastWidth) { lastWidth = width; resize(); } }); observer.observe(editor);
  function syncScroll() { highlight.scrollTop = input.scrollTop; gutter.style.transform = `translateY(${-input.scrollTop}px)`; }
  input.addEventListener('scroll', syncScroll);
  return { dom, stopEvent: () => true, ignoreMutation: () => true,
    destroy() { observer.disconnect(); },
    update(next) { if (options.docId?.() !== owner || next.type !== node.type || (!inline && next.attrs.id !== node.attrs.id)) return false; node = next; paint(); return true; },
  };
}
