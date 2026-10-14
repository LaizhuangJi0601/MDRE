import './style.css';
import { EditorState as CMState, Compartment } from '@codemirror/state';
import { EditorView as CMView, keymap as cmKeymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { markdown as cmMarkdown, markdownKeymap } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, splitBlock, lift } from 'prosemirror-commands';
import { splitListItem, liftListItem } from 'prosemirror-schema-list';
import { Fragment, Slice } from 'prosemirror-model';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { normalize, parse, schema, markdown, type Atom, type Block, type Model } from './model';
import { difference, renderedEdit, setImageWidth, setInlineHtml, splitParagraph, joinParagraph, setHeading, swapSibling, toggleTask, type Patch } from './edits';
import { formulaTarget, formulaEdit, mathUnsupported, type FormulaTarget } from './math-edit';
import { imageExtension, imageMarkdown, resolveImage, saveImage } from './assets';
import { convertBlock, moveBlock, deleteBlock, indentListItem, nestQuote, withFollowingParagraph, type BlockKind } from './blocks';
import { insertTable, insertRow, removeRow, insertColumn, removeColumn, setTableCell } from './tables';
import { projectSelection, mapRenderRange, viewOffset } from './mapping';
import { DocumentSession, Workspace, type Draft, type Selection, type Ticket } from './session';
import { staticHtml, safeUrl, exportAppearance } from './export';
import { shell } from './ui/shell';
import { setupPaper } from './ui/paper';
import { setupSidebar } from './ui/sidebar';
import { paperPagination } from './ui/pagination';
import { groupToolbar } from './ui/toolbar';
import { setupFiles } from './ui/files';
import { icon, type Icon } from './ui/icons';
import { setupMenus, setupTooltips, setupWindowControls } from './ui/chrome';
import { captureView, restoreView, divider, applyFocusMode } from './ui/layout';
import { ScrollSync } from './ui/scroll';
import { setupDefaultMode, setupTheme } from './ui/theme';
import { searchPlugin, find, replaceAll, replaceCurrent } from './ui/search';
import { currentOutline, outlineEntries, renderOutline, type OutlineEntry } from './ui/outline';
import { readRecovery, restore, RecoveryManager } from './persistence/recovery';
import { SaveQueue, autosaveAll, directoryOf, discardRecovery, discardRecoveryAt, pathKey, pickFile, readTextFile, samePath, startAutosave } from './persistence/save';
import { loadSettings, saveSettings, settings, shortcutOf, matchShortcut, shortcutCommands, RECENT_LIMIT } from './persistence/settings';
import { renderDiagram, setDiagramTheme } from './render/mermaid';
import { footnoteDefsView, footnoteRefView, frontMatterView, mathBlockView, mathInlineView, tocView } from './ui/atom';
import hljs from 'highlight.js';
import 'katex/dist/katex.min.css';
import { inlineEditor } from './ui/inline-editor';
import { diagramView } from './ui/diagram-view';
import { setupColorPicker } from './ui/color-picker';
import { setupPreferences } from './ui/preferences';
import { colorTransaction } from './ui/color-format';
import { contextMenu, type ContextItem } from './ui/context-menu';
import { positionDialog } from './ui/dialogs';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = shell;
groupToolbar();


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('panes').append($('welcome'));
$('sidebar-title').textContent = '';
$('sidebar-title').append(document.querySelector<HTMLElement>('.sidebar-actions')!);
$('sidebar-title').setAttribute('aria-label', '侧栏文件操作');
// 事件目标是 DOM 节点时不一定有 closest（例如文本节点或合成事件），统一用该助手避免抛错中断监听。
const closestOf = <T extends Element = Element>(target: EventTarget | null, selector: string): T | null =>
  target instanceof Element ? target.closest<T>(selector) : null;
const settingsRead = await loadSettings().catch(() => null);
const paper = setupPaper($('render'), $('paper-toggle') as HTMLButtonElement, $('paper-zoom'), reason => error(reason));
const sidebar = setupSidebar(reason => error(reason));
let sourceVisible = settings().show_source, sourceDefault = sourceVisible;
const workspace = new Workspace();
let restoringWorkspace = true;
const workspaceRestoreErrors: string[] = [];
const filesPanel = setupFiles({ open: openPath, activate: id => action(() => switchTo(id)), fail: reason => error(reason), reveal: () => { toggleOutline(false); status(); }, opened: updateRecentFolder, changed: () => { void rememberWorkspace().catch(reason => error(reason)); } });
const recoveryRead = await readRecovery();
// 同一文件可能留下多条恢复快照（多次打开/关闭/异常退出）。按规范化路径只恢复最新一条，
// 其余在磁盘上清除，避免启动后同一份文件出现多个标签。
const recoveryNewest = new Map<string, (typeof recoveryRead.snapshots)[number]>();
const recoveryStale: { id: string; root: string | null }[] = [];
for (const record of recoveryRead.snapshots) {
  if (!record.path) { recoveryNewest.set(`id:${record.id}`, record); continue; }
  const key = pathKey(record.path);
  const previous = recoveryNewest.get(key);
  if (!previous) { recoveryNewest.set(key, record); continue; }
  const discard = (previous.updatedAt ?? 0) >= (record.updatedAt ?? 0) ? record : previous;
  recoveryNewest.set(key, discard === previous ? record : previous);
  recoveryStale.push({ id: discard.id, root: discard.recoveryRoot ?? null });
}
for (const record of recoveryNewest.values()) workspace.add(restore(record, recoveryRead.root));
// 清理多余快照：目录名是 docId 的哈希，直接用快照记录的 recoveryRoot 最稳妥。
for (const stale of recoveryStale) {
  if (!isTauri()) break;
  if (stale.root) await discardRecoveryAt(stale.root).catch(() => {});
  else await discardRecovery(stale.id).catch(() => {});
}
const boot = workspace.active ?? new DocumentSession('boot', '');
const mode = new Compartment(), theme = new Compartment();
let mirror = false, previewTicket: Ticket | null = null, parseTimer: ReturnType<typeof setTimeout> | undefined;
let compositionBase: { session: DocumentSession; ticket: Ticket; model: ReturnType<typeof parse>; selection: Selection } | null = null;
let activeDraft: Draft | null = null, draftBlock: Block | null = null, draftAtom: Atom | null = null, draftLanguage: string | null = null, draftFence = false, queuedRefresh = false, pendingMode = false;
let scrollSync: ScrollSync | undefined, outlineActive: string | null = null;
const recovery = new RecoveryManager(workspace, () => status());
const saveQueue = new SaveQueue(() => status());
const error = (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason); $('error').textContent = message;
  if ($<HTMLDialogElement>('dialog').open) $('dialog-error').textContent = message;
  for (const kind of ['link', 'code', 'table']) if ($<HTMLDialogElement>(`${kind}-dialog`).open) $(`${kind}-error`).textContent = message;
};
function action(operation: () => void | Promise<void>) {
  $('error').textContent = '';
  try { const result = operation(); if (result instanceof Promise) result.catch(error); } catch (reason) { error(reason); }
}
function selection(): Selection {
  const doc = workspace.active;
  const cm = source.state.selection.main, pm = render.state.selection;
  return { source: { from: doc.viewToSource(cm.from), to: doc.viewToSource(cm.to) }, render: previewTicket && workspace.accept(previewTicket) ? { from: pm.from, to: pm.to } : doc.selection.render, active: doc.selection.active };
}
// 大文档（≥ 1 MB）状态栏改用廉价统计：避免每次按键都遍历整篇渲染文档并做分词。
function textCounts(doc: DocumentSession) {
  if (sourceBytes(doc.source) >= previewLimit) {
    const text = doc.source;
    return { chars: [...text.replace(/\s/g, '')].length, words: (text.match(/[\p{L}\p{N}]+/gu) ?? []).length };
  }
  const plain = doc.model.doc.textBetween(0, doc.model.doc.content.size, '\n', node => node.type.name === 'opaque' ? String(node.attrs.content || node.attrs.raw || '') : node.type.name === 'image' ? String(node.attrs.alt || '') : node.type.name === 'raw_inline' ? '' : '\n');
  return { chars: [...plain.replace(/\s/g, '')].length, words: Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(plain)).filter(part => part.isWordLike).length };
}
function status() {
  const doc = workspace.active;
  const available = !!doc && !doc.welcome;
  document.querySelectorAll<HTMLButtonElement>('button[data-command], #format-toolbar button, .view-tools button, #mode, #save, #save-as, #close-tab, #html, #pdf-open, #backup').forEach(button => { button.disabled = !available; });
  document.querySelectorAll<HTMLButtonElement>('#outline-toggle, [data-command="outline-toggle"]').forEach(button => button.disabled = false);
  $<HTMLButtonElement>('close-tab').disabled = !doc;
  if (!available) { syncTabs(); document.title = 'MDRE'; $('window-title').textContent = 'MDRE'; $('status-text').textContent = '欢迎使用 MDRE'; for (const id of ['status-counts', 'status-encoding', 'status-position', 'status-path', 'recovery-status']) $(id).textContent = ''; $('render-timing').hidden = true; return; }
  const { chars, words } = textCounts(doc);
  const cursor = source.state.selection.main.head, line = source.state.doc.lineAt(cursor);
  const saveText = doc.saveStatus === 'conflict' ? `保存冲突：${doc.saveError}` : doc.saveStatus === 'failed' ? `保存失败：${doc.saveError}` : doc.saveStatus === 'saving' ? '正在保存…' : doc.dirty ? '已修改 · 尚未保存' : doc.path ? '已保存' : '尚未保存为文件';
  $('status-counts').textContent = `${chars} 字符 · ${words} 词`;
  $('status-encoding').textContent = doc.encoding.toUpperCase();
  $('status-encoding').title = `文件编码：${doc.encoding.toUpperCase()}${doc.bom ? '（BOM）' : ''}`;
  $('status-position').textContent = doc.readOnly ? '' : `行 ${line.number}，列 ${cursor - line.from + 1}`;
  $('status-text').textContent = `${saveText}${doc.composition ? ' · 输入中' : ''}${pendingMode ? ' · 待切换模式' : ''}${doc.modelStale ? ' · 模型待刷新' : ''}${doc.recovered ? ' · 恢复副本' : ''}`;
  $('status-text').dataset.state = doc.saveStatus === 'conflict' || doc.saveStatus === 'failed' ? 'error' : doc.dirty ? 'modified' : 'saved';
  $('status-text').title = doc.saveError || `文档版本 r${doc.revision}${doc.recovered ? '；恢复副本需手动保存后启用自动保存' : ''}`;
  const displayPath = doc.path?.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') ?? '';
  $('status-path').textContent = displayPath ? displayPath.replace(/^.*[\\/]/, '') : doc.title;
  $('status-path').title = displayPath || '尚未绑定正式文件';
  const recoveryText = doc.recoveryState === 'failed' ? `恢复备份失败：${doc.recoveryError}` : doc.recoveryState === 'writing' ? '正在写入恢复快照…' : doc.recoveryRevision >= 0 ? `已恢复备份 · ${doc.path ? '不代替正式保存' : '尚未保存为文件'}${doc.recoveryRevision < doc.revision ? ' · 有较新修改待备份' : ''}` : '恢复快照 · 每 60 秒';
  $('recovery-status').textContent = doc.recoveryState === 'failed' ? '快照失败' : doc.recoveryState === 'writing' ? '快照写入中' : doc.recoveryRevision >= 0 ? '快照已备份' : '';
  $('recovery-status').dataset.state = doc.recoveryState === 'failed' ? 'error' : 'normal';
  if (recoveryRead.errors.length) { $('recovery-status').textContent += ' · 恢复读取异常'; $('recovery-status').title = recoveryRead.errors.join('\n'); }
  else $('recovery-status').title = recoveryText;
  $('mode-label').textContent = doc.readOnly ? '阅读模式' : '编辑模式';
  $('mode').querySelector('svg')!.outerHTML = icon(doc.readOnly ? 'book' : 'columns');
  $('mode').setAttribute('aria-pressed', String(doc.readOnly));
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button => button.setAttribute('aria-checked', String((button.dataset.mode === 'read') === doc.readOnly)));
  markOutline();
  document.querySelectorAll<HTMLButtonElement>('[data-editable]').forEach(button => button.disabled = doc.readOnly);
  const marker = doc.saveState === 'conflict' || doc.saveState === 'failed' ? '⚠ ' : doc.saveState === 'pending' ? '● ' : '';
  document.title = `${marker}${doc.title} — MDRE`;
  $('window-title').textContent = `${doc.title} — MDRE`;
  syncTabs();
  updateOutline();
}
const tabState = (session: DocumentSession) => session.saveState === 'conflict' || session.saveState === 'failed' ? '⚠' : session.saveState === 'pending' ? '●' : session.recovered ? '↶' : '';
// 保留标签节点，避免编辑器失焦/保存状态刷新在按下与点击之间替换关闭按钮。
function syncTabs() {
  void rememberWorkspace().catch(reason => error(reason));
  filesPanel.sync([...workspace.documents.values()], workspace.activeId);
  const tabs = $('tabs');
  const existing = new Map(Array.from(tabs.querySelectorAll<HTMLButtonElement>('[data-tab]'), child => [child.dataset.tab!, child]));
  for (const [id, button] of existing) if (!workspace.documents.has(id)) button.remove();
  let index = 0;
  for (const [id, session] of workspace.documents) {
    const button = existing.get(id) ?? tabElement(id, session);
    updateTab(button, id, session);
    const at = tabs.children.item(index++);
    if (at !== button) tabs.insertBefore(button, at);
  }
  tabs.append($('new-welcome'));
}
function updateTab(button: HTMLButtonElement, id: string, session: DocumentSession) {
  button.querySelector('.tab-label')!.textContent = session.title;
  button.querySelector('.tab-close')?.setAttribute('aria-label', '关闭 ' + session.title);
  button.querySelector('.tab-state')!.textContent = tabState(session);
  button.classList.toggle('active', id === workspace.activeId); button.setAttribute('aria-current', String(id === workspace.activeId));
  // 多文件时标签栏会横向溢出：活动标签必须滚入可视区，否则切到后面的文件会像“被遮挡”。
  if (id === workspace.activeId) requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const state = session.saveState;
  button.title = `${session.path ?? '未绑定正式文件'}${session.recovered ? ' · 恢复会话' : ''}${state === 'pending' ? ' · 有未保存修改' : state === 'conflict' ? ' · 保存冲突' : state === 'failed' ? ` · 保存失败：${session.saveError}` : ''}`;
}
// A-10/D-16：标签可点选、关闭与拖动重排；每个标签的状态只反映自己的文档。
function tabElement(id: string, session: DocumentSession) {
  const button = document.createElement('button');
  button.innerHTML = icon('markdown'); button.dataset.tab = id; button.draggable = true;
  const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = session.title; button.append(label);
  // 关闭按钮紧跟文件名：标签被压缩时先省略文件名，序号与关闭入口保持可用。
  const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.title = '关闭标签 (Ctrl+W)'; close.setAttribute('role', 'button'); close.setAttribute('aria-label', '关闭 ' + session.title); close.tabIndex = 0; close.draggable = false;
  close.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); action(() => closeTab(id)); } };
  close.ondragstart = event => { event.preventDefault(); event.stopPropagation(); };
  close.onmousedown = event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); } };
  close.onclick = event => { event.stopPropagation(); action(() => closeTab(id)); };
  button.append(close);
  const dot = document.createElement('span'); dot.className = 'tab-state'; dot.textContent = tabState(session); button.append(dot);
  updateTab(button, id, session);
  button.onclick = () => action(() => switchTo(id));
  button.oncontextmenu = event => { event.preventDefault(); openTabContext(id, event.clientX, event.clientY); };
  button.ondragstart = event => { draggingTab = id; event.dataTransfer?.setData('text/plain', id); };
  button.ondragover = event => { if (draggingTab && draggingTab !== id) event.preventDefault(); };
  button.ondrop = event => {
    event.preventDefault();
    if (!draggingTab || draggingTab === id) return;
    workspace.reorder(draggingTab, id); draggingTab = null; status();
  };
  button.ondragend = () => { draggingTab = null; };
  return button;
}
const source = new CMView({
  parent: $('source'),
  state: CMState.create({ doc: normalize(boot.source).text, extensions: [lineNumbers(), cmMarkdown(), closeBrackets(), CMView.lineWrapping, highlightActiveLine(), syntaxHighlighting(classHighlighter), indentUnit.of('  '), theme.of([]), mode.of([CMState.readOnly.of(false), CMView.editable.of(true)]),
    // S-36：多光标。Ctrl+点击增删光标、Alt+拖动列选择由 CodeMirror 原生处理，这里开启多选与选区绘制。
    CMState.allowMultipleSelections.of(true), drawSelection(), rectangularSelection(), crosshairCursor(), CMState.transactionFilter.of(tr => tr.docChanged && (!workspace.active || workspace.active.readOnly) && !mirror ? [] : tr), CMView.domEventHandlers({
    paste: (event) => {
      const files = imageFiles(event.clipboardData); if (files.length) { action(() => insertImageFiles(files)); return true; }
      // S-40：源码栏粘到 base64 data URL 时同样转存为资源文件。
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (dataUrlImage.test(text.trim())) { action(async () => { if (!await insertDataUrlImage(workspace.active, text)) throw new Error('图片数据无法解析。'); }); return true; }
      return false;
    },
    drop: (event) => {
      const files = imageFiles(event.dataTransfer); if (!files.length) return false;
      const at = source.posAtCoords({ x: event.clientX, y: event.clientY });
      action(() => insertImageFiles(files, at === null ? undefined : { source: at })); return true;
    },
  }), CMView.inputHandler.of((view, from, to, text) => {
    if (text !== '*' || from === 0 || from !== to || !workspace.active || workspace.active.readOnly) return false;
    if (view.state.doc.sliceString(from - 1, from) !== '*' || (from > 1 && view.state.doc.sliceString(from - 2, from - 1) === '*')) return false;
    view.dispatch({ changes: { from, to, insert: '***' }, selection: { anchor: from + 1 }, userEvent: 'input.type' }); return true;
  }), cmKeymap.of([
    { key: 'Mod-z', run: () => { action(() => travel(false)); return true; } }, { key: 'Mod-y', run: () => { action(() => travel(true)); return true; } }, { key: 'Mod-Shift-z', run: () => { action(() => travel(true)); return true; } }, ...markdownKeymap, ...closeBracketsKeymap, indentWithTab, ...defaultKeymap,
  ]), CMView.updateListener.of(update => {
    if (mirror || !workspace.active) return;
    if (update.geometryChanged) scrollSync?.refresh();
    const doc = workspace.active;
    if (update.docChanged || update.selectionSet) doc.selection.active = 'source';
    if (update.docChanged && !doc.composition) action(() => {
      // 从视图补丁映射回原始换行；未改区间不经过 CodeMirror 规范化。
      let raw = doc.source;
      const edits: Patch[] = [];
      const offsets = normalize(raw).offsets;
      update.changes.iterChanges((from, to, _a, _b, inserted) => edits.push({ from: offsets[from], to: offsets[to], insert: inserted.toString().replace(/\n/g, raw.includes('\r\n') ? '\r\n' : '\n') }));
      for (const edit of edits.reverse()) raw = raw.slice(0, edit.from) + edit.insert + raw.slice(edit.to);
      const before = update.startState.selection.main;
      doc.selection = { ...doc.selection, source: { from: offsets[before.from], to: offsets[before.to] }, active: 'source' };
      const nextOffsets = normalize(raw).offsets, cm = source.state.selection.main;
      const after = { ...selection(), source: { from: nextOffsets[cm.from], to: nextOffsets[cm.to] }, active: 'source' as const };
      const from = Math.min(...edits.map(edit => edit.from)), to = Math.max(...edits.map(edit => edit.to));
      const delta = edits.reduce((size, edit) => size + edit.insert.length - (edit.to - edit.from), 0);
      const edit = { from, to, insert: raw.slice(from, to + delta) };
      if (sourceBytes(raw) >= previewLimit) doc.liteCommit(doc.ticket('source'), edit, after); else doc.commit(doc.ticket('source'), edit, after);
      schedulePreview(); status();
    });
    else if (!doc.composition && update.selectionSet) { doc.selection = selection(); status(); }
  })] }),
});

