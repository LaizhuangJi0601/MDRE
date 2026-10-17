// MDRE 0.2.5：图片管理面板（桌面版插入第三个侧栏页签；插件版新建“图片管理/大纲导航”页签）。
import { NodeSelection } from 'prosemirror-state';
import { collectImageReferences, type ImageReference } from '../../image-references';
import { documentHooks, env, type V025Env } from '../runtime';
import './images.css';

type Panel = {
  view: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  tab: HTMLButtonElement;
};

let started = false;
let panel: Panel | null = null;
let dirty = true;

export function initImages() {
  if (started) return;
  started = true;
  const api = env();
  panel = api.platform === 'plugin' ? setupPlugin() : setupDesktop();
  documentHooks.push((doc, kind) => {
    const active = env().workspace?.active;
    if (doc && active && doc !== active) return;
    if (kind === 'show' && panel) panel.list.scrollTop = 0;
    refresh();
  });
  refresh(true);
  installBridge();
}

function createTab(id: string, label: string, controls: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', controls);
  button.setAttribute('aria-selected', 'false');
  button.textContent = label;
  return button;
}

function setSelected(button: HTMLButtonElement | null, selected: boolean) {
  button?.setAttribute('aria-selected', String(selected));
}

function buildPanel(): Omit<Panel, 'tab'> {
  const view = document.createElement('div');
  view.id = 'images-view';
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', 'sidebar-images');
  view.hidden = true;
  const list = document.createElement('div');
  list.id = 'images-list';
  const empty = document.createElement('p');
  empty.id = 'images-empty';
  empty.className = 'dialog-hint';
  empty.textContent = '当前文档没有引用图片';
  empty.hidden = true;
  view.append(list, empty);
  return { view, list, empty };
}

function setupDesktop(): Panel {
  // 壳层里页签容器只有类名；补上约定的 id，便于脚本/样式按 #sidebar-tabs 定位。
  const tabs = document.getElementById('sidebar-tabs') ?? document.querySelector<HTMLElement>('.sidebar-tabs');
  if (!tabs) throw new Error('未找到侧栏页签容器。');
  if (!tabs.id) tabs.id = 'sidebar-tabs';
  const filesTab = document.getElementById('sidebar-files') as HTMLButtonElement | null;
  const outlineTab = document.getElementById('sidebar-outline') as HTMLButtonElement | null;
  const filesView = document.getElementById('files-view');
  const outlineView = document.getElementById('outline-view');
  const tab = createTab('sidebar-images', '图片管理', 'images-view');
  tabs.insertBefore(tab, outlineTab ?? null);
  const built = buildPanel();
  const parent = outlineView?.parentElement ?? tabs.parentElement;
  if (!parent) throw new Error('未找到侧栏容器。');
  parent.insertBefore(built.view, outlineView ?? null);
  const aside = document.getElementById('outline-panel');
  const select = (showImages: boolean) => {
    if (showImages) {
      if (filesView) filesView.hidden = true;
      if (outlineView) outlineView.hidden = true;
      built.view.hidden = false;
      setSelected(tab, true);
      setSelected(filesTab, false);
      setSelected(outlineTab, false);
      // 侧栏被收起时，点页签同时展开侧栏（复用既有的侧栏开关行为）。
      if (aside?.hidden) document.getElementById('outline-toggle')?.click();
      refresh(true);
      return;
    }
    built.view.hidden = true;
    setSelected(tab, false);
  };
  tab.addEventListener('click', () => select(true));
  filesTab?.addEventListener('click', () => select(false));
  outlineTab?.addEventListener('click', () => select(false));
  // 打开文件夹、恢复工作区等代码会直接切换文件列表/大纲视图；用观察器保证此时图片视图收起。
  const observer = new MutationObserver(() => {
    if (built.view.hidden) return;
    if ((filesView && !filesView.hidden) || (outlineView && !outlineView.hidden)) select(false);
  });
  if (filesView) observer.observe(filesView, { attributes: true, attributeFilter: ['hidden'] });
  if (outlineView) observer.observe(outlineView, { attributes: true, attributeFilter: ['hidden'] });
  return { ...built, tab };
}

