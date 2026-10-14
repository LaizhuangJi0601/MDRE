import { invoke, isTauri } from '@tauri-apps/api/core';
import { icon } from './icons';

type Entry = { name: string; path: string; directory: boolean; editable: boolean; icon: string | null };
export function setupFiles(options: { open: (path: string) => Promise<unknown>; activate: (id: string) => void; fail: (reason: unknown) => void; reveal: () => void; opened: (path: string) => Promise<void>; changed: () => void }) {
  const list = document.getElementById('file-list')!, pathLabel = document.getElementById('folder-path')!;
  const files = document.getElementById('files-view')!, outline = document.getElementById('outline-view')!;
  const fileTab = document.getElementById('sidebar-files')!, outlineTab = document.getElementById('sidebar-outline')!;
  let root: string | null = null, loading = 0;
  const select = (showFiles: boolean) => {
    files.hidden = !showFiles; outline.hidden = showFiles;
    fileTab.setAttribute('aria-selected', String(showFiles)); outlineTab.setAttribute('aria-selected', String(!showFiles));
    options.changed();
  };
  fileTab.onclick = () => select(true); outlineTab.onclick = () => select(false);
  async function children(path: string, container: HTMLElement) {
    const entries = await invoke<Entry[]>('list_directory', { path });
    const nodes = entries.map(entry => {
      const wrapper = document.createElement('div'), row = document.createElement('button'); row.className = 'file-row'; row.type = 'button'; row.title = entry.path;
      const glyph = document.createElement('span'); glyph.className = 'file-glyph';
      if (entry.icon) { const image = document.createElement('img'); image.src = entry.icon; image.alt = ''; glyph.append(image); }
      else glyph.innerHTML = icon(entry.directory ? 'openFolder' : 'paper');
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name;
      row.append(glyph, name); wrapper.append(row);
      if (entry.directory) {
        row.classList.add('folder-row'); row.setAttribute('aria-expanded', 'false');
        const nested = document.createElement('div'); nested.className = 'file-children'; nested.hidden = true; wrapper.append(nested);
        let loaded = false;
        row.onclick = async () => {
          row.disabled = true;
          try { if (!loaded) { await children(entry.path, nested); loaded = true; } nested.hidden = !nested.hidden; row.setAttribute('aria-expanded', String(!nested.hidden)); }
          catch (reason) { options.fail(reason); } finally { row.disabled = false; }
        };
      } else { row.disabled = !entry.editable; row.onclick = () => { void options.open(entry.path).catch(options.fail); }; }
      return wrapper;
    });
    if (!nodes.length) { const empty = document.createElement('p'); empty.className = 'dialog-hint'; empty.textContent = '此文件夹为空'; nodes.push(empty); }
    container.replaceChildren(...nodes);
  }
  async function openFolder(path?: string, remember = true) {
    if (!isTauri()) throw new Error('打开文件夹需要桌面应用。');
    const chosen = path ?? await invoke<string | null>('pick_folder'); if (!chosen) return;
    const request = ++loading, temporary = document.createElement('div');
    await children(chosen, temporary); if (request !== loading) return;
    root = chosen; pathLabel.textContent = chosen; pathLabel.title = chosen; list.replaceChildren(...temporary.childNodes);
    select(true); options.reveal();
    if (remember) await options.opened(chosen);
  }
  document.getElementById('folder-open')!.onclick = () => { void openFolder().catch(options.fail); };
  document.getElementById('folder-refresh')!.onclick = () => { if (root) void openFolder(root, false).catch(options.fail); };
  select(false);
  return { openFolder, select, get root() { return root; }, get fileView() { return !files.hidden; }, sync(documents: { id: string; title: string; path: string | null; welcome: boolean }[], active: string) {
    const opened = document.getElementById('open-documents')!;
    const scrollTop = opened.scrollTop;
    opened.replaceChildren(...documents.filter(doc => !doc.welcome).map(doc => {
      const row = document.createElement('button'); row.className = 'file-row'; row.classList.toggle('active', doc.id === active);
      row.innerHTML = icon('markdown'); const name = document.createElement('span'); name.className = 'file-name'; name.textContent = doc.title; row.append(name);
      row.title = doc.path ?? doc.title; row.onclick = () => options.activate(doc.id); return row;
    }));
    opened.scrollTop = scrollTop;
  } };
}