function insertHardBreak(state: EditorState, dispatch?: (transaction: Transaction) => void) {
  const marks = (state.storedMarks ?? state.selection.$from.marks()).filter(mark => mark.type !== schema.marks.code);
  // 换行本身无行内格式；下一笔输入延续原格式，避免 Markdown 序列化移动格式边界。
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create(), false).setStoredMarks(marks).scrollIntoView());
  return true;
}
const plugins = [keymap({
  'Mod-z': () => { action(() => travel(false)); return true; }, 'Mod-y': () => { action(() => travel(true)); return true; }, 'Mod-Shift-z': () => { action(() => travel(true)); return true; },
  Enter: () => { action(enterActive); return true; },
  'Shift-Enter': insertHardBreak,
  'Mod-b': () => { action(() => markActive(schema.marks.strong)); return true; },
  'Mod-u': () => { action(() => markActive(schema.marks.underline)); return true; },
  'Mod-i': () => { action(() => markActive(schema.marks.em)); return true; },
  'Mod-k': () => { action(openLinkDialog); return true; },
  Tab: () => { let handled = false; action(() => { handled = tabActive(1); }); return handled; },
  'Shift-Tab': () => { let handled = false; action(() => { handled = tabActive(-1); }); return handled; },
}), keymap(baseKeymap), searchPlugin, paperPagination()];
const inlineOptions = {
  docId: () => workspace.activeId,
  readOnly: () => !workspace.active || workspace.active.readOnly || !previewTicket || !workspace.accept(previewTicket),
  write: (pos: number, raw: string, final = false) => {
    const doc = workspace.active; requirePreview();
    const node = render.state.doc.nodeAt(pos);
    let edit: Patch;
    if (node?.type.name === 'raw_inline') {
      const atom = doc.model.atoms.find(atom => atom.kind === 'html' && atom.pos === pos);
      if (!atom) throw new Error('内联 HTML 位置已变化。');
      edit = { from: atom.from, to: atom.to, insert: raw };
    } else {
      const block = doc.model.blocks.find(block => block.pos === pos && block.type === 'opaque');
      if (!block) throw new Error('编辑块位置已变化。');
      edit = { from: block.from, to: block.to, insert: raw };
    }
    const next = parse(doc.source.slice(0, edit.from) + edit.insert + doc.source.slice(edit.to), doc.model, edit);
    if (!final && next.doc.nodeAt(pos)?.type !== node?.type) return false;
    doc.commit(doc.ticket('inline'), edit, undefined, next);
    mirrorSource(); applyPreview(doc.ticket('inline')); status();
    return true;
  },
  fail: error,
  history: (redo: boolean) => action(() => { const doc = workspace.active; if (redo) doc.redo(); else doc.undo(); mirrorSource(); applyPreview(doc.ticket('history')); status(); }),
  after: (pos: number) => action(() => insertFollowingParagraph(pos)),
  remove: (pos: number) => action(() => {
    const doc = workspace.active; flushInline(doc); requirePreview();
    const block = doc.model.blocks.find(block => block.pos === pos && block.type === 'opaque');
    if (!block) throw new Error('源码块位置已变化，请重新选择。');
    structural(deleteBlock(doc.model,block.id));
  }),
  copy: async (text: string) => { await navigator.clipboard.writeText(text); $('status-text').textContent='已复制全部代码'; },
  composing: (active: boolean) => { if (workspace.active) { workspace.active.composition = active ? 'render' : null; status(); } },
  finished: () => { const changed = !!workspace.pendingSwitch || pendingMode; if (pendingMode) workspace.active.readOnly = !workspace.active.readOnly; pendingMode = false; queuedRefresh = false; workspace.compositionEnded(); if (changed) showDocument(); else status(); },
};
// S-5：front matter 的 title 用于导出默认文件名与窗口标题；不改变文件绑定。
function metadataTitle(doc = workspace.active): string | null {
  const block = doc?.model.blocks.find(item => item.type === 'front_matter');
  const fields = (block?.node.attrs.fields ?? []) as { key: string; value: string }[];
  const title = fields.find(field => field.key.toLowerCase() === 'title')?.value.trim();
  return title || null;
}
function documentTitle(doc = workspace.active): string {
  if (!doc) return 'MDRE';
  return metadataTitle(doc) ?? doc.title.replace(/\.(md|markdown|txt)$/i, '');
}
// S-44：跳转到行，把源码栏光标定位到该行并滚动到可见位置。
function openGotoDialog() {
  const doc = workspace.active;
  const dialog = $<HTMLDialogElement>('goto-dialog');
  const input = $<HTMLInputElement>('goto-line-input');
  input.value = String(source.state.doc.lineAt(source.state.selection.main.head).number);
  $('goto-hint').textContent = `共 ${source.state.doc.lines} 行`;
  const jump = () => action(() => {
    const line = Math.max(1, Math.min(source.state.doc.lines, Number(input.value) || 1));
    const target = source.state.doc.line(line);
    doc.selection = { ...doc.selection, source: { from: doc.viewToSource(target.from), to: doc.viewToSource(target.to) }, active: 'source' };
    source.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    source.focus();
    closeFloating(dialog);
    status();
  });
  $('goto-confirm').onclick = jump;
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } };
  openFloating(dialog);
  input.focus();
  input.select();
}
$('goto-cancel').onclick = () => closeFloating($('goto-dialog'));
$('shortcut-cancel').onclick = () => closeFloating($('shortcut-dialog'));
const atomOptions = {
  readOnly: () => !workspace.active || workspace.active.readOnly || !previewTicket || !workspace.accept(previewTicket),
  model: () => workspace.active.model,
  fail: error,
};
const render = new EditorView($('render'), {
  state: EditorState.create({ doc: boot.model.doc, plugins }),
  editable: () => !!workspace.active && !workspace.active.readOnly && previewTicket !== null && workspace.accept(previewTicket),
  dispatchTransaction(tr) {
    const doc = workspace.active; if (!doc) return;
    if (!tr.docChanged) { render.updateState(render.state.apply(tr)); if (!doc.composition && tr.selectionSet) { if (!doc.readOnly) doc.selection.active = 'render'; doc.selection = selection(); refreshImageHandle(); } return; }
    if (doc.composition === 'render' || render.composing) { if (!doc.readOnly) render.updateState(render.state.apply(tr)); return; }
    action(() => { try {
      if (!previewTicket || !workspace.accept(previewTicket)) throw new Error('预览版本已过期，请刷新后编辑。');
      const before = render.state.selection;
      const origin = commandOrigin ?? 'render';
      doc.selection = commandSelection ?? { ...selection(), render: { from: before.from, to: before.to }, active: origin };
      const result = renderedEdit(doc.model, tr.doc);
      const after = projectSelection(result.model, { ...selection(), render: { from: tr.selection.from, to: tr.selection.to }, active: 'render' }); after.active = origin;
      doc.commit(doc.ticket('render'), result.edit, after, result.model);
      previewTicket = doc.ticket('render');
      render.updateState(render.state.apply(tr)); mirrorSource(); applyPreview(doc.ticket('parse')); status();
    } catch (reason) { render.updateState(render.state); throw reason; } });
  },
  handlePaste(view, event) {
    const files = imageFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); action(() => insertImageFiles(files)); return true; }
    // S-40：粘贴 base64 图片同样转存为文件，不把长 data URL 写进正文。
    const raw = event.clipboardData?.getData('text/plain') ?? '';
    if (dataUrlImage.test(raw.trim())) { event.preventDefault(); action(async () => { if (!await insertDataUrlImage(workspace.active, raw)) throw new Error('图片数据无法解析。'); }); return true; }
    event.preventDefault(); action(() => {
      if (workspace.active.readOnly) return;
      const text = event.clipboardData!.getData('text/plain').replace(/\r\n|\r/g, '\n');
      if (!text.includes('\n')) view.dispatch(view.state.tr.insertText(text));
      else if (cellAt(view.state)) { const nodes: PMNode[] = []; text.split('\n').forEach((line, index) => { if (index) nodes.push(schema.nodes.hard_break.create()); if (line) nodes.push(schema.text(line)); }); view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0))); }
      else { const paragraphs = text.split(/\n+/).map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : null)); view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1))); }
    }); return true;
  },
  handleDrop(view, event) {
    const files = imageFiles((event as DragEvent).dataTransfer);
    if (!files.length) return true;
    const target = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
    action(() => insertImageFiles(files, target ? { render: target.pos } : undefined));
    return true;
  },
  clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, '\n'),
  handleDOMEvents: { copy(_view, event) { const e = event as ClipboardEvent; if (!e.clipboardData) return false; e.clipboardData.setData('text/plain', window.getSelection()?.toString() ?? ''); e.preventDefault(); return true; } },
  nodeViews: {
    list_item(node) {
      const dom = document.createElement('li'), contentDOM = document.createElement('div');
      dom.dataset.block = node.attrs.id;
      dom.dataset.item = node.attrs.id;
      if (node.attrs.checked !== null) {
        dom.className = 'task-item';
        const button = document.createElement('button'); button.className = 'task-toggle'; button.textContent = node.attrs.checked ? '✓' : ' '; button.setAttribute('aria-label', `任务 ${node.textContent}`);
        button.disabled = workspace.active.readOnly;
        button.onclick = () => action(() => { requirePreview(); structural(toggleTask(workspace.active.model, node.attrs.id), undefined, 'render'); }); dom.append(button);
      }
      dom.append(contentDOM); return { dom, contentDOM };
    },
    opaque(node, view, getPos) {
      if (node.attrs.kind !== 'mermaid') return inlineEditor(node, view, getPos, inlineOptions);
      const doc = workspace.active;
      return diagramView(node, { readOnly: () => doc.readOnly, edit: () => action(() => { requirePreview(); openDraft(node.attrs.id); }), remove: () => { const pos = getPos(); if (typeof pos === 'number') inlineOptions.remove(pos); }, select: () => { const pos = getPos(); if (typeof pos === 'number') { render.dispatch(render.state.tr.setSelection(NodeSelection.create(render.state.doc, pos))); render.focus(); } } }, ms => { if (workspace.active === doc && !doc.welcome && !doc.modelStale && doc.renderRevision === doc.revision) { doc.renderMs += ms; renderTiming(doc); } });
    },
    raw_inline(node, view, getPos) { return inlineEditor(node, view, getPos, inlineOptions); },
    math_inline: (node, view, getPos) => mathInlineView(node, view, getPos, atomOptions),
    math_block: (node, view, getPos) => mathBlockView(node, view, getPos, atomOptions),
    footnote_ref: (node, view, getPos) => footnoteRefView(node, view, getPos, atomOptions),
    footnote_defs: (node, view, getPos) => footnoteDefsView(node, view, getPos, atomOptions),
    toc_block: (node, view, getPos) => tocView(node, view, getPos, atomOptions),
    front_matter: (node, view, getPos) => frontMatterView(node, view, getPos, atomOptions),
    image(node, _view, getPos) {
      const dom = document.createElement('img');
      dom.alt = node.attrs.alt; dom.dataset.src = node.attrs.src;
      if (node.attrs.title) dom.title = node.attrs.title;
      applyImageSize(dom, node.attrs.width as number | null);
      applyImageSource(dom, node.attrs.src);
      dom.addEventListener('mousedown', event => {
        event.preventDefault();
        action(() => { const at = getPos(); if (typeof at === 'number' && !workspace.active.readOnly) selectImageAt(at); });
      });
      dom.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); action(() => viewImage(dom)); });
      return { dom, stopEvent: event => ['mousedown', 'click', 'dblclick'].includes(event.type) };
    },
    table_cell(node) {
      const dom = document.createElement(node.attrs.header ? 'th' : 'td');
      dom.dataset.block = node.attrs.id; dom.dataset.cell = node.attrs.id;
      if (node.attrs.align) dom.style.textAlign = String(node.attrs.align);
      const contentDOM = document.createElement('div'); contentDOM.className = 'cell-content'; dom.append(contentDOM);
      return { dom, contentDOM };
    },
  },
});