function setupPlugin(): Panel {
  const aside = document.getElementById('outline-panel');
  if (!aside) throw new Error('未找到侧栏容器。');
  let outlineView = document.getElementById('outline-view');
  if (!outlineView) {
    const created = document.createElement('div');
    created.id = 'outline-view';
    created.setAttribute('role', 'tabpanel');
    created.setAttribute('aria-labelledby', 'sidebar-outline');
    const outlineHead = aside.querySelector<HTMLElement>('.outline-head');
    const outlineList = document.getElementById('outline-list');
    const outlineEmpty = document.getElementById('outline-empty');
    for (const node of [outlineHead, outlineList, outlineEmpty]) if (node) created.append(node);
    outlineView = created;
  }
  const resizer = document.getElementById('sidebar-resizer');
  if (!outlineView.parentElement) aside.insertBefore(outlineView, resizer ?? null);
  // 插件版侧栏原本只有大纲：新增页签后“图片管理”在大纲导航之前。
  let tabs = aside.querySelector<HTMLElement>('.sidebar-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.className = 'sidebar-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '侧栏内容');
    aside.insertBefore(tabs, outlineView);
  }
  if (!tabs.id) tabs.id = 'sidebar-tabs';
  let tab = document.getElementById('sidebar-images') as HTMLButtonElement | null;
  let outlineTab = document.getElementById('sidebar-outline') as HTMLButtonElement | null;
  if (!outlineTab) {
    outlineTab = createTab('sidebar-outline', '大纲导航', 'outline-view');
    tabs.append(outlineTab);
  }
  if (!tab) {
    tab = createTab('sidebar-images', '图片管理', 'images-view');
    tabs.insertBefore(tab, outlineTab);
  }
  const built = buildPanel();
  aside.insertBefore(built.view, outlineView.nextSibling);
  const select = (showImages: boolean) => {
    built.view.hidden = !showImages;
    outlineView.hidden = showImages;
    setSelected(tab, showImages);
    setSelected(outlineTab, !showImages);
    if (showImages) refresh(true);
  };
  tab.addEventListener('click', () => select(true));
  outlineTab.addEventListener('click', () => select(false));
  select(false);
  return { ...built, tab };
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? '未知错误');
}

function renderImagePositions(): number[] {
  const positions: number[] = [];
  try {
    env().render.state.doc.descendants((node: any, pos: number) => {
      if (node?.type?.name === 'image') positions.push(pos);
    });
  } catch { /* 渲染栏尚未就绪。 */ }
  return positions;
}

function jumpToImage(reference: ImageReference, index: number) {
  const api = env();
  const view = api.render;
  if (!view?.state?.doc) throw new Error('渲染栏尚未就绪。');
  const positions = renderImagePositions();
  const position = Number.isInteger(positions[index]) ? positions[index] : reference.pos;
  const node = Number.isInteger(position) ? view.state.doc.nodeAt(position) : null;
  if (!node || node.type?.name !== 'image') throw new Error('图片位置已变化，请刷新渲染后重试。');
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
  view.focus();
  const dom = view.nodeDOM(position);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center', inline: 'nearest' });
  api.message(`已定位图片 · ${reference.name}`);
}

function parentDirectoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

async function revealImage(reference: ImageReference) {
  const api = env();
  if (reference.kind === 'data') { api.message('内嵌图片没有所在目录，无法定位。'); return; }
  if (reference.kind === 'remote') { api.message('网络图片没有本地文件，无法定位。'); return; }
  if (!reference.absolutePath) { api.message('图片没有可定位的本地路径。'); return; }
  try {
    if (api.platform === 'plugin') await api.invoke('reveal_path', { path: reference.absolutePath });
    else await api.invoke('reveal_document', { path: reference.absolutePath });
    api.message(`已打开图片所在目录 · ${parentDirectoryOf(reference.absolutePath)}`);
  } catch (reason) {
    api.message(`无法打开图片所在目录：${reasonMessage(reason)}`);
  }
}

function createRow(reference: ImageReference, index: number): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'image-row';
  row.dataset.imageIndex = String(index);
  row.title = `${reference.name}\n${reference.displayPath}`;
  const name = document.createElement('span');
  name.className = 'image-name';
  name.textContent = reference.name;
  name.title = reference.name;
  const path = document.createElement('span');
  path.className = 'image-path';
  path.textContent = reference.displayPath;
  path.title = reference.displayPath;
  row.append(name, path);
  const jump = () => {
    try { jumpToImage(reference, index); }
    catch (reason) { env().message(`无法跳转图片位置：${reasonMessage(reason)}`); }
  };
  row.addEventListener('click', jump);
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
  });
  // 双击图片名称打开所在目录；单击仍保持“跳转到渲染位置”。
  name.addEventListener('dblclick', event => {
    event.preventDefault();
    event.stopPropagation();
    void revealImage(reference);
  });
  return row;
}

function refresh(force = false) {
  if (!panel) return;
  if (panel.view.hidden && !force) { dirty = true; return; }
  dirty = false;
  const doc = env().workspace?.active;
  const references = doc ? collectImageReferences(doc) : [];
  const scrollTop = panel.list.scrollTop;
  panel.list.replaceChildren(...references.map((reference, index) => createRow(reference, index)));
  panel.empty.hidden = references.length > 0;
  panel.list.hidden = references.length === 0;
  panel.list.scrollTop = scrollTop;
}

function installBridge() {
  const bridge = (window as unknown as { mdre?: Record<string, unknown> }).mdre;
  if (!bridge || typeof bridge !== 'object') return;
  bridge.imageReferences = (doc?: any) => collectImageReferences(doc ?? env().workspace?.active);
  bridge.refreshImagePanel = () => refresh(true);
  bridge.showImagePanel = () => panel?.tab.click();
  bridge.imagePanelDirty = () => dirty;
}