function mirrorSource() {
  mirror = true;
  const doc = workspace.active, normalized = normalize(doc.source);
  const locate = (offset: number) => viewOffset(doc.model, offset);
  source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: normalized.text }, selection: { anchor: locate(doc.selection.source.from), head: locate(doc.selection.source.to) }, effects: mode.reconfigure([CMState.readOnly.of(doc.readOnly), CMView.editable.of(!doc.readOnly)]) });
  mirror = false;
}
function applyPreview(ticket: Ticket) {
  if (!workspace.accept(ticket)) return;
  if (workspace.active.composition) { queuedRefresh = true; return; }
  const doc = workspace.active;
  const started = performance.now();
  refreshHandle();
  const storedMarks = previewTicket?.docId === doc.id && doc.selection.active === 'render' ? render.state.storedMarks : null;
  const from = Math.max(1, Math.min(doc.selection.render.from, doc.model.doc.content.size - 1)), to = Math.max(1, Math.min(doc.selection.render.to, doc.model.doc.content.size - 1));
  const state = EditorState.create({ doc: doc.model.doc, plugins });
  const sel = TextSelection.between(state.doc.resolve(from), state.doc.resolve(to));
  const transaction = state.tr.setSelection(sel); if (storedMarks && sel.empty) transaction.setStoredMarks(storedMarks);
  previewTicket = ticket; render.updateState(state.apply(transaction)); doc.renderRevision = ticket.revision;
  $('render').classList.remove('stale'); $('preview-state').textContent = ''; render.setProps({ editable: () => !!workspace.active && !workspace.active.readOnly && !!previewTicket && workspace.accept(previewTicket) });
  syncHint(false);
  render.dom.querySelectorAll<HTMLButtonElement>('.task-toggle').forEach(button => button.disabled = doc.readOnly);
  render.dom.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.inline-editor input, .inline-editor textarea').forEach(input => input.readOnly = doc.readOnly);
  render.dom.querySelectorAll<HTMLSelectElement>('.inline-editor select').forEach(select => select.disabled = doc.readOnly);
  render.dom.querySelectorAll<HTMLButtonElement>('.inline-after').forEach(button => button.disabled = doc.readOnly);
  render.dom.querySelectorAll<HTMLButtonElement>('.diagram-actions button').forEach(button => { if (button.getAttribute('aria-label') === '删除 Mermaid 图') button.hidden = doc.readOnly; else button.textContent = doc.readOnly ? '查看图表源码' : '编辑图表'; });
  refreshImageHandle();
  if (!$('search-bar').hidden) updateFind();
  scrollSync?.refresh();
  doc.renderMs = performance.now() - started;
  renderTiming(doc);
  doc.parseMs = 0;
}
function renderTiming(doc: DocumentSession) {
  const hint = $('render-timing'), elapsed = doc.parseMs + doc.renderMs;
  hint.hidden = elapsed < 120;
  if (!hint.hidden) {
    const bytes = sourceBytes(doc.source);
    let math = 0, diagrams = 0;
    doc.model.doc.descendants(node => { if (node.type.name.startsWith('math_')) math++; if (node.attrs.kind === 'mermaid') diagrams++; });
    hint.textContent = `渲染 ${Math.round(elapsed)} ms`;
    hint.title = `解析 ${Math.round(doc.parseMs)} ms，视图 ${Math.round(doc.renderMs)} ms；文档 ${Math.ceil(bytes / 1024)} KB${math ? `，${math} 个公式` : ''}${diagrams ? `，${diagrams} 个 Mermaid 图` : ''}`;
  }
}
// 5.1.5 / 2.1：≥ 1 MB 的文档不再自动跟随源码刷新，改为手动刷新；模型与映射完整保留。
export const previewLimit = 1024 * 1024;
// UTF-8 字节数同样按源码字符串记忆化：大文档下每次按键会检查多次。
let byteCache: { source: string; bytes: number } | null = null;
export function sourceBytes(source: string) {
  if (byteCache && byteCache.source === source) return byteCache.bytes;
  const bytes = new TextEncoder().encode(source).length;
  byteCache = { source, bytes };
  return bytes;
}
function schedulePreview(delay = 150, force = false) {
  if (parseTimer) clearTimeout(parseTimer);
  syncHint(true);
  render.dom.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.inline-editor input, .inline-editor textarea').forEach(input => input.readOnly = true);
  const ticket = workspace.active.ticket('parse');
  if (!force && sourceBytes(workspace.active.source) >= previewLimit) {
    previewTicket = null; render.setProps({ editable: () => false });
    $('render').classList.add('stale'); $('preview-state').textContent = '· 文档较大，预览未自动刷新（点刷新渲染）';
    $('render-timing').hidden = false; $('render-timing').textContent = '大文档 · 手动刷新'; $('render-timing').title = '文档达到 1 MB，自动预览暂停以保证输入响应；点击“刷新渲染”更新。';
    return;
  }
  previewTicket = null; render.setProps({ editable: () => false }); $('render').classList.add('stale'); $('preview-state').textContent = '· 等待当前版本';
  workspace.active.refreshModel();
  parseTimer = setTimeout(() => applyPreview(ticket), delay);
}
function showDocument() {
  const doc = workspace.active;
  $('welcome').hidden = !!doc && !doc.welcome; $('panes').hidden = false;
  $('panes').classList.toggle('welcome-state', !doc || doc.welcome);
  if (!doc || doc.welcome) { $('outline-list').replaceChildren(); $('outline-count').textContent = ''; $('outline-empty').hidden = false; }
  if (!doc || doc.welcome) { previewTicket = null; if (parseTimer) clearTimeout(parseTimer); pendingMode = false; hideHandle(); $('cell-menu').hidden = true; $('search-bar').hidden = true; $('format-toolbar').hidden = false; $('image-handle').hidden = true; render.setProps({ editable: () => false }); mirror = true; source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: '' }, effects: mode.reconfigure([CMState.readOnly.of(true), CMView.editable.of(false)]) }); mirror = false; status(); return; }
  hideHandle(); $('cell-menu').hidden = true;
  $('panes').classList.toggle('read-only', doc.readOnly); applySourceVisibility();
  $('format-toolbar').hidden = doc.readOnly; $('replace-controls').hidden = doc.readOnly;
  $('render-title').textContent = '渲染页面';
  mirrorSource(); if (doc.modelStale) schedulePreview(); else applyPreview(doc.ticket('parse')); restoreSelections(); restoreView(doc, render, source); status(); scrollSync?.reset();
  // 从隐藏源码栏恢复后，等 CodeMirror 完成实际行高测量，再按渲染锚点同步。
  source.requestMeasure({ read: () => doc.ticket('layout'), write: ticket => { if (workspace.accept(ticket)) scrollSync?.reset(); } });
}
// 源码栏可见性不改变文档、阅读模式或撤销历史。
function applySourceVisibility() {
  const doc = workspace.active, hidden = !sourceVisible || !!doc?.readOnly;
  $('panes').classList.toggle('source-hidden', hidden);
  $('source-pane').hidden = hidden; $('divider').hidden = hidden;
  const button = $('source-toggle'), label = hidden ? '显示源码' : '隐藏源码';
  button.setAttribute('aria-label',label); button.dataset.tooltip=label;
  button.setAttribute('aria-pressed',String(!hidden));
  if (hidden && doc && !doc.readOnly) doc.selection.active='render';
}
function toggleSourceVisibility(next = !sourceVisible) {
  const doc = workspace.active;
  if (doc?.composition) throw new Error('请先完成当前输入，再切换源码栏。');
  if (doc) { flushInline(doc); captureView(doc,render,source); }
  sourceVisible=next; applySourceVisibility();
  // 欢迎页也可修改默认布局，下一次新建文档会立即采用新设置。
  if (!doc) return;
  restoreSelections(); restoreView(doc,render,source);
  source.requestMeasure({read:()=>doc.ticket('layout'),write:ticket=>{if(workspace.accept(ticket))scrollSync?.reset();}});
  scrollSync?.reset();
}
function flushInline(doc = workspace.active) { if (doc && workspace.activeId === doc.id && !doc.composition && document.activeElement?.closest('.inline-editor')) (document.activeElement as HTMLElement).blur(); }
// S-46：反向同步进行中在状态栏给出轻量指示，不打断输入、不弹窗。
function syncHint(active: boolean) {
  const element = $('sync-hint');
  if (!element) return;
  element.hidden = !active;
  element.textContent = active ? '同步中…' : '';
}
function switchTo(id: string) { flushInline(); if (workspace.active && !workspace.active.welcome) captureView(workspace.active, render, source); if (workspace.switchTo(id)) showDocument(); else status(); }
let draggingTab: string | null = null, autosaveTimer: ReturnType<typeof setInterval> | undefined, allowClose = false, closing = false;
const pendingChoices = new Map<string, Promise<string>>();
// 确认类弹窗用非模态 show()：标题栏关闭按钮与 Esc 始终可用，不会把窗口锁死。
function openFloating(dialog: HTMLDialogElement) { $('scrim').hidden = false; if (!dialog.open) positionDialog(dialog); }
function closeFloating(dialog: HTMLDialogElement) {
  if (dialog.open) dialog.close();
  if (!document.querySelector('dialog[open]')) $('scrim').hidden = true;
}
let imageRotation = 0;
function fitLargeImage() {
  const image = $<HTMLImageElement>('image-large'), stage = $('image-view-stage');
  const sideways = Math.abs(imageRotation % 180) === 90;
  image.style.maxWidth = `${Math.max(1, (sideways ? stage.clientHeight : stage.clientWidth) - 24)}px`;
  image.style.maxHeight = `${Math.max(1, (sideways ? stage.clientWidth : stage.clientHeight) - 24)}px`;
  image.style.transform = `rotate(${imageRotation}deg)`;
}
function viewImage(original: HTMLImageElement) {
  if (!original.complete || !original.naturalWidth) throw new Error('图片尚未加载或资源缺失，无法查看大图。');
  $('image-preview').hidden = true;
  const image = $<HTMLImageElement>('image-large'); imageRotation = 0;
  image.src = original.currentSrc || original.src; image.alt = original.alt;
  $('image-title').textContent = original.alt || '图片查看';
  openFloating($('image-dialog')); fitLargeImage();
}
$('image-close').onclick = () => { closeFloating($('image-dialog')); $<HTMLImageElement>('image-large').removeAttribute('src'); };
$('image-rotate-left').onclick = () => { imageRotation -= 90; fitLargeImage(); };
$('image-rotate-right').onclick = () => { imageRotation += 90; fitLargeImage(); };
new ResizeObserver(fitLargeImage).observe($('image-view-stage'));
function choose<T extends string>(dialogId: string, buttons: [string, T][], onCancel: T, text?: string): Promise<T> {
  const existing = pendingChoices.get(dialogId);
  if (existing) return existing as Promise<T>;
  const promise = new Promise<T>(resolve => {
    const dialog = $<HTMLDialogElement>(dialogId);
    if (text !== undefined) { const paragraph = dialog.querySelector('p'); if (paragraph) paragraph.textContent = text; }
    const finish = (choice: T) => { closeFloating(dialog); pendingChoices.delete(dialogId); resolve(choice); };
    for (const [id, choice] of buttons) $<HTMLButtonElement>(id).onclick = () => finish(choice);
    dialog.oncancel = () => finish(onCancel);
    openFloating(dialog);
  });
  pendingChoices.set(dialogId, promise as Promise<string>);
  return promise;
}
const unsavedChoice = (doc: DocumentSession) => choose<'save' | 'discard' | 'cancel'>('close-dialog',
  [['close-save', 'save'], ['close-discard', 'discard'], ['close-cancel', 'cancel']], 'cancel',
  doc.path ? `《${doc.title}》有未保存的修改。` : `《${doc.title}》尚未保存为文件。`);
const conflictChoice = (doc: DocumentSession) => choose<'save-as' | 'reload' | 'cancel'>('conflict-dialog',
  [['conflict-save-as', 'save-as'], ['conflict-reload', 'reload'], ['conflict-cancel', 'cancel']], 'cancel',
  `${doc.saveError}：${doc.path ?? ''}`);
const missingChoice = (missing: string[]) => choose<'proceed' | 'cancel'>('missing-dialog',
  [['missing-proceed', 'proceed'], ['missing-cancel', 'cancel']], 'cancel',
  `有 ${missing.length} 张被引用图片缺失或不可读：\n${missing.join('\n')}\n是否继续保存（引用会保留）？`);
// E-6：非 UTF-8 文件按探测编码打开，保存默认沿用；转换为 UTF-8 需用户显式选择。
async function askEncoding(doc: DocumentSession, encoding: string) {
  const choice = await choose<'keep' | 'convert'>('encoding-dialog', [['encoding-keep', 'keep'], ['encoding-convert', 'convert']], 'keep',
    `文件按 ${encoding.toUpperCase()} 解码打开；保存默认沿用该编码。`);
  if (choice === 'convert') { doc.encoding = 'utf-8'; doc.bom = doc.source.startsWith('\uFEFF'); }
}
// E.1/E-2：同一规范化路径重复打开时激活既有文档，不产生第二个标签。
async function openPath(path: string, restoring = false): Promise<DocumentSession> {
  const existing = [...workspace.documents.values()].find(doc => samePath(doc.path, path));
  if (existing) { switchTo(existing.id); if (!restoring) await updateRecent(existing.path); return existing; }
  const file = await readTextFile(path);
  const doc = new DocumentSession(crypto.randomUUID(), file.text, {
    title: path.replace(/^.*[\\/]/, ''), path: file.path, encoding: file.encoding, bom: file.bom,
    diskFingerprint: file.fingerprint, savedText: file.text,
  });
  workspace.add(doc); switchTo(doc.id);
  if (restoring) doc.readOnly = settings().default_mode === 'read';
  else await updateRecent(file.path);
  if (!restoring && file.encoding !== 'utf-8') await askEncoding(doc, file.encoding);
  status();
  return doc;
}
async function openViaPicker() { const picked = await pickFile(false); if (picked) await openPath(picked); }
// D-18：新建标签只是空白页，不绑定任何文件；继承默认启动模式。
// 空白文档按序号命名（未命名.md、未命名 2.md…），避免多标签标题完全一样而无法区分。
function untitledTitle(): string {
  const used = new Set([...workspace.documents.values()].map(item => item.title));
  if (!used.has('未命名.md')) return '未命名.md';
  for (let index = 2; index < 1000; index++) {
    const candidate = `未命名 ${index}.md`;
    if (!used.has(candidate)) return candidate;
  }
  return `未命名 ${Date.now()}.md`;
}
function newBlankTab(): DocumentSession {
  if (workspace.active?.welcome) {
    const doc = workspace.active; doc.welcome = false; doc.title = untitledTitle(); doc.readOnly = settings().default_mode === 'read'; switchTo(doc.id); return doc;
  }
  const doc = new DocumentSession(crypto.randomUUID(), '', { title: untitledTitle() });
  doc.readOnly = settings().default_mode === 'read';
  workspace.add(doc); switchTo(doc.id);
  return doc;
}
async function reloadFromDisk(doc: DocumentSession) {
  if (!doc.path) throw new Error('当前文档没有文件路径。');
  const file = await readTextFile(doc.path);
  doc.reloadFrom(doc.source === file.text ? doc.source : file.text, file.fingerprint, file.encoding);
  showDocument();
}
// E-1/E.1：保存前先迁移资源；冲突时保留当前内容并给出另存为/重新加载选择。
async function saveDocument(doc: DocumentSession, as: boolean, explicitPath?: string): Promise<boolean> {
  flushInline(doc);
  if (doc.composition) throw new Error('请先提交组合输入再保存。');
  const target = explicitPath ?? (as || !doc.path ? await pickFile(true, doc.path ?? doc.title) : doc.path);
  if (!target) return false;
  if ([...workspace.documents.values()].some(other => other.id !== doc.id && samePath(other.path, target))) throw new Error('目标文件已在其他标签打开，请先关闭该标签或选择其他文件名。');
  try {
    await saveQueue.save(doc, { path: target, overwrite: as || !doc.path, choice: { onMissingResources: async missing => (await missingChoice(missing)) === 'proceed' } });
    status();
    return true;
  } catch (failure) {
    if (doc.saveStatus === 'conflict') {
      const choice = await conflictChoice(doc);
      if (choice === 'save-as') return saveDocument(doc, true);
      if (choice === 'reload') { await reloadFromDisk(doc); return false; }
      return false;
    }
    throw failure;
  }
}
// 供验收与脚本调用：直接保存到指定路径 / 立即执行一次自动保存扫描。
async function saveTo(path: string): Promise<boolean> { return saveDocument(workspace.active, false, path); }
async function autosaveNow(): Promise<void> { await autosaveAll(workspace, saveQueue, () => status()); }
// G-1/G-2：大纲面板按标题层级生成，点击跳转两栏，跟随光标高亮当前章节。
function updateOutline() {
  const panel = $('outline-panel');
  if (panel.hidden || !workspace.active) return;
  const doc = workspace.active, entries = outlineEntries(doc.model);
  outlineActive = currentOutline(entries, doc.selection.source.from);
  renderOutline($('outline-list'), entries, outlineActive, jumpToOutline);
  $('outline-count').textContent = entries.length ? String(entries.length) : '';
  $('outline-empty').hidden = entries.length > 0;
  $('outline-list').hidden = entries.length === 0;
}
function markOutline() {
  const panel = $('outline-panel');
  if (panel.hidden || !workspace.active) return;
  const doc = workspace.active, active = currentOutline(outlineEntries(doc.model), doc.selection.source.from);
  if (active === outlineActive) return;
  outlineActive = active;
  for (const button of $('outline-list').querySelectorAll<HTMLElement>('[data-outline]')) {
    button.classList.toggle('active', button.dataset.outline === active);
    if (button.dataset.outline === active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
}
function jumpToOutline(entry: OutlineEntry) {
  const doc = workspace.active, block = doc.model.blocks.find(candidate => candidate.id === entry.id);
  if (!block) return;
  const at = viewOffset(doc.model, block.from);
  const ready = !!previewTicket && workspace.accept(previewTicket);
  const selection = ready ? TextSelection.near(render.state.doc.resolve(Math.min(block.pos + 1, render.state.doc.content.size))) : null;
  if (doc.readOnly || !sourceVisible) {
    // 阅读或隐藏源码时，大纲导航的焦点落在富文本栏。
    if (selection) render.dispatch(render.state.tr.setSelection(selection)); else render.focus();
  } else {
    source.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    if (selection) render.dispatch(render.state.tr.setSelection(selection));
    source.focus();
  }
  // 视图同步会按旧选区回写 doc.selection，因此跳转的目标位置最后写入。
  doc.selection = { source: { from: block.from, to: block.from }, render: selection ? { from: selection.from, to: selection.to } : doc.selection.render, active: doc.readOnly || !sourceVisible ? 'render' : 'source' };
  const element = render.dom.querySelector<HTMLElement>(`[data-block="${entry.id}"]`), pane = $('render');
  if (element) {
    const paneRect = pane.getBoundingClientRect(), elementRect = element.getBoundingClientRect();
    pane.scrollTop += elementRect.top - paneRect.top - 6;
  }
  scrollSync?.reset();
  outlineActive = null; markOutline();
}
function toggleOutline(force?: boolean) {
  const panel = $('outline-panel');
  panel.hidden = force ?? !panel.hidden;
  $('panes').classList.toggle('has-outline', !panel.hidden);
  $('outline-toggle').setAttribute('aria-pressed', String(!panel.hidden));
  const label = panel.hidden ? '展开侧栏' : '收起侧栏';
  $('outline-toggle').setAttribute('aria-label', label); $('outline-toggle').dataset.tooltip = label;
  void rememberWorkspace().catch(reason => error(reason));
  if (!panel.hidden) updateOutline();
}// A-10/D-17/D-18：关闭标签前询问；关掉最后一个标签返回零文档欢迎页。
async function closeTab(id: string) {
  const doc = workspace.documents.get(id);
  if (!doc) return;
  if (doc.composition || workspace.active?.composition) throw new Error('请先提交组合输入，再关闭标签。');
  flushInline(doc);
  if (workspace.activeId !== id) switchTo(id);
  captureView(doc, render, source);
  if (doc.dirty || (!doc.path && !!doc.source)) {
    const choice = await unsavedChoice(doc);
    if (choice === 'cancel') return;
    if (choice === 'save') { if (!(await saveDocument(doc, !doc.path))) return; }
    else { doc.discarded = true; if (isTauri()) await discardRecovery(doc.id).catch(() => {}); }
  }
  const order = [...workspace.documents.keys()], index = order.indexOf(id);
  const next = order[index + 1] ?? order[index - 1] ?? null;
  workspace.remove(id, next);
  // 无未保存内容就关闭时也要清掉恢复快照，否则下次启动会凭旧快照把这份文件“复活”。
  if (!doc.discarded && !doc.dirty) { doc.discarded = true; if (isTauri()) await discardRecovery(doc.id).catch(() => {}); }
  if (workspace.active && !workspace.active.welcome && !workspace.active.path && !workspace.active.source) workspace.active.readOnly = settings().default_mode === 'read';
  showDocument();
}
function cycleTab(direction: -1 | 1) {
  const order = [...workspace.documents.keys()]; if (!order.length) return;
  const index = order.indexOf(workspace.activeId);
  switchTo(order[(index + direction + order.length) % order.length]);
}
// E-4：窗口关闭前逐一对未保存文档询问；取消不关闭，确认后放行系统关闭。
async function shutdown() {
  recovery.stop();
  if (autosaveTimer) clearInterval(autosaveTimer);
  await saveQueue.flush().catch(() => {});
}
async function finishClose() {
  await shutdown();
  allowClose = true;
  const appWindow = getCurrentWindow();
  try { await appWindow.close(); }
  catch (reason) { error(reason); await appWindow.destroy().catch(closeError => error(closeError)); }
}
async function closeWindow() {
  if (closing) return;
  if ([...workspace.documents.values()].some(doc => doc.composition)) throw new Error('请先提交组合输入，再关闭窗口。');
  flushInline();
  const activeBeforeClose = workspace.activeId;
  closing = true;
  try {
    for (const doc of [...workspace.documents.values()]) {
      if (!doc.dirty && (doc.path || !doc.source)) continue;
      if (workspace.activeId !== doc.id) switchTo(doc.id);
      const choice = await unsavedChoice(doc);
      if (choice === 'cancel') { $('error').textContent = '已取消关闭，窗口保持打开。'; return; }
      if (choice === 'save') {
        if (!(await saveDocument(doc, !doc.path))) { $('error').textContent = '保存未完成（可能取消了另存为），窗口保持打开。'; return; }
      } else { doc.discarded = true; if (isTauri()) await discardRecovery(doc.id).catch(() => {}); }
    }
    if (workspace.documents.has(activeBeforeClose)) switchTo(activeBeforeClose);
    await rememberWorkspace(true);
    await finishClose();
  } finally { closing = false; }
}
function switchMode(readOnly = !workspace.active?.readOnly) {
  if (!workspace.active) return;
  if (readOnly === workspace.active.readOnly) return;
  if (workspace.active.composition) { pendingMode = !pendingMode; status(); return; }
  flushInline();
  if ($<HTMLDialogElement>('dialog').open) throw new Error('请先确认或取消当前源码草稿，再切换模式；草稿未丢弃。');
  if (document.querySelector<HTMLDialogElement>('#link-dialog[open], #code-dialog[open], #table-dialog[open], #math-dialog[open]')) throw new Error('请先确认或取消当前弹窗，再切换模式。');
  const doc = workspace.active; captureView(doc, render, source); doc.readOnly = readOnly; showDocument();
}
function restoreSelections() {
  const doc = workspace.active, offsets = normalize(doc.source).offsets;
  const locate = (offset: number) => { const index = offsets.findIndex(value => value >= offset); return index < 0 ? offsets.length - 1 : index; };
  mirror = true; source.dispatch({ selection: { anchor: locate(doc.selection.source.from), head: locate(doc.selection.source.to) } }); mirror = false;
  if (!doc.readOnly && sourceVisible && doc.selection.active === 'source') source.focus(); else render.focus();
}
function travel(redo: boolean) { if (workspace.active.composition) throw new Error('请先提交组合输入。'); if (redo) workspace.active.redo(); else workspace.active.undo(); showDocument(); }
function requirePreview() { if (!previewTicket || !workspace.accept(previewTicket)) throw new Error('预览版本已过期，请刷新后编辑。'); }
let commandOrigin: 'source' | 'render' | null = null;
let commandSelection: Selection | null = null;
let formatDraft: { kind: string; ticket: Ticket; selection: Selection } | null = null;
function captureFormat(kind: string) { formatDraft = { kind, ticket: workspace.active.ticket('format-dialog'), selection: structuredClone(selection()) }; }
function restoreFormat(kind: string) {
  if (!formatDraft || formatDraft.kind !== kind || !workspace.accept(formatDraft.ticket)) throw new Error('文档版本或标签已变化，请取消弹窗并重新选择；填写内容仍保留。');
  workspace.active.selection = structuredClone(formatDraft.selection);
  const range = formatDraft.selection.render;
  render.updateState(render.state.apply(render.state.tr.setSelection(TextSelection.between(render.state.doc.resolve(range.from), render.state.doc.resolve(range.to)))));
  restoreSelections();
}
function activeRange() {
  const doc = workspace.active;
  if (doc.composition) throw new Error('请先提交组合输入。');
  if (doc.readOnly) throw new Error('当前为只读模式，修改未提交。');
  if (doc.selection.active === 'render') { requirePreview(); return { from: render.state.selection.from, to: render.state.selection.to }; }
  return projectSelection(doc.model, selection()).render;
}
function structural(edit: Patch, cursor?: { from: number; to: number }, origin = workspace.active.selection.active) {
  if (workspace.active.modelStale) throw new Error('文档较大：模型已过期，请先点工具栏的刷新渲染。');
  const doc = workspace.active;
  if (doc.composition) throw new Error('请先提交组合输入。');
  if (origin === 'render') requirePreview();
  doc.selection = { ...selection(), active: origin };
  const next = parse(doc.source.slice(0, edit.from) + edit.insert + doc.source.slice(edit.to), doc.model, edit);
  const range = cursor ?? mapRenderRange(doc.model, next, projectSelection(doc.model, doc.selection).render, edit);
  const after = projectSelection(next, { ...doc.selection, render: range, active: 'render' });
  after.active = origin;
  doc.commit(doc.ticket('structure'), edit, after, next); showDocument();
}
function splitActive() {
  const range = activeRange(); if (range.from !== range.to) throw new Error('请将光标放在分段位置；选中文字未删除。');
  structural(splitParagraph(workspace.active.model, range.from), { from: range.from + 2, to: range.from + 2 });
}
function joinActive() {
  const range = activeRange(), block = workspace.active.model.blocks.find(b => b.parent === null && range.from >= b.pos + 1 && range.from <= b.pos + b.node.nodeSize - 1);
  structural(joinParagraph(workspace.active.model, range.from), { from: block!.pos - 1, to: block!.pos - 1 });
}
function headingActive(level: number) { const range = activeRange(); structural(setHeading(workspace.active.model, range.from, level), range); }
function markActive(type: MarkType, attrs?: Record<string, unknown>, colorValue?: string | null) {
  const doc = workspace.active, range = activeRange(), origin = doc.selection.active;
  if (render.state.selection instanceof NodeSelection) throw new Error('请在可编辑文字内选择格式范围。');
  if (origin === 'source' && range.from === range.to) throw new Error('请先选择要套用格式的文字。');
  commandSelection = selection();
  try {
    if (origin === 'source') applyPreview(doc.ticket('format'));
    const sel = TextSelection.between(render.state.doc.resolve(range.from), render.state.doc.resolve(range.to));
    render.updateState(render.state.apply(render.state.tr.setSelection(sel)));
    commandOrigin = origin;
    if (colorValue !== undefined && (type.name === 'color' || type.name === 'bg')) render.dispatch(colorTransaction(render.state, type.name, colorValue));
    else toggleMark(type, attrs)(render.state, render.dispatch, render);
  } finally { commandOrigin = null; commandSelection = null; }
}
function boldActive() { markActive(schema.marks.strong); }
function blockAtRange(model: Model, range: { from: number; to: number }): Block | undefined {
  return model.blocks.filter(b => b.node.isTextblock && range.from >= b.pos + 1 && range.from <= b.pos + b.node.nodeSize - 1).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
}
function containerAtPos(model: Model, pos: number, type: string): Block | undefined {
  return model.blocks.filter(b => b.type === type && pos >= b.pos && pos < b.pos + b.node.nodeSize).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
}
function convertActive(kind: BlockKind, options?: { level?: number; info?: string }) {
  const doc = workspace.active, origin = doc.selection.active, range = activeRange();
  const block = blockAtRange(doc.model, range);
  if (!block) throw new Error('请把光标放在段落或标题内。');
  if (block.type === 'table_cell') throw new Error('标题与列表作用于整段；表格内可直接输入并使用行内格式。');
  structural(convertBlock(doc.model, block.id, kind, { ...options, followingParagraph: !['paragraph','heading'].includes(kind) }), range, origin);
}
function enterActive() {
  const doc = workspace.active;
  if (doc.readOnly) return;
  if (doc.selection.active === 'render') {
    requirePreview();
    const pos = render.state.selection.from;
    const cell = doc.model.blocks.filter(b => b.type === 'table_cell' && pos >= b.pos && pos < b.pos + b.node.nodeSize)[0];
    if (cell) { insertHardBreak(render.state, render.dispatch); return; }
    if (containerAtPos(doc.model, pos, 'list_item')) {
      if (splitListItem(schema.nodes.list_item)(render.state, render.dispatch) || liftListItem(schema.nodes.list_item)(render.state, render.dispatch)) return;
    }
    if (containerAtPos(doc.model, pos, 'blockquote') && !render.state.selection.$from.parent.content.size && lift(render.state, render.dispatch)) return;
    splitBlock(render.state, render.dispatch); return;
  }
  splitActive();
}
function cellAt(state: EditorState) {
  const selection = state.selection;
  if (selection instanceof NodeSelection && selection.node.type.name === 'table_cell') return { pos: selection.from, node: selection.node };
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'table_cell') return { pos: $from.before(depth), node: $from.node(depth) };
  return null;
}
function navigateCell(direction: -1 | 1) {
  const current = cellAt(render.state);
  if (!current) return;
  const positions: number[] = [];
  render.state.doc.descendants((node, pos) => { if (node.type.name === 'table_cell') positions.push(pos); });
  const next = positions[positions.indexOf(current.pos) + direction];
  if (next === undefined) return;
  requirePreview();
  render.dispatch(render.state.tr.setSelection(TextSelection.near(render.state.doc.resolve(next + 1))));
  render.focus();
}
function tabActive(direction: -1 | 1): boolean {
  const doc = workspace.active;
  if (doc.readOnly || doc.composition) return false;
  if (cellAt(render.state)) { navigateCell(direction); return true; }
  const pos = render.state.selection.from;
  if (containerAtPos(doc.model, pos, 'list_item')) { structural(indentListItem(doc.model, pos, direction), undefined, 'render'); return true; }
  if (containerAtPos(doc.model, pos, 'blockquote')) { structural(nestQuote(doc.model, pos, direction), undefined, 'render'); return true; }
  return false;
}
function openLinkDialog() {
  const doc = workspace.active;
  if (doc.readOnly) throw new Error('当前为只读模式，修改未提交。');
  const range = activeRange();
  if (range.from === range.to) throw new Error('请先选择要加链接的文字。');
  captureFormat('link');
  $('link-error').textContent = ''; $<HTMLInputElement>('link-url').value = '';
  openFloating($('link-dialog')); $<HTMLInputElement>('link-url').focus();
}
function openCodeDialog() {
  const doc = workspace.active;
  if (doc.readOnly) throw new Error('当前为只读模式，修改未提交。');
  const range = activeRange(), block = blockAtRange(doc.model, range);
  if (!block || block.parent !== null || block.type === 'table_cell') throw new Error('请把光标放在顶层段落或标题内再插入代码块。');
  captureFormat('code');
  $('code-error').textContent = ''; $<HTMLInputElement>('code-language').value = '';
  openFloating($('code-dialog')); $<HTMLInputElement>('code-language').focus();
}
function openTableDialog() {
  if (workspace.active.readOnly) throw new Error('当前为只读模式，修改未提交。');
  activeRange(); captureFormat('table');
  $('table-error').textContent = '';
  openFloating($('table-dialog')); $<HTMLInputElement>('table-rows').focus();
}
let handleBlock: Block | null = null, handleTimer: ReturnType<typeof setTimeout> | undefined, cellMenuCell: string | null = null, pointer: { x: number; y: number } | null = null;
function topLevelBlock(model: Model, id: string): Block | null {
  let block = model.blocks.find(b => b.id === id) ?? null;
  while (block && block.parent) block = model.blocks.find(b => b.id === block!.parent) ?? null;
  return block;
}
function hideHandle() { handleBlock = null; $('block-handle').hidden = true; setDropdown($('convert'), false); }
function positionHandle(block: Block, element: HTMLElement) {
  const handle = $('block-handle'), rect = element.getBoundingClientRect(), pane = $('render').getBoundingClientRect();
  handleBlock = block; handle.hidden = false;
  handle.style.left = `${Math.max(2, rect.left - handle.offsetWidth - 6)}px`;
  handle.style.top = `${Math.min(Math.max(pane.top + 2, rect.top), Math.max(pane.top + 2, pane.bottom - handle.offsetHeight - 2))}px`;
  const siblings = workspace.active.model.blocks.filter(b => b.parent === block.parent).sort((a, b) => a.from - b.from);
  const index = siblings.indexOf(block);
  $<HTMLButtonElement>('handle-up').disabled = index <= 0;
  $<HTMLButtonElement>('handle-down').disabled = index < 0 || index >= siblings.length - 1;
  $<HTMLButtonElement>('handle-delete').disabled = block.parent !== null;
  $<HTMLButtonElement>('handle-convert').disabled = !(block.node.isTextblock && block.parent === null);
}
// 预览、滚动或撤销都会替换块位置；手柄按最后指针位置重新定位，不因一次刷新消失。
function refreshHandle() {
  const doc = workspace.active;
  if (!doc || doc.readOnly || !pointer) { hideHandle(); return; }
  const under = document.elementFromPoint(pointer.x, pointer.y) as Element | null;
  if (under?.closest('#block-handle, .dropdown-popup')) return;
  const target = under?.closest<HTMLElement>('[data-block]');
  const block = target ? topLevelBlock(doc.model, target.dataset.block!) : handleBlock && doc.model.blocks.some(b => b.id === handleBlock!.id) ? handleBlock : null;
  const element = block ? render.dom.querySelector<HTMLElement>(`[data-block="${block.id}"]`) : null;
  if (!block || !element) { hideHandle(); return; }
  positionHandle(block, element);
}
function handleStructural(operation: (model: Model, id: string) => Patch) {
  if (!handleBlock) throw new Error('请把鼠标移到渲染栏的块上再操作。');
  const doc = workspace.active;
  structural(operation(doc.model, handleBlock.id), undefined, 'render'); hideHandle();
}
function selectCellAt(position: number) {
  requirePreview();
  render.dispatch(render.state.tr.setSelection(TextSelection.near(render.state.doc.resolve(position + 1))));
  render.focus();
}
function openCellMenu(cellId: string, position: number, x: number, y: number) {
  cellMenuCell = cellId;
  const menu = $('cell-menu'); menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  selectCellAt(position);
}
function dropdownTrigger(root: HTMLElement) { return root.querySelector<HTMLButtonElement>('[data-dropdown-trigger]') ?? root.querySelector<HTMLButtonElement>('button')!; }
function setDropdown(root: HTMLElement, open: boolean) {
  const popup = root.querySelector<HTMLElement>('.dropdown-popup')!, trigger = dropdownTrigger(root);
  popup.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    document.querySelectorAll<HTMLElement>('.dropdown').forEach(other => { if (other !== root) { other.querySelector<HTMLElement>('.dropdown-popup')!.hidden = true; dropdownTrigger(other).setAttribute('aria-expanded', 'false'); } });
    $('tooltip').hidden = true;
    const rect = trigger.getBoundingClientRect();
    popup.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${root.id === 'mode-picker' || rect.bottom + popup.offsetHeight > innerHeight ? Math.max(4, rect.top - popup.offsetHeight - 4) : rect.bottom + 4}px`;
  }
}
document.addEventListener('keydown', event => {
  const root = [...document.querySelectorAll<HTMLElement>('.dropdown')].find(element => !element.querySelector<HTMLElement>('.dropdown-popup')!.hidden || dropdownTrigger(element) === document.activeElement);
  if (!root) return;
  const popup = root.querySelector<HTMLElement>('.dropdown-popup')!;
  if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); setDropdown(root, false); dropdownTrigger(root).focus(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault(); setDropdown(root, true);
    const items = [...popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
  const list = fromItems.length ? fromItems : Array.from(data.files);
  return list.filter(file => /^image\//i.test(file.type));
}
function applyImageSize(dom: HTMLImageElement, width: number | null) {
  if (width) dom.style.width = `${width}px`; else dom.style.removeProperty('width');
}
function applyImageSource(dom: HTMLImageElement, src: string) {
  if (!src) return;
  if (/^(?:data:|https?:)/i.test(src)) { dom.src = src; attachImageHover(dom); return; }
  const ticket = workspace.active.ticket('resource');
  resolveImage(workspace.active, src).then(url => {
    if (url && workspace.accept(ticket) && dom.isConnected) { dom.src = url; attachImageHover(dom); }
    else if (!url) dom.alt = dom.alt || `未解析：${src}`;
  }).catch(reason => { if (workspace.accept(ticket)) error(reason); });
}
// S-39：悬停图片显示缩略图浮层，不必点开确认是哪张图。
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
function attachImageHover(dom: HTMLImageElement) {
  if (dom.dataset.hoverBound) return;
  dom.dataset.hoverBound = '1';
  dom.onmouseenter = () => {
    if (!workspace.active || workspace.active.readOnly === undefined) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => action(() => showImageHover(dom)), 260);
  };
  dom.onmouseleave = () => { clearTimeout(hoverTimer); hideImageHover(); };
}
function showImageHover(dom: HTMLImageElement) {
  if (!dom.src) return;
  const popup = $('image-preview');
  const image = $<HTMLImageElement>('image-preview-img');
  const rect = dom.getBoundingClientRect();
  image.src = dom.src;
  image.alt = dom.alt || '图片预览';
  popup.hidden = false;
  popup.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, rect.left))}px`;
  popup.style.top = `${Math.max(8, rect.bottom + 8)}px`;
}
function hideImageHover() {
  const popup = $('image-preview');
  if (!popup.hidden) { popup.hidden = true; $<HTMLImageElement>('image-preview-img').removeAttribute('src'); }
}
function selectImageAt(position: number) {
  requirePreview();
  render.dispatch(render.state.tr.setSelection(NodeSelection.create(render.state.doc, position)));
  render.focus();
  refreshImageHandle();
}
function currentImage(): { atom: Atom; position: number; dom: HTMLElement } | null {
  const selection = render.state.selection, doc = workspace.active;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return null;
  const atom = doc.model.atoms.find(item => item.kind === 'image' && item.pos === selection.from);
  const dom = render.nodeDOM(selection.from);
  return atom && dom instanceof HTMLElement ? { atom, position: selection.from, dom } : null;
}
function refreshImageHandle() {
  const handle = $('image-handle'), image = previewTicket && workspace.accept(previewTicket) ? currentImage() : null;
  if (!image || workspace.active.readOnly) { handle.hidden = true; return; }
  const rect = image.dom.getBoundingClientRect();
  handle.hidden = false;
  handle.style.left = `${rect.right - 7}px`;
  handle.style.top = `${rect.bottom - 7}px`;
}
function placeSourceCaret(offset: number) {
  const doc = workspace.active;
  mirror = true;
  source.dispatch({ selection: { anchor: viewOffset(doc.model, offset) } });
  mirror = false;
  doc.selection = { ...doc.selection, source: { from: offset, to: offset }, active: 'source' };
}
// D-1/D-2/D-3：拖拽、粘贴、选图与系统级拖入共用同一条落盘 + 回写路径。
async function insertImageData(doc: DocumentSession, items: { relativePath: string; alt: string }[], target?: { source?: number; render?: number; pane?: 'source' | 'render' }) {
  const origin = target?.pane ?? doc.selection.active;
  if (origin === 'render') requirePreview();
  for (const item of items) {
    if (origin === 'source') {
      const offsets = normalize(doc.source).offsets;
      const selection = source.state.selection.main;
      const from = target?.source !== undefined ? offsets[Math.min(target.source, offsets.length - 1)] : offsets[selection.from];
      const to = target?.source !== undefined ? from : offsets[selection.to];
      const edit = { from, to, insert: imageMarkdown(item.alt, item.relativePath) };
      const next = parse(doc.source.slice(0, from) + edit.insert + doc.source.slice(to), doc.model, edit);
      const atom = next.atoms.find(atom => atom.kind === 'image' && atom.from >= from && atom.to <= from + edit.insert.length);
      const root = atom && next.blocks.find(block => block.parent === null && atom.pos >= block.pos && atom.pos < block.pos + block.node.nodeSize);
      if (!root) throw new Error('未找到图片所在的顶层块。');
      structural(withFollowingParagraph(doc.model, edit, root.pos), undefined, 'source');
      placeSourceCaret(edit.from + edit.insert.length);
    } else {
      const node = schema.nodes.image.create({ src: item.relativePath, alt: item.alt, title: '', width: null });
      const at = target?.render;
      const tr = at === undefined ? render.state.tr.replaceSelectionWith(node) : render.state.tr.insert(Math.max(1, Math.min(at, render.state.doc.content.size - 1)), node);
      const rootPosition = tr.selection.$from.depth ? tr.selection.$from.before(1) : tr.selection.from;
      const result = renderedEdit(doc.model, tr.doc);
      structural(withFollowingParagraph(doc.model, result.edit, rootPosition), undefined, 'render');
    }
  }
}
// S-40：剪贴板里的 `data:image/…;base64,…` 自动转存为 assets 文件，避免正文塞入长 base64。
const dataUrlImage = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i;
async function insertDataUrlImage(doc: DocumentSession, url: string, target?: { source?: number; render?: number; pane?: 'source' | 'render' }): Promise<boolean> {
  const match = dataUrlImage.exec(url.trim());
  if (!match) return false;
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase() === 'svg+xml' ? 'svg' : match[1].toLowerCase();
  const binary = atob(match[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const saved = await saveImage(doc, bytes, extension);
  await insertImageData(doc, [{ relativePath: saved.relativePath, alt: '图片' }], target);
  return true;
}
async function insertImageFiles(files: File[], target?: { source?: number; render?: number; pane?: 'source' | 'render' }) {
  const doc = workspace.active;
  if (doc.readOnly) throw new Error('当前为只读模式，修改未提交。');
  if (doc.composition) throw new Error('请先提交组合输入。');
  const images = files.filter(file => /^image\//i.test(file.type));
  if (!images.length) throw new Error('没有可插入的图片文件。');
  const items: { relativePath: string; alt: string }[] = [];
  for (const file of images) {
    const saved = await saveImage(doc, new Uint8Array(await file.arrayBuffer()), imageExtension(file));
    items.push({ relativePath: saved.relativePath, alt: file.name.replace(/\.[^.]+$/, '') || '图片' });
  }
  await insertImageData(doc, items, target);
}
// D-1：系统拖入以真实路径到达，按落点命中栏位后走同一条落盘路径。
async function insertImagesFromPaths(paths: string[], point?: { x: number; y: number }) {
  const doc = workspace.active;
  if (doc.readOnly) throw new Error('当前为只读模式，修改未提交。');
  const renderRect = $('render').getBoundingClientRect(), sourceRect = $('source').getBoundingClientRect();
  const inRender = !!point && point.x >= renderRect.left && point.x <= renderRect.right;
  const inSource = !!point && !doc.readOnly && point.x >= sourceRect.left && point.x <= sourceRect.right;
  const items: { relativePath: string; alt: string }[] = [];
  for (const path of paths) {
    const data = await invoke<string>('read_binary', { path });
    const bytes = Uint8Array.from(atob(data.split(',')[1] ?? ''), char => char.charCodeAt(0));
    const saved = await saveImage(doc, bytes, path.replace(/^.*\./, '').toLowerCase());
    items.push({ relativePath: saved.relativePath, alt: path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') });
  }
  const pane = inSource ? 'source' : 'render';
  const at = pane === 'source' ? source.posAtCoords({ x: point!.x, y: point!.y }) ?? undefined : render.posAtCoords({ left: point!.x, top: point!.y })?.pos;
  await insertImageData(doc, items, { pane: inRender || inSource ? pane : undefined, source: pane === 'source' ? at : undefined, render: pane === 'render' ? at : undefined });
}
function selectedItem() {
  const pos = activeRange().from;
  const item = workspace.active.model.blocks.filter(b => b.type === 'list_item' && pos >= b.pos && pos < b.pos + b.node.nodeSize).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
  if (!item) throw new Error('请先在渲染栏选择列表项。'); return item;
}
const escapeHtml = (text: string) => text.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
function highlightFragment(text: string, language: string | null): string {
  return language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text);
}
function highlightDraft() {
  const textarea = $<HTMLTextAreaElement>('draft'), layer = $('draft-highlight'), scroller = layer.parentElement!;
  const value = textarea.value;
  let html: string;
  // 围栏代码块只高亮围栏内部，避免把 ``` 当成语言自身的模板字符串。
  if (draftFence) {
    const lines = value.split('\n');
    const opening = lines.shift() ?? '';
    const last = lines.length ? lines[lines.length - 1] : null;
    const closing = last !== null && /^\s*```/.test(last) ? lines.pop() ?? null : null;
    html = `${escapeHtml(opening)}\n${highlightFragment(lines.join('\n'), draftLanguage)}${closing !== null ? `\n${escapeHtml(closing)}` : ''}`;
  } else html = highlightFragment(value, draftLanguage);
  layer.innerHTML = `${html}\n`;
  scroller.scrollTop = textarea.scrollTop; scroller.scrollLeft = textarea.scrollLeft;
}
// 弹窗按内容类型选高亮：代码按围栏语言（未知回退纯文本）、单元格行内 Markdown、
// 原始 HTML 用 HTML；Mermaid 按设计决策 D-25 保持纯文本；公式另用可视化弹窗。
function languageForBlock(block: Block): string | null {
  if (block.type === 'table_cell') return 'markdown';
  if (block.type !== 'opaque') return 'markdown';
  const kind = String(block.node.attrs.kind);
  if (kind === 'mermaid' || kind === 'hr') return null;
  if (kind === 'code' || kind === 'code_block') {
    const info = String(block.node.attrs.info ?? '').trim().split(/\s/)[0];
    return info && hljs.getLanguage(info) ? info : null;
  }
  if (kind === 'html_block') return 'xml';
  return 'markdown';
}
function isFenceBlock(block: Block | null): boolean {
  return !!block && block.type === 'opaque' && ['code', 'code_block'].includes(String(block.node.attrs.kind));
}
function showDraft(title: string, language: string | null, fence = false) {
  draftLanguage = language; draftFence = fence;
  $('dialog-title').textContent = title;
  $('dialog-language').textContent = language && hljs.getLanguage(language) ? `高亮：${language}` : '高亮：纯文本';
  $('dialog-error').textContent = '';
  $<HTMLTextAreaElement>('draft').scrollTop = 0;
  highlightDraft();
  openFloating($('dialog'));
}
function openDraft(id?: string) {
  const doc = workspace.active;
  const block = id ? doc.model.blocks.find(b => b.id === id) : doc.model.blocks.filter(b => render.state.selection.from >= b.pos && render.state.selection.from < b.pos + b.node.nodeSize).sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
  const selectedFormula = !id && render.state.selection instanceof NodeSelection && render.state.selection.node.type.name === 'math_inline';
  const onlyFormula = block?.node.isTextblock && block.node.childCount === 1 && block.node.firstChild?.type.name === 'math_inline';
  if (block?.type === 'math_block' || selectedFormula || onlyFormula) { void openMathDraft(block?.type === 'math_block' ? block.pos : onlyFormula ? block!.pos + 1 : render.state.selection.from); return; }
  const range = block ? { from: block.from, to: block.to } : { from: 0, to: doc.source.length };
  draftBlock = block && block.id === id ? block : null; draftAtom = null;
  activeDraft = doc.draft(range);
  $<HTMLTextAreaElement>('draft').value = activeDraft.text; $<HTMLTextAreaElement>('draft').readOnly = doc.readOnly;
  $<HTMLButtonElement>('confirm').disabled = doc.readOnly;
  const table = block?.type === 'table_cell' ? `表格单元格源码${block.node.attrs.header ? '（表头）' : ''}` : '源码片段';
  showDraft(doc.readOnly ? '查看源码（只读）' : table, doc.readOnly ? null : block ? languageForBlock(block) : 'markdown', !doc.readOnly && isFenceBlock(block ?? null));
}
function openHtmlDraft(atom: Atom) {
  const doc = workspace.active;
  draftBlock = null; draftAtom = atom;
  activeDraft = doc.draft({ from: atom.from, to: atom.to });
  $<HTMLTextAreaElement>('draft').value = activeDraft.text; $<HTMLTextAreaElement>('draft').readOnly = doc.readOnly;
  $<HTMLButtonElement>('confirm').disabled = doc.readOnly;
  showDraft('内联 HTML 标签源码', 'xml');
}
type MathEditor = ReturnType<typeof import('./ui/math-editor').createMathEditor>;
let mathDraft: { ticket: Ticket; target: FormulaTarget; editor?: MathEditor } | null = null;
function cancelMathDraft() {
  mathDraft?.editor?.dispose(); mathDraft = null;
  $('math-editor-host').replaceChildren();
  closeFloating($('math-dialog'));
  render.focus();
}
async function openMathDraft(position: number) {
  const doc = workspace.active;
  if (doc.readOnly) return;
  if (doc.modelStale || doc.renderRevision !== doc.revision) throw new Error('请先刷新渲染后再编辑公式。');
  if (mathDraft) cancelMathDraft();
  const state = { ticket: doc.ticket('math-dialog'), target: formulaTarget(doc.model, position) } as NonNullable<typeof mathDraft>;
  mathDraft = state;
  $('math-title').textContent = state.target.kind === 'math_inline' ? '编辑行内公式' : '编辑块级公式';
  $('math-error').textContent = '正在加载公式编辑器…';
  $<HTMLButtonElement>('math-confirm').disabled = true;
  openFloating($('math-dialog'));
  try {
    const { createMathEditor } = await import('./ui/math-editor');
    if (mathDraft !== state) return;
    if (!workspace.accept(state.ticket)) throw new Error('文档版本已变化，请取消后重新打开公式。');
    state.editor = createMathEditor($('math-editor-host'), $('math-keyboard'), state.target.latex, state.target.kind === 'math_block');
    $('math-error').textContent = '';
    $<HTMLButtonElement>('math-confirm').disabled = false;
  } catch (reason) {
    if (mathDraft !== state) return;
    console.error('公式编辑器初始化失败', reason);
    $('math-editor-host').replaceChildren();
    const message = reason instanceof Error ? reason.message : String(reason);
    $('math-error').textContent = !workspace.accept(state.ticket) ? message : message === mathUnsupported ? mathUnsupported : `公式编辑器初始化失败：${message}`;
  }
}
$('math-cancel').onclick = cancelMathDraft;
$('math-confirm').onclick = () => {
  const state = mathDraft;
  if (!state?.editor) return;
  try {
    if (!workspace.accept(state.ticket)) throw new Error('文档版本已变化，修改未提交；请取消后重新打开公式。');
    const doc = workspace.active, latex = state.editor.value();
    if (latex !== state.target.latex) {
      const result = formulaEdit(doc.model, state.target, latex);
      doc.commit(state.ticket, result.edit, undefined, result.model);
    }
    cancelMathDraft(); showDocument(); render.focus();
  } catch (reason) { $('math-error').textContent = reason instanceof Error ? reason.message : String(reason); }
};
// 公式使用独立可视化草稿；非公式原子沿用源码编辑。
function openAtomDraft(position: number, kind: string) {
  const doc = workspace.active;
  if (kind === 'math_inline' || kind === 'math_block') return openMathDraft(position);
  const block = doc.model.blocks.find(item => item.pos === position && item.type === kind);
  if (!block) { error(new Error('该内容的位置已变化，请刷新渲染后重试。')); return; }
  draftBlock = block; draftAtom = null;
  activeDraft = doc.draft({ from: block.from, to: block.to });
  $<HTMLTextAreaElement>('draft').value = activeDraft.text; $<HTMLTextAreaElement>('draft').readOnly = doc.readOnly;
  $<HTMLButtonElement>('confirm').disabled = doc.readOnly;
  showDraft(doc.readOnly ? '查看源码（只读）' : '文档元数据源码', kind === 'front_matter' ? 'yaml' : null);
}
window.addEventListener('mdre:atom-edit', event => {
  const detail = (event as CustomEvent<{ pos: number; kind: string }>).detail;
  action(() => openAtomDraft(detail.pos, detail.kind));
});
// 验收钩子：仅在开发模式下启用，用于在真实窗口内取回导出快照。
if (import.meta.env.DEV) {
  window.addEventListener('mdre:test-export', event => {
    const text = (event as CustomEvent<{ text: string }>).detail?.text;
    action(async () => {
      const html = await staticHtml(typeof text === 'string' && text.length ? text : workspace.active.source, src => resolveImage(workspace.active, src));
      window.dispatchEvent(new CustomEvent('mdre:test-export-done', { detail: { html } }));
    });
  });
}
$<HTMLTextAreaElement>('draft').oninput = highlightDraft;
$<HTMLTextAreaElement>('draft').onscroll = highlightDraft;
function compositionStart(origin: 'source' | 'render') {
  const session = workspace.active; if (!session || session.readOnly) return;
  session.selection.active = origin; session.composition = origin;
  compositionBase = { session, ticket: session.ticket(`composition-${origin}`), model: session.model, selection: structuredClone(session.selection) }; status();
}
function compositionEnd() {
  // 浏览器在 compositionend 后发送最后一笔 input/事务。
  setTimeout(() => action(() => {
    const base = compositionBase; if (!base) return;
    const doc = base.session;
    let committed = false;
    try {
    if (!doc.current(base.ticket)) throw new Error('组合输入的基准版本已变化。');
    const origin = doc.composition;
    if (origin === 'render') {
      const result = renderedEdit(base.model, render.state.doc);
      doc.commit(base.ticket, result.edit, { ...selection(), active: 'render' }, result.model);
    } else {
      const oldView = normalize(base.model.source), newView = source.state.doc.toString();
      const delta = difference(oldView.text, newView), edit = { from: oldView.offsets[delta.from], to: oldView.offsets[delta.to], insert: delta.insert.replace(/\n/g, doc.source.includes('\r\n') ? '\r\n' : '\n') };
      const next = doc.source.slice(0, edit.from) + edit.insert + doc.source.slice(edit.to), offsets = normalize(next).offsets, cm = source.state.selection.main;
      doc.commit(base.ticket, edit, { ...selection(), source: { from: offsets[cm.from], to: offsets[cm.to] }, active: 'source' });
    }
    committed = true;
    } finally {
      compositionBase = null; doc.composition = null;
      if (!committed) doc.selection = base.selection;
      if (pendingMode && committed) doc.readOnly = !doc.readOnly;
      pendingMode = false; workspace.compositionEnded(); queuedRefresh = false; showDocument();
    }
  }), 0);
}
source.contentDOM.addEventListener('compositionstart', () => compositionStart('source'));
source.contentDOM.addEventListener('compositionend', compositionEnd);
render.dom.addEventListener('compositionstart', () => compositionStart('render'));
render.dom.addEventListener('compositionend', compositionEnd);
render.dom.addEventListener('focus', () => { if (workspace.active && !workspace.active.readOnly) workspace.active.selection.active = 'render'; });
render.dom.addEventListener('click', event => {
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  event.preventDefault();
  if (!event.ctrlKey && !workspace.active.readOnly) return;
  action(async () => {
    const href = link.getAttribute('href')!;
    if (!safeUrl(href)) throw new Error('链接地址无效。');
    if (href.startsWith('#')) {
      const target = decodeURIComponent(href.slice(1));
      const entry = outlineEntries(workspace.active.model).find(item => item.text === target || item.text.toLowerCase().replace(/\s+/g, '-') === target.toLowerCase());
      if (entry) jumpToOutline(entry);
    } else if (isTauri()) await invoke('open_external', { url: href });
    else window.open(href, '_blank', 'noopener,noreferrer');
  });
});
source.contentDOM.addEventListener('focus', () => { if (workspace.active) workspace.active.selection.active = 'source'; });

function download(name: string, data: BlobPart, mime: string) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([data], { type: mime })); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
async function exportHtml(explicitPath?: string, doc = workspace.active) {
  if (!doc) return;
  flushInline(doc);
  if (doc.composition) throw new Error('请先提交组合输入再导出。');
  const text = doc.source, revision = doc.revision, suggested = documentTitle(doc) + '.html';
  const path = isTauri() ? explicitPath ?? await invoke<string | null>('pick_export', { format: 'html', suggested }) : null;
  if (isTauri() && !path) return;
  const html = await staticHtml(text, src => resolveImage(doc, src), exportAppearance(doc.id,doc.model,render.dom));
  if (path) { await invoke('write_export', { path, html }); $('status-text').textContent = `已导出 HTML · r${revision} · ${path}`; }
  else download(suggested, html, 'text/html;charset=utf-8');
}
async function exportPdf(explicitPath?: string, doc = workspace.active) {
  if (!doc) return;
  flushInline(doc);
  if (!isTauri()) throw new Error('原生 PDF 请在 Tauri 桌面应用中执行。');
  if (doc.composition) throw new Error('请先提交组合输入再导出。');
  const ticket = doc.ticket('export'), sourceText = doc.source, appearance = exportAppearance(doc.id,doc.model,render.dom);
  const path = explicitPath ?? await invoke<string | null>('pick_export', { format: 'pdf', suggested: documentTitle(doc) + '.pdf' });
  if (!path) return;
  $('status-text').textContent = '正在准备不可变快照与图片/字体/Mermaid…';
  const html = await staticHtml(sourceText, src => resolveImage(doc, src), appearance);
  const result = await invoke<{ path: string; bytes: number; engine: string }>('export_pdf', { html, path });
  $('status-text').textContent = `原生回调成功 · ${ticket.docId} r${ticket.revision} · ${result.engine} · ${result.path} · ${result.bytes} bytes`;
  return result;
}
const handlers: Record<string, () => void | Promise<void>> = {
  'source-toggle': () => toggleSourceVisibility(),
  'sidebar-new': async () => { if (filesPanel.root) { const path = await invoke<string>('create_document', { path: filesPanel.root }); await openPath(path); await filesPanel.openFolder(filesPanel.root); } else newBlankTab(); },
  'sidebar-open': () => openViaPicker(),
  undo: () => travel(false), redo: () => travel(true), refresh: () => { if (workspace.active.composition) { queuedRefresh = true; status(); } else schedulePreview(0, true); },
  mode: () => setDropdown($('mode-picker'), $('mode-picker').querySelector<HTMLElement>('.dropdown-popup')!.hidden),
  'mode-toggle': () => switchMode(),
  new: () => { newBlankTab(); },
  backup: async () => { captureView(workspace.active, render, source); await recovery.flush(); },
  'outline-toggle': () => toggleOutline(),
  'outline-collapse': () => sidebar.collapse(),
  'welcome-new': () => { newBlankTab(); },
  'new-welcome': () => { const doc = new DocumentSession(crypto.randomUUID(), '', { title: '欢迎页' }); doc.welcome = true; doc.readOnly = true; workspace.add(doc); switchTo(doc.id); },
  'welcome-open': () => $('open').click(),
  'find-open': () => { $('search-bar').hidden = false; $<HTMLInputElement>('find').focus(); updateFind(); },
  'replace-open': () => { if (!workspace.active.readOnly) { $('search-bar').hidden = false; $<HTMLInputElement>('replace').focus(); } },
  'find-close': () => { $('search-bar').hidden = true; find(render, { query: '', regex: false, caseSensitive: false, wholeWord: false }); restoreSelections(); },
  bold: boldActive,
  underline: () => markActive(schema.marks.underline),
  'paper-toggle': () => paper.toggle(),
  italic: () => markActive(schema.marks.em),
  strike: () => markActive(schema.marks.strike),
  'inline-code': () => markActive(schema.marks.code),
  highlight: () => markActive(schema.marks.bg, undefined, $<HTMLInputElement>('bg-color').value),
  // C-15/C-16：背景色、字号、上下标与既有格式走同一条统一事务入口。
  superscript: () => markActive(schema.marks.sup),
  subscript: () => markActive(schema.marks.sub),
  quote: () => convertActive('quote'),
  bullet: () => convertActive('bullet'),
  ordered: () => convertActive('ordered'),
  task: () => convertActive('task'),
  rule: () => convertActive('hr'),
  link: openLinkDialog,
  table: openTableDialog,
  image: () => $<HTMLInputElement>('image-input').click(),
  'code-block': openCodeDialog,
  split: splitActive, join: joinActive,
  up: () => structural(swapSibling(workspace.active.model, selectedItem().id, -1)), down: () => structural(swapSibling(workspace.active.model, selectedItem().id, 1)), raw: () => openDraft(),
  save: async () => { await saveDocument(workspace.active, false); },
  'save-as': async () => { await saveDocument(workspace.active, true); },
  'close-tab': async () => { await closeTab(workspace.activeId); },
  copy: async () => { await navigator.clipboard.writeText(workspace.active.source); $('status-text').textContent = '已复制完整源码'; },
  // S-35：专注模式只切换界面可见性。
  'focus-toggle': () => applyFocusMode(!document.body.classList.contains('focus-mode')),
  // S-42：最近打开列表展开（菜单项本身也是可点元素）。
  'recent-menu': () => { const list = $('recent-list'); list.hidden = !list.hidden; $('recent-folder-list').hidden = true; },
  'recent-folder-menu': () => { const list = $('recent-folder-list'); list.hidden = !list.hidden; $('recent-list').hidden = true; },
  // S-44：跳转到行。菜单项只有 data-command，走命令分发而不是元素点击。
  'goto-line': () => openGotoDialog(),
  html: exportHtml,
  'pdf-open': async () => { await exportPdf(); },
  pdf: async () => { await exportPdf(); closeFloating($('pdf-dialog')); },
  open: () => { if (isTauri()) return openViaPicker(); $<HTMLInputElement>('file').click(); },
  search: () => updateFind(true),
  'replace-one': () => {
    if (workspace.active.readOnly) throw new Error('只读模式不能替换。');
    if (!replaceCurrent(render, $<HTMLInputElement>('replace').value)) throw new Error('没有可替换的匹配。');
    showDocument(); updateFind();
  },
  'replace-all': () => {
    if (workspace.active.readOnly) throw new Error('只读模式不能替换。');
    const count = replaceAll(render, $<HTMLInputElement>('replace').value);
    if (!count) throw new Error('没有可替换的匹配。');
    showDocument(); updateFind();
    $('find-result').textContent = `已替换 ${count} 处`;
  },
};
// 只有真正存在的元素才绑定点击；其余命令由菜单或快捷键按 id 分发。
for (const [id, handler] of Object.entries(handlers)) { const element = document.getElementById(id); if (element) element.onclick = () => action(handler); }
export function runCommand(id: string): boolean {
  const handler = handlers[id];
  if (!handler) return false;
  action(handler);
  return true;
}
(globalThis as { __mdreCommands?: Record<string, () => void | Promise<void>> }).__mdreCommands = handlers;
// 验收辅助：暴露快捷键解析结果，便于在真实窗口内核对绑定是否生效。
(globalThis as { __mdreShortcut?: (binding: string, event: KeyboardEvent) => boolean }).__mdreShortcut = matchShortcut;
document.addEventListener('mdre:command', event => { runCommand((event as CustomEvent<string>).detail); });
$<HTMLInputElement>('file').onchange = () => action(async () => {
  const file = $<HTMLInputElement>('file').files![0]; if (!file) return;
  const doc = new DocumentSession(crypto.randomUUID(), new Uint8Array(await file.arrayBuffer()), { title: file.name }); workspace.add(doc); switchTo(doc.id); $<HTMLInputElement>('file').value = '';
});
$<HTMLInputElement>('image-input').onchange = () => action(async () => {
  const files = Array.from($<HTMLInputElement>('image-input').files ?? []);
  $<HTMLInputElement>('image-input').value = '';
  await insertImageFiles(files);
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
let imageDrag: { atom: Atom; startX: number; width: number; dom: HTMLElement } | null = null;
$('image-handle').addEventListener('pointerdown', event => {
  const image = currentImage();
  if (!image) return;
  event.preventDefault();
  imageDrag = { atom: image.atom, startX: event.clientX, width: image.dom.getBoundingClientRect().width, dom: image.dom };
  $('image-handle').setPointerCapture(event.pointerId);
});
$('image-handle').addEventListener('pointermove', event => {
  if (!imageDrag) return;
  imageDrag.dom.style.width = `${Math.max(40, Math.round(imageDrag.width + event.clientX - imageDrag.startX))}px`;
});
$('image-handle').addEventListener('pointerup', event => {
  const drag = imageDrag; imageDrag = null;
  if (!drag) return;
  $('image-handle').releasePointerCapture(event.pointerId);
  const width = Math.max(40, Math.round(drag.width + event.clientX - drag.startX));
  action(() => {
    const doc = workspace.active;
    const atom = doc.model.atoms.find(item => item.kind === 'image' && item.pos === drag.atom.pos);
    if (!atom) throw new Error('图片已变化，宽度未写入。');
    structural(setImageWidth(doc.model, atom, width), undefined, 'render');
  });
});
$('cancel').onclick = () => closeFloating($('dialog'));
$('pdf-cancel').onclick = () => closeFloating($('pdf-dialog'));
$('confirm').onclick = () => {
  if (!activeDraft) return;
  activeDraft.text = $<HTMLTextAreaElement>('draft').value;
  try {
    if (activeDraft.docId !== workspace.activeId) throw new Error('文档已切换，草稿保留；请回到原文档重新定位。');
    const doc = workspace.active, cell = draftBlock?.type === 'table_cell' ? draftBlock.id : null, atom = draftAtom;
    if (cell) doc.commit(activeDraft, setTableCell(doc.model, cell, activeDraft.text));
    else if (atom) doc.commit(activeDraft, setInlineHtml(doc.model, atom, activeDraft.text));
    else doc.confirm(activeDraft);
    closeFloating($('dialog')); draftBlock = null; draftAtom = null; showDocument();
    // C-12：单元格弹窗确认后回到该单元格。
    const target = cell ? doc.model.blocks.find(b => b.id === cell && b.type === 'table_cell') : null;
    if (target && !doc.readOnly) selectCellAt(target.pos);
  } catch (reason) { $('dialog-error').textContent = String(reason); }
};
$('link-confirm').onclick = () => action(() => {
  restoreFormat('link');
  const href = $<HTMLInputElement>('link-url').value.trim();
  if (!safeUrl(href)) throw new Error('链接需为 http / https / mailto 地址。');
  markActive(schema.marks.link, { href, title: '' });
  closeFloating($('link-dialog'));
});
$('link-cancel').onclick = () => closeFloating($('link-dialog'));
$('code-confirm').onclick = () => action(() => {
  restoreFormat('code');
  const doc = workspace.active, range = activeRange(), block = blockAtRange(doc.model, range);
  if (!block) throw new Error('请把光标放在顶层段落或标题内。');
  structural(convertBlock(doc.model, block.id, 'code', { info: $<HTMLInputElement>('code-language').value.trim(), followingParagraph: true }), range, doc.selection.active);
  closeFloating($('code-dialog'));
  const inserted = doc.model.blocks.find(item => item.type === 'opaque' && item.node.attrs.kind === 'code' && item.from === block.from);
  const input = inserted && (render.nodeDOM(inserted.pos) as HTMLElement)?.querySelector<HTMLTextAreaElement>('textarea');
  if (input) { doc.selection.active = 'render'; input.focus(); }
});
$('code-cancel').onclick = () => closeFloating($('code-dialog'));
$('table-confirm').onclick = () => action(() => {
  restoreFormat('table');
  const doc = workspace.active, origin = doc.selection.active, range = activeRange();
  const block = blockAtRange(doc.model, range);
  const anchor = block ? topLevelBlock(doc.model, block.id) : doc.model.blocks.filter(b => b.parent === null).at(-1) ?? null;
  const oldIds = new Set(doc.model.blocks.filter(block => block.type === 'table_cell').map(block => block.id));
  structural(insertTable(doc.model, anchor, Number($<HTMLInputElement>('table-rows').value), Number($<HTMLInputElement>('table-columns').value), true), undefined, origin);
  closeFloating($('table-dialog'));
  const cell = doc.model.blocks.find(block => block.type === 'table_cell' && !oldIds.has(block.id));
  if (cell) { doc.selection.active = 'render'; selectCellAt(cell.pos); }
});
$('table-cancel').onclick = () => closeFloating($('table-dialog'));
$('handle-up').onclick = () => action(() => handleStructural((model, id) => moveBlock(model, id, -1)));
$('handle-down').onclick = () => action(() => handleStructural((model, id) => moveBlock(model, id, 1)));
$('handle-delete').onclick = () => action(() => handleStructural((model, id) => deleteBlock(model, id)));
$('handle-convert').onclick = () => setDropdown($('convert'), $('convert').querySelector<HTMLElement>('.dropdown-popup')!.hidden);
$('heading-menu').onclick = () => setDropdown($('heading'), $('heading').querySelector<HTMLElement>('.dropdown-popup')!.hidden);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) button.onclick = () => action(() => {
  setDropdown($('mode-picker'), false); switchMode(button.dataset.mode === 'read');
});
for (const button of document.querySelectorAll<HTMLButtonElement>('#heading [data-heading]')) button.onclick = () => action(() => {
  const level = Number(button.dataset.heading);
  setDropdown($('heading'), false);
  convertActive(level ? 'heading' : 'paragraph', level ? { level } : undefined);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('#convert [data-convert]')) button.onclick = () => action(() => {
  const kind = button.dataset.convert as BlockKind;
  setDropdown($('convert'), false);
  if (!handleBlock) throw new Error('请把鼠标移到渲染栏的块上再操作。');
  structural(convertBlock(workspace.active.model, handleBlock.id, kind, { level: 2, followingParagraph: !['paragraph','heading'].includes(kind) }), undefined, 'render');
  hideHandle();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('#cell-menu [data-cell]')) button.onclick = () => action(() => {
  const id = cellMenuCell; if (!id) throw new Error('请先在表格单元格上右键。');
  const doc = workspace.active;
  const operations: Record<string, () => Patch> = {
    'row-above': () => insertRow(doc.model, id, 0), 'row-below': () => insertRow(doc.model, id, 1), 'row-remove': () => removeRow(doc.model, id),
    'column-before': () => insertColumn(doc.model, id, 0), 'column-after': () => insertColumn(doc.model, id, 1), 'column-remove': () => removeColumn(doc.model, id),
  };
  $('cell-menu').hidden = true;
  structural(operations[button.dataset.cell!](), undefined, 'render');
});
const colorControls = {
  color: setupColorPicker($('color-picker'), { apply: value => markActive(schema.marks.color, undefined, value), dropdown: open => setDropdown($('color-picker'), open), run: action }),
  bg: setupColorPicker($('highlight-picker'), { apply: value => markActive(schema.marks.bg, undefined, value), dropdown: open => setDropdown($('highlight-picker'), open), run: action }),
};
$('font-size-menu').onclick = () => setDropdown($('font-size-dropdown'), $('font-size-dropdown').querySelector<HTMLElement>('.dropdown-popup')!.hidden);
$('font-size-dropdown').querySelectorAll<HTMLButtonElement>('[data-size]').forEach(button => {
  button.onclick = () => action(() => { markActive(schema.marks.size, { size: button.dataset.size! }); setDropdown($('font-size-dropdown'), false); });
});
document.addEventListener('pointerdown', event => {
  for (const id of ['color-picker', 'highlight-picker']) if (!closestOf(event.target, `#${id}`)) setDropdown($(id), false);
  if (!closestOf(event.target, '.dropdown')) { setDropdown($('heading'), false); setDropdown($('convert'), false); setDropdown($('font-size-dropdown'), false); }
  if (!closestOf(event.target, '#mode-picker')) setDropdown($('mode-picker'), false);
  if (!closestOf(event.target, '#cell-menu')) { const menu = $('cell-menu'); if (menu) menu.hidden = true; }
});
$('render').addEventListener('mousemove', event => {
  clearTimeout(handleTimer);
  pointer = { x: event.clientX, y: event.clientY };
  refreshHandle();
});
$('render').addEventListener('mouseleave', () => { clearTimeout(handleTimer); handleTimer = setTimeout(() => { if (!$('block-handle').matches(':hover')) { pointer = null; hideHandle(); } }, 250); });
$('render').addEventListener('scroll', refreshHandle);
$('block-handle').addEventListener('mouseenter', () => clearTimeout(handleTimer));
$('block-handle').addEventListener('mouseleave', () => { clearTimeout(handleTimer); handleTimer = setTimeout(hideHandle, 250); });
$('render').addEventListener('mousedown', event => {
  // 单元格点击由 node view 处理；点空白处收起手柄。
  if (!(event.target as Element).closest('[data-cell]')) hideHandle();
});
// 工具栏保留最后活动编辑器的选区；组合期间刷新不会夺走焦点。
document.querySelectorAll('.toolbar, #menubar').forEach(toolbar => toolbar.addEventListener('mousedown', event => {
  const button = (event.target as Element).closest('button');
  if (button && !['open', 'find-open', 'replace-open'].includes(button.id)) event.preventDefault();
}));

const editorContext = contextMenu('editor-context'), tabContext = contextMenu('tab-context');
function openTabContext(id: string, x: number, y: number) {
  const doc = workspace.documents.get(id); if (!doc) return;
  const run = (operation: () => void | Promise<void>) => () => action(operation);
  const others = [...workspace.documents.keys()].filter(key => key !== id);
  tabContext.open([
    { id: 'rename', label: '重命名…', icon: 'markdown', run: run(() => renameDialog(doc)) },
    { id: 'duplicate', label: '复制文件…', icon: 'copy', run: run(() => duplicateDocument(doc)) },
    { id: 'sep-path', label: '', separator: true },
    { id: 'copy-path', label: '复制文件路径', icon: 'copyRelative', accelerator: 'Shift+Alt+C', disabled: !doc.path, run: run(async () => { await navigator.clipboard.writeText(doc.path!); $('status-text').textContent = '已复制文件路径'; }) },
    { id: 'reveal', label: '在资源管理器中显示', icon: 'openFolder', accelerator: 'Shift+Alt+R', disabled: !doc.path || !isTauri(), run: run(async () => { await invoke('reveal_document', { path: doc.path }); $('status-text').textContent = `已打开所在文件夹 · ${doc.path}`; }) },
    { id: 'sep-export', label: '', separator: true },
    { id: 'html', label: '导出 HTML…', icon: 'export', run: run(() => exportHtml(undefined, doc)) },
    { id: 'pdf', label: '导出 PDF…', icon: 'export', disabled: !isTauri(), run: run(() => exportPdf(undefined, doc).then(() => {})) },
    { id: 'sep-close', label: '', separator: true },
    { id: 'close', label: '关闭文档', icon: 'close', accelerator: 'Ctrl+W', run: run(() => closeTab(id)) },
    { id: 'close-others', label: '关闭其他文档', icon: 'closeOthers', disabled: !others.length, run: run(async () => { for (const key of others) await closeTab(key); }) },
    { id: 'close-saved', label: '关闭已保存', icon: 'closeSaved', disabled: ![...workspace.documents.values()].some(item => !item.dirty), run: run(async () => { for (const [key, item] of [...workspace.documents]) if (!item.dirty) await closeTab(key); }) },
    { id: 'close-all', label: '全部关闭', icon: 'closeAll', accelerator: 'Ctrl+K W', run: run(async () => { for (const key of [...workspace.documents.keys()]) await closeTab(key); }) },
  ], x, y);
}
let renameTarget: DocumentSession | null = null;
const renamePopup = document.createElement('dialog'); renamePopup.id = 'rename-dialog'; renamePopup.dataset.cancel = 'rename-cancel';
renamePopup.innerHTML = '<h3>重命名文件</h3><label for="rename-name">文件名</label><input id="rename-name" aria-label="新文件名"><p>已保存文件在原目录改名；未保存内容与撤销历史保留。</p><div id="rename-error" role="alert"></div><div class="dialog-actions"><button id="rename-cancel">取消</button><button id="rename-confirm" class="primary-button">确定</button></div>';
document.body.append(renamePopup);
function renameDialog(doc: DocumentSession) {
  flushInline(doc);
  if (doc.fileOperation || doc.composition) throw new Error('请先完成当前编辑或文件操作。');
  renameTarget = doc; $<HTMLInputElement>('rename-name').value = doc.title; $('rename-error').textContent = '';
  openFloating(renamePopup); $<HTMLInputElement>('rename-name').focus(); $<HTMLInputElement>('rename-name').select();
}
async function renameDocument(doc: DocumentSession, name: string) {
  if (!workspace.documents.has(doc.id)) throw new Error('文档已关闭。');
  if (!name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error('文件名包含不支持的字符或 Windows 保留名称。');
  if (doc.fileOperation || doc.composition) throw new Error('请先完成当前操作。');
  const target = doc.path ? `${directoryOf(doc.path)}/${name}` : null;
  if (target && [...workspace.documents.values()].some(other => other.id !== doc.id && samePath(other.path, target))) throw new Error('目标文件已在其他标签打开。');
  doc.fileOperation = true;
  try {
    await saveQueue.flush();
    if (doc.path) {
      const result = await invoke<Awaited<ReturnType<typeof readTextFile>>>('rename_document', { path: doc.path, name, expectedFingerprint: doc.diskFingerprint });
      doc.path = result.path; doc.diskFingerprint = result.fingerprint;
    }
    doc.title = name; doc.recoveryRevision = -1; doc.transactionId++;
    if (workspace.activeId === doc.id) showDocument(); else status();
  } finally { doc.fileOperation = false; }
}
$('rename-confirm').onclick = () => { action(async () => { try { if (renameTarget) await renameDocument(renameTarget, $<HTMLInputElement>('rename-name').value); closeFloating(renamePopup); } catch (reason) { $('rename-error').textContent = String(reason); throw reason; } }); };
$('rename-cancel').onclick = () => { renameTarget = null; closeFloating(renamePopup); };
$<HTMLInputElement>('rename-name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('rename-confirm').click(); } };
async function duplicateDocument(doc: DocumentSession, explicitPath?: string) {
  flushInline(doc);
  if (doc.composition) throw new Error('请先提交组合输入。');
  const text = doc.source;
  // 副本标题也保证唯一，避免多份副本同名而无法区分。
  const used = new Set([...workspace.documents.values()].map(item => item.title));
  const base = doc.title.replace(/(\.[^.]+)?$/, '');
  const extension = /(\.[^.]+)$/.exec(doc.title)?.[1] ?? '';
  let copyTitle = `${base} - 副本${extension}`;
  for (let index = 2; used.has(copyTitle); index++) copyTitle = `${base} - 副本 ${index}${extension}`;
  const path = explicitPath ?? (isTauri() ? await pickFile(true, copyTitle) : null);
  if (isTauri() && !path) return;
  if (path && [...workspace.documents.values()].some(other => samePath(other.path, path))) throw new Error('目标文件已经打开，请选择另一个文件名。');
  const clone = new DocumentSession(crypto.randomUUID(), text, { title: copyTitle, path: doc.path, encoding: doc.encoding, bom: doc.bom });
  clone.resourceRoot = doc.resourceRoot; clone.recoveryRoot = doc.recoveryRoot; clone.resources = new Set(doc.resources);
  if (path) await saveQueue.save(clone, { path }); else clone.path = null;
  workspace.add(clone); switchTo(clone.id);
}
function insertSpecial(_kind: 'mermaid') {
  const doc = workspace.active, range = activeRange();
  const block = blockAtRange(doc.model, range), root = block ? topLevelBlock(doc.model, block.id) : doc.model.blocks.find(b => b.parent === null && range.from >= b.pos && range.from <= b.pos + b.node.nodeSize);
  const raw = '```mermaid\ngraph TD\n  A --> B\n```\n';
  const newline = doc.source.includes('\r\n') ? '\r\n' : '\n';
  const blank = doc.source.trim() === '', at = root?.to ?? doc.source.length;
  const prefix = blank && doc.source.startsWith('\uFEFF') ? 1 : 0;
  const edit = { from: blank ? prefix : at, to: blank ? doc.source.length : at, insert: (blank ? '' : newline + newline) + raw.replace(/\n/g, newline) };
  const next = parse(doc.source.slice(0, edit.from) + edit.insert + doc.source.slice(edit.to), doc.model, edit);
  const inserted = next.blocks.find(block => block.parent === null && block.type === 'opaque' && block.from >= edit.from);
  if (!inserted) throw new Error('未找到插入的源码块。');
  structural(withFollowingParagraph(doc.model, edit, inserted.pos), undefined, 'render');
  const added = doc.model.blocks.find(b => b.type === 'opaque' && b.from >= (blank ? 0 : at));
  if (added) openDraft(added.id);
}
function insertFollowingParagraph(pos = render.state.selection.from) {
  const doc = workspace.active;
  const block = doc.model.blocks.find(block => block.parent === null && pos >= block.pos && pos <= block.pos + block.node.nodeSize);
  if (!block) throw new Error('未找到当前块。');
  const newline = doc.source.includes('\r\n') ? '\r\n' : '\n';
  structural({ from: block.to, to: block.to, insert: newline.repeat(block.to === doc.source.length ? 2 : 4) }, undefined, 'render');
  const after = doc.model.blocks.find(item => item.type === 'paragraph' && item.pos > block.pos && item.from >= block.to);
  if (after) { render.dispatch(render.state.tr.setSelection(TextSelection.near(render.state.doc.resolve(after.pos + 1)))); render.focus(); }
}
function openEditorContext(event: MouseEvent, origin: 'source' | 'render') {
  const doc = workspace.active; if (!doc) return;
  event.preventDefault();
  const control = (event.target as Element).closest<HTMLTextAreaElement | HTMLInputElement>('.inline-editor textarea, .inline-editor input');
  doc.selection.active = origin;
  if (origin === 'render' && !control && render.state.selection.empty) {
    const at = render.posAtCoords({ left: event.clientX, top: event.clientY }); if (at) render.dispatch(render.state.tr.setSelection(TextSelection.near(render.state.doc.resolve(at.pos))));
  }
  const chosen = structuredClone(selection()), ticket = doc.ticket('context');
  const selected = control ? control.selectionStart !== control.selectionEnd : chosen[origin].from !== chosen[origin].to;
  const writable = !doc.readOnly;
  const run = (operation: () => void | Promise<void>) => () => action(() => {
    if (!workspace.accept(ticket)) throw new Error('菜单对应文档已变化，请重新右键。');
    if (!control) { doc.selection = structuredClone(chosen); restoreSelections(); }
    return operation();
  });
  const item = (id: string, label: string, operation: () => void | Promise<void>, disabled = false, icon?: Icon, accelerator?: string): ContextItem => ({ id, label, icon, accelerator, disabled, run: run(operation) });
  const copyText = () => control ? control.value.slice(control.selectionStart ?? 0, control.selectionEnd ?? 0) : origin === 'source' ? doc.source.slice(chosen.source.from, chosen.source.to) : render.state.doc.textBetween(chosen.render.from, chosen.render.to, '\n');
  const pasteText = (text: string) => {
    if (control) { control.setRangeText(text, control.selectionStart ?? 0, control.selectionEnd ?? 0, 'end'); control.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (origin === 'source') source.dispatch({ changes: { from: source.state.selection.main.from, to: source.state.selection.main.to, insert: text }, selection: { anchor: source.state.selection.main.from + text.length } });
    else { const normalized = text.replace(/\r\n|\r/g, '\n'); if (!normalized.includes('\n')) render.dispatch(render.state.tr.insertText(normalized)); else if (cellAt(render.state)) { const nodes: PMNode[] = []; normalized.split('\n').forEach((line, i) => { if (i) nodes.push(schema.nodes.hard_break.create()); if (line) nodes.push(schema.text(line)); }); render.dispatch(render.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0))); } else { const nodes = normalized.split(/\n+/).map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : null)); render.dispatch(render.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 1, 1))); } }
  };
  const items: ContextItem[] = [
    item('copy', '复制', async () => { await navigator.clipboard.writeText(copyText()); }, !selected, 'copy', 'Ctrl+C'),
    item('cut', '剪切', async () => { await navigator.clipboard.writeText(copyText()); if (!workspace.accept(ticket)) throw new Error('选区已变化，请重新剪切。'); pasteText(''); }, !selected || !writable, 'cut', 'Ctrl+X'),
    item('paste', '粘贴', async () => { const text = await navigator.clipboard.readText(); if (!workspace.accept(ticket)) throw new Error('文档已变化，请重新粘贴。'); pasteText(text); }, !writable, 'paste', 'Ctrl+V'),
    item('select-all', '全选', () => { if (control) control.select(); else if (origin === 'source') source.dispatch({ selection: { anchor: 0, head: source.state.doc.length } }); else render.dispatch(render.state.tr.setSelection(TextSelection.between(render.state.doc.resolve(0), render.state.doc.resolve(render.state.doc.content.size)))); }, false, 'selectAll', 'Ctrl+A'),
    { id: 'sep-clipboard', label: '', separator: true },
    item('undo', '撤销', () => travel(false), !writable, 'undo', 'Ctrl+Z'), item('redo', '重做', () => travel(true), !writable, 'redo', 'Ctrl+Y'),
    { id: 'sep-format', label: '', separator: true },
    ...[['bold', '粗体', 'bold', 'Ctrl+B'], ['italic', '斜体', 'italic', 'Ctrl+I'], ['underline', '下划线', 'underline', 'Ctrl+U'], ['strike', '删除线', 'strike', ''], ['superscript', '上标', 'superscript', ''], ['subscript', '下标', 'subscript', ''], ['inline-code', '行内代码', 'inlineCode', ''], ['link', '链接…', 'link', 'Ctrl+K']]
      .map(([id, label, glyph, accelerator]) => item(id, label, () => $(id).click(), !writable || !!control || (origin === 'source' && !selected), glyph as Icon, accelerator)),
    { id: 'insert', label: '插入', icon: 'plus', disabled: !writable || !!control, children: [
      ...[['table', '表格…', 'table'], ['image', '图片…', 'image'], ['code-block', '代码块…', 'codeBlock'], ['rule', '分隔线', 'rule'], ['quote', '引用', 'quote'], ['bullet', '无序列表', 'listBullet'], ['ordered', '有序列表', 'listOrdered'], ['task', '任务清单', 'task']]
        .map(([id, label, glyph]) => item(id, label, () => $(id).click(), false, glyph as Icon)),
      { id: 'sub-insert-sep', label: '', separator: true },
      item('insert-mermaid', 'Mermaid 图', () => insertSpecial('mermaid'), false, 'split'),
      item('insert-paragraph', '下方新增段落', () => insertFollowingParagraph(), false, 'arrowDown'),
    ] },
    { id: 'mark-color', label: '文字', icon: 'color', disabled: !writable || !!control || (origin === 'source' && !selected), children: [
      item('apply-color', '应用预选文字颜色', () => markActive(schema.marks.color, undefined, colorControls.color.value()), false, colorControls.color.value() as Icon),
      { id: 'choose-color', label: '选择文字颜色', colorPicker: { value: colorControls.color.value(), change: value => run(() => colorControls.color.update(value))() } },
      { id: 'sep-color-presets', label: '', separator: true },
      ...[['#e5484d', '红色'], ['#3e63dd', '蓝色'], ['#30a46c', '绿色']].map(([color, label]) => item(`color-${color}`, label, () => { colorControls.color.update(color); markActive(schema.marks.color, undefined, color); }, false, color as Icon)),
      { id: 'sep-clear-color', label: '', separator: true }, item('clear-color', '恢复默认文字颜色', () => markActive(schema.marks.color, undefined, null), false, 'color'),
    ] },
    { id: 'mark-bg', label: '高亮', icon: 'highlight', disabled: !writable || !!control || (origin === 'source' && !selected), children: [
      item('apply-highlight', '应用预选高亮', () => markActive(schema.marks.bg, undefined, colorControls.bg.value()), false, colorControls.bg.value() as Icon),
      { id: 'choose-highlight', label: '选择高亮颜色', colorPicker: { value: colorControls.bg.value(), change: value => run(() => colorControls.bg.update(value))() } },
      { id: 'sep-bg-presets', label: '', separator: true },
      ...[['#fff3b0', '黄色'], ['#cfe8ff', '蓝色'], ['#d9f2e0', '绿色']].map(([bg, label]) => item(`bg-${bg}`, label, () => { colorControls.bg.update(bg); markActive(schema.marks.bg, undefined, bg); }, false, bg as Icon)),
      { id: 'sep-clear-highlight', label: '', separator: true }, item('clear-highlight', '清除高亮', () => markActive(schema.marks.bg, undefined, null), false, 'highlight'),
    ] },
    { id: 'mark-size', label: '字号', icon: 'fontSize', disabled: !writable || !!control || (origin === 'source' && !selected), children: ['0.85em', '1.25em', '1.5em'].map(size => item(`size-${size}`, size, () => markActive(schema.marks.size, { size }), false, 'fontSize')) },
  ];
  const cell = (event.target as Element).closest<HTMLElement>('[data-cell]');
  if (cell) {
    const id = cell.dataset.cell!;
    items.push({ id: 'sep-cell', label: '', separator: true });
    items.push(...[
      ['row-above', '上方插入行', 'up', () => insertRow(doc.model, id, 0)], ['row-below', '下方插入行', 'down', () => insertRow(doc.model, id, 1)], ['row-remove', '删除行', 'trash', () => removeRow(doc.model, id)],
      ['column-before', '左侧插入列', 'chevronUp', () => insertColumn(doc.model, id, 0)], ['column-after', '右侧插入列', 'chevronDown', () => insertColumn(doc.model, id, 1)], ['column-remove', '删除列', 'trash', () => removeColumn(doc.model, id)],
    ].map(([id, label, glyph, patch]) => item(String(id), String(label), () => structural((patch as () => Patch)(), undefined, 'render'), !writable, glyph as Icon)));
  }
  const opaque = (event.target as Element).closest<HTMLElement>('.opaque[data-block]');
  if (opaque) items.push(item('delete-block', '删除当前块', () => structural(deleteBlock(doc.model, opaque.dataset.block!), undefined, 'render'), !writable, 'trash'));
  editorContext.open(items, event.clientX, event.clientY);
}
source.dom.addEventListener('contextmenu', event => openEditorContext(event, 'source'));
render.dom.addEventListener('contextmenu', event => openEditorContext(event, 'render'));
for (const element of [source.dom, render.dom]) element.addEventListener('mousedown', event => {
  if (event.button !== 2) return;
  const control = (event.target as Element).closest<HTMLInputElement | HTMLTextAreaElement>('.inline-editor input, .inline-editor textarea');
  const selected = control ? control.selectionStart !== control.selectionEnd : element === source.dom ? !source.state.selection.main.empty : !render.state.selection.empty;
  if (selected) event.preventDefault();
}, true);
$('window-title').addEventListener('contextmenu', event => { event.preventDefault(); if (workspace.active) openTabContext(workspace.activeId, event.clientX, event.clientY); });
setupMenus(); setupTooltips(); await setupWindowControls(error);
function searchOptions() {
  return {
    query: $<HTMLInputElement>('find').value,
    regex: $<HTMLInputElement>('find-regex').checked,
    caseSensitive: $<HTMLInputElement>('find-case').checked,
    wholeWord: $<HTMLInputElement>('find-word').checked,
  };
}
function updateFind(next = false) { $('find-result').textContent = find(render, searchOptions(), next); }
$<HTMLInputElement>('find').oninput = () => updateFind();
for (const id of ['find-regex', 'find-case', 'find-word']) $<HTMLInputElement>(id).onchange = () => updateFind();
document.addEventListener('keydown', event => {
  if ($<HTMLDialogElement>('math-dialog').open) return;
  if (document.querySelector('#settings-dialog[open], #help-dialog[open]')) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (closestOf(event.target, '.inline-editor') && ['b', 'i', 'z', 'y', 'k', '1', '2', '3', '4', '5', '6'].includes(key)) return;
  if (!workspace.active && !['n', 'o'].includes(key)) { event.preventDefault(); return; }
  if (key === 'tab') { event.preventDefault(); action(() => cycleTab(event.shiftKey ? -1 : 1)); }
  else if (key === 'w') { event.preventDefault(); action(async () => { await closeTab(workspace.activeId); }); }
  else if (key === 'o' && event.shiftKey) { event.preventDefault(); toggleOutline(); }
  else if (key === 'r' && event.shiftKey) { event.preventDefault(); action(() => { if (!workspace.active.composition) schedulePreview(0, true); }); }
  else if (key === 'v' && event.shiftKey) { event.preventDefault(); action(switchMode); }
  else if (key === 'f') { event.preventDefault(); $('search-bar').hidden = false; $<HTMLInputElement>('find').focus(); }
  else if (key === 'h') { event.preventDefault(); if (!workspace.active.readOnly) { $('search-bar').hidden = false; $<HTMLInputElement>('replace').focus(); } }
  else if (workspace.active.readOnly && ['b', 'i', 'z', 'y', 'k', '1', '2', '3', '4', '5', '6'].includes(key)) event.preventDefault();
  else if (!$<HTMLDialogElement>('dialog').open && !$<HTMLDialogElement>('pdf-dialog').open && (document.activeElement?.closest('.cm-editor, .ProseMirror') || document.activeElement === document.body) && (key === 'b' || key === 'i' || key === 'k' || /^[1-6]$/.test(key))) {
    event.preventDefault(); action(() => key === 'b' ? boldActive() : key === 'i' ? markActive(schema.marks.em) : key === 'k' ? openLinkDialog() : headingActive(Number(key)));
  }
  else if (key === 's') { event.preventDefault(); if (document.activeElement?.closest('.inline-editor')) (document.activeElement as HTMLElement).blur(); action(async () => { await saveDocument(workspace.active, event.shiftKey); }); }
  else if (key === 'n') { event.preventDefault(); $( 'new').click(); }
  else if (key === 'o') { event.preventDefault(); $( 'open').click(); }
}, true);
$<HTMLInputElement>('find').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); updateFind(true); } else if (event.key === 'Escape') $('find-close').click(); };
// 非模态弹窗不响应 Esc（浏览器只对模态弹窗派发 cancel），这里统一补上取消语义。
document.addEventListener('keydown', event => {
  if (closestOf(event.target, '#settings-shortcuts input')) return;
  if ($<HTMLDialogElement>('math-dialog').open && event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); cancelMathDraft(); return; }
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (!dialog) return;
  event.preventDefault();
  if (typeof dialog.oncancel === 'function') { dialog.dispatchEvent(new Event('cancel')); return; }
  const target = dialog.dataset.cancel;
  if (target && $(target)) $(target).click(); else closeFloating(dialog);
}, true);
// S-35：专注模式的退出入口。
// 不用捕获阶段的 keydown：那会在 CodeMirror 之前拦截按键，破坏输入法组合流水线（原生 IME 验收会失败）。
// 改为在窗口右下角显示一个悬浮出口按钮；F11 仍由可自定义快捷键统一入口处理。
// S-47：可自定义快捷键的统一入口。带 Ctrl / Alt / Meta 的组合键在编辑区同样生效，
// 只有无修饰键的绑定才在输入位置跳过，避免影响正常打字。
document.addEventListener('keydown', event => {
  if ($<HTMLDialogElement>('math-dialog').open) return;
  if (document.querySelector('#settings-dialog[open], #help-dialog[open]')) return;
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  for (const command of shortcutCommands) {
    const binding = shortcutOf(command.id);
    if (!binding || !matchShortcut(binding, event)) continue;
    const composed = /ctrl|alt|meta|cmd/i.test(binding);
    if (typing && !composed) continue;
    // 目标元素存在时走元素（保持与按钮一致的禁用判断），否则走统一命令分发。
    const element = document.getElementById(command.id) as HTMLButtonElement | null;
    if (element && element.disabled) continue;
    event.preventDefault();
    if (element) element.click(); else runCommand(command.id);
    return;
  }
});
const splitControl = divider($('panes'), $('divider'), { initial: settings().split, persist: ratio => { void saveSettings({ split: ratio }); } });
scrollSync = new ScrollSync(() => workspace.active, render, source, () => !!previewTicket && workspace.accept(previewTicket));
const refreshTheme = await setupTheme($<HTMLSelectElement>('theme'), dark => {
  source.dispatch({ effects: theme.reconfigure(CMView.theme({ '&': { color: 'var(--text)', backgroundColor: 'var(--surface)' }, '.cm-gutters': { color: 'var(--muted)', backgroundColor: 'var(--soft)', borderColor: 'var(--border)' }, '.cm-cursor': { borderLeftColor: 'var(--text)' }, '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' } }, { dark })) });
  setDiagramTheme(dark);
  if (workspace.active && !workspace.active.composition) applyPreview(workspace.active.ticket('theme'));
}, error);
setupDefaultMode($<HTMLSelectElement>('default-mode'), error);
// S-45：正文与等宽字体、字号与行距写入 CSS 变量，两栏与导出同步生效。
function applyTypography() {
  const current = settings();
  const root = document.documentElement.style;
  root.setProperty('--font-body', current.font_body || '"Microsoft YaHei","Segoe UI",sans-serif');
  root.setProperty('--font-mono', current.font_mono || 'Consolas,"Microsoft YaHei",monospace');
  root.setProperty('--font-size', `${current.font_size}px`);
  root.setProperty('--line-height', String(current.line_height));
}
applyTypography();
// S-45：字体列表来自系统可用字体，取不到时回落到内置候选。
function fontChoices(mono: boolean): string[] {
  const fallback = mono
    ? ['Consolas', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', 'Courier New', 'monospace']
    : ['Microsoft YaHei', 'Segoe UI', 'SimSun', 'KaiTi', 'Noto Sans SC', 'sans-serif'];
  try {
    const available = Array.from(document.fonts).map(face => face.family.replace(/^["']|["']$/g, ''));
    return Array.from(new Set([...available, ...fallback])).slice(0, 60);
  } catch { return fallback; }
}
function setupTypographyControls() {
  const current = settings();
  for (const [id, mono, value] of [['font-body', false, current.font_body], ['font-mono', true, current.font_mono]] as [string, boolean, string][]) {
    const select = $<HTMLSelectElement>(id);
    select.replaceChildren(...['', ...fontChoices(mono)].map(family => {
      const option = document.createElement('option'); option.value = family; option.textContent = family || '默认';
      option.selected = family === value; return option;
    }));
    select.onchange = () => action(async () => {
      await saveSettings(id === 'font-body' ? { font_body: select.value } : { font_mono: select.value });
      applyTypography();
    });
  }
  const size = $<HTMLInputElement>('font-size-input'), lineHeight = $<HTMLInputElement>('line-height');
  size.value = String(current.font_size); lineHeight.value = String(current.line_height);
  size.onchange = () => action(async () => { await saveSettings({ font_size: Number(size.value) }); applyTypography(); });
  lineHeight.onchange = () => action(async () => { await saveSettings({ line_height: Number(lineHeight.value) }); applyTypography(); });
  // S-43：保存前保留的 `.bak` 份数，0 表示关闭。
  const backupCount = $<HTMLInputElement>('backup-count');
  backupCount.value = String(current.backup_count);
  backupCount.onchange = () => action(async () => {
    await saveSettings({ backup_count: Number(backupCount.value) });
    $('status-text').textContent = Number(backupCount.value) ? `保存前保留 ${Number(backupCount.value)} 份 .bak` : '已关闭保存前备份';
  });
  // 打开配置目录，便于手工改快捷键与字体配置。
  $('open-settings-dir').onclick = () => action(async () => {
    if (!isTauri()) throw new Error('打开配置目录需要桌面应用。');
    const directory = await invoke<string>('open_settings_directory');
    $('status-text').textContent = '已打开配置目录';
    $('status-text').title = directory;
  });
  $('shortcut-open').onclick = () => action(() => openShortcutDialog());
  // S-41：文件关联注册入口，显示当前状态；注册结果写入状态栏。
  const association = $('associate-md');
  if (association) association.onclick = () => action(async () => {
    if (!isTauri()) throw new Error('文件关联需要桌面应用。');
    const message = await invoke<string>('register_file_association');
    $('status-text').textContent = message;
    association.textContent = '重新注册 .md 关联';
  });
}
// S-47：快捷键在配置文件中自定义；对话框只做查看与重绑，不写额外格式。
function openShortcutDialog() {
  const dialog = $<HTMLDialogElement>('shortcut-dialog');
  const body = $('shortcut-list');
  if (!dialog || !body) throw new Error(`缺少快捷键弹窗节点：dialog=${!!dialog} list=${!!body}`);
  const current = settings();
  body.replaceChildren(...shortcutCommands.map(command => {
    const row = document.createElement('div'); row.className = 'shortcut-row';
    const label = document.createElement('label'); label.textContent = command.label; label.htmlFor = `shortcut-${command.id}`;
    const input = document.createElement('input'); input.id = `shortcut-${command.id}`; input.value = current.shortcuts[command.id] ?? command.fallback;
    input.placeholder = command.fallback || '未绑定'; input.setAttribute('aria-label', `${command.label} 快捷键`);
    input.onkeydown = event => {
      event.preventDefault();
      if (event.key === 'Escape') { input.value = ''; return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const parts: string[] = [];
      if (event.ctrlKey) parts.push('Ctrl');
      if (event.shiftKey) parts.push('Shift');
      if (event.altKey) parts.push('Alt');
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      input.value = parts.join('+');
    };
    row.append(label, input); return row;
  }));
  $('shortcut-save').onclick = () => action(async () => {
    const shortcuts: Record<string, string> = {};
    for (const command of shortcutCommands) {
      const value = $<HTMLInputElement>(`shortcut-${command.id}`).value.trim();
      if (value && value !== command.fallback) shortcuts[command.id] = value;
    }
    await saveSettings({ shortcuts });
    renderMenuShortcuts();
    closeFloating(dialog);
    $('status-text').textContent = '快捷键已更新';
  });
  openFloating(dialog);
}
// 菜单里的快捷键提示随配置更新。
function renderMenuShortcuts() {
  const map: [string, string][] = [['new', 'new'], ['open', 'open'], ['save', 'save'], ['save-as', 'save-as'], ['close-tab', 'close-tab'], ['find-open', 'find-open'], ['replace-open', 'replace-open'], ['mode-toggle', 'mode-toggle'], ['outline-toggle', 'outline-toggle'], ['goto-line', 'goto-line'], ['refresh', 'refresh'], ['focus-toggle', 'focus-mode'], ['underline', 'underline'], ['paper-toggle', 'paper-toggle']];
  for (const [elementId, command] of map) {
    const button = document.getElementById(elementId);
    const kbd = button?.querySelector('kbd');
    if (kbd) kbd.textContent = shortcutOf(command);
  }
}
// 只记录文件路径和侧栏状态；未保存正文仍由独立的恢复快照管理。
function rememberWorkspace(force = false): Promise<void> {
  if (!isTauri() || restoringWorkspace || (closing && !force)) return Promise.resolve();
  const files = [...workspace.documents.values()].filter(doc => !doc.welcome && doc.path).map(doc => doc.path!);
  const last_session = { folder: filesPanel.root, files, active_file: workspace.active?.path ?? null, sidebar_visible: !$('outline-panel').hidden, sidebar_tab: filesPanel.fileView ? 'files' as const : 'outline' as const };
  if (!force && JSON.stringify(last_session) === JSON.stringify(settings().last_session)) return Promise.resolve();
  return saveSettings({ last_session });
}
async function restoreWorkspace() {
  const last = settings().last_session, recoveredActive = workspace.activeId;
  if (isTauri() && last) {
    if (last.folder) {
      try { await filesPanel.openFolder(last.folder, false); }
      catch (reason) { workspaceRestoreErrors.push(`上次文件夹无法恢复：${last.folder}（${String(reason)}）`); }
    }
    for (const path of last.files) {
      try { await openPath(path, true); }
      catch (reason) { workspaceRestoreErrors.push(`上次文件无法恢复：${path}（${String(reason)}）`); }
    }
    const ranks = new Map(last.files.map((path, index) => [pathKey(path), index]));
    workspace.documents = new Map([...workspace.documents].sort(([, a], [, b]) => (ranks.get(pathKey(a.path ?? '')) ?? Infinity) - (ranks.get(pathKey(b.path ?? '')) ?? Infinity)));
    const active = [...workspace.documents.values()].find(doc => samePath(doc.path, last.active_file));
    if (active) workspace.switchTo(active.id);
    else if (!last.active_file && workspace.documents.has(recoveredActive)) workspace.switchTo(recoveredActive);
    filesPanel.select(last.sidebar_tab === 'files'); toggleOutline(!last.sidebar_visible); showDocument();
  }
  restoringWorkspace = false;
  await rememberWorkspace(true).catch(reason => workspaceRestoreErrors.push(`保存启动状态失败：${String(reason)}`));
}
async function updateRecentFolder(path: string) {
  await saveSettings({ recent_folders: [path, ...settings().recent_folders.filter(item => !samePath(item, path))].slice(0, RECENT_LIMIT) });
  renderRecent();
}
// S-42：最近打开列表；文件已不存在时明确提示，不静默失败。
async function updateRecent(path: string | null) {
  if (!path) return;
  const next = [path, ...settings().recent.filter(item => !samePath(item, path))].slice(0, RECENT_LIMIT);
  await saveSettings({ recent: next });
  renderRecent();
}
function renderRecent() {
  renderRecentFolders();
  const list = $('recent-list'), trigger = $<HTMLButtonElement>('recent-menu');
  if (!list) { console.error('renderRecent: 缺少 #recent-list'); return; }
  if (!trigger) { console.error('renderRecent: 缺少 #recent-menu'); return; }
  const recent = settings().recent;
  trigger.hidden = recent.length === 0;
  list.replaceChildren(...recent.map((path, index) => {
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitem'); button.title = path;
    const number = document.createElement('span'), label = document.createElement('span');
    number.className = 'recent-number'; number.textContent = `${index + 1}.`;
    label.className = 'recent-name'; label.textContent = path.replace(/^.*[\\/]/, '');
    button.append(number, label);
    button.onclick = () => action(async () => {
      try { await openPath(path); }
      catch (reason) {
        await saveSettings({ recent: settings().recent.filter(item => item !== path) });
        renderRecent();
        throw new Error(`无法打开最近文件：${path}（${String(reason)}）`);
      }
    });
    return button;
  }));
  list.hidden = true;
}
function renderRecentFolders() {
  const list = $('recent-folder-list'), trigger = $<HTMLButtonElement>('recent-folder-menu');
  const recent = settings().recent_folders; trigger.hidden = recent.length === 0;
  list.replaceChildren(...recent.map((path, index) => {
    const button = document.createElement('button'), number = document.createElement('span'), label = document.createElement('span');
    button.setAttribute('role', 'menuitem'); button.title = path;
    number.className = 'recent-number'; number.textContent = `${index + 1}.`;
    label.className = 'recent-name'; label.textContent = path.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || path;
    button.append(number, label);
    button.onclick = () => action(async () => {
      try { await filesPanel.openFolder(path); }
      catch (reason) {
        await saveSettings({ recent_folders: settings().recent_folders.filter(item => !samePath(item, path)) });
        renderRecent(); throw new Error(`无法打开最近文件夹：${path}（${String(reason)}）`);
      }
    });
    return button;
  }));
  list.hidden = true;
}
// I-4：默认启动模式决定初始（及新建空白页）的编辑 / 只读状态。
if (workspace.active && settings().default_mode === 'read') workspace.active.readOnly = true;
if (isTauri()) {
  autosaveTimer = startAutosave(workspace, saveQueue, () => status());
  const appWindow = getCurrentWindow();
  await appWindow.onDragDropEvent(event => {
    const payload = event.payload;
    if (payload.type !== 'drop') return;
    const paths = payload.paths;
    const markdown = paths.filter(path => /\.(md|markdown|txt)$/i.test(path));
    const images = paths.filter(path => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path));
    action(async () => {
      for (const path of markdown) await openPath(path);
      if (images.length) await insertImagesFromPaths(images, { x: payload.position.x / devicePixelRatio, y: payload.position.y / devicePixelRatio });
    });
  });
  await appWindow.onCloseRequested(event => {
    flushInline();
    if (allowClose) return;
    event.preventDefault();
    void action(async () => { await closeWindow(); });
  });
}
toggleOutline(false);
showDocument();
await restoreWorkspace();
if (recoveryRead.errors.length) error(recoveryRead.errors.join('\n'));
if (isTauri()) recovery.start();
if (!settingsRead) error('读取配置失败，已使用默认主题与启动模式。');
// S-41：双击关联文件启动时由 Rust 把路径放进窗口标题；这里读取并打开，随后恢复正常标题。
if (isTauri()) {
  const current = getCurrentWindow();
  // S-41：文件路径由 Rust 侧排队，这里主动取走，避免前端监听就绪晚于第二次启动。
  const consumeLaunch = async () => {
    try {
      for (let guard = 0; guard < 10; guard++) {
        const path = await invoke<string | null>('take_launch_path');
        if (!path) return;
        if (samePath(path, workspace.active?.path ?? null)) continue;
        await openPath(path);
        status();
      }
      error(new Error('待打开文件过多，已忽略其余请求。'));
    } catch (reason) { error(reason); }
  };
  await action(consumeLaunch);
  // 第二次启动：插件唤醒窗口并排队路径；拿到焦点后立即取走。
  try {
    await current.onFocusChanged(({ payload: focused }) => { if (focused) void action(consumeLaunch); });
    await current.onResized(() => void action(consumeLaunch));
  } catch (reason) { error(reason); }
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('single-instance', () => { void action(consumeLaunch); });
  } catch (reason) { error(reason); }
}
// S-45/S-47/S-42：字体与快捷键控件、最近打开列表、菜单快捷键提示。
try {
  setupTypographyControls();
  setupPreferences({ open: openFloating, close: closeFloating, fonts: fontChoices, applied: () => {
    $<HTMLSelectElement>('theme').value = settings().theme;
    $<HTMLSelectElement>('default-mode').value = settings().default_mode;
    applyTypography(); setupTypographyControls(); splitControl.resize(settings().split); paper.refresh(); sidebar.refresh(); refreshTheme(); renderMenuShortcuts();
    if (sourceDefault !== settings().show_source) {
      sourceDefault=settings().show_source;
      toggleSourceVisibility(sourceDefault);
    }
    $('status-text').textContent = '设置已保存';
  } });
  renderRecent();
  renderMenuShortcuts();
} catch (reason) { console.error('设置界面初始化失败', reason); throw reason; }
// 原型验收桥：只暴露当前应用内的文档状态与统一 IPC 入口，不参与导出页面。
Object.assign(window, { mdre: { workspace, source, render, recovery, schedulePreview, exportPdf, exportHtml, openDraft, openFloating, closeFloating, showDocument, staticHtml, switchTo, resolveImage, saveQueue, openPath, saveDocument, saveTo, closeTab, newBlankTab, cycleTab, autosaveNow, closeWindow, invoke, closeRequest: () => getCurrentWindow().close(), get allowClose() { return allowClose; }, get composing() { return compositionBase !== null || !!workspace.active?.composition; }, filesPanel, paper, sidebar, get queuedRefresh() { return queuedRefresh; } } });
if (workspaceRestoreErrors.length) error(workspaceRestoreErrors.join('\n'));





















