import { convertFontSize } from './font-size';
import MarkdownIt from 'markdown-it';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { settings, saveSettings, shortcutCommands, type Settings } from '../persistence/settings';

// 帮助资源由构建工具从此目录导入，随程序离线打包。
const documents = import.meta.glob('../../docs/help/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const references = import.meta.glob('../../docs/licenses/*.{md,txt}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
type Options = { open: (dialog: HTMLDialogElement) => void; close: (dialog: HTMLDialogElement) => void; applied: () => void; fonts: (mono: boolean) => string[] };
export function setupPreferences(options: Options) {
  const dialog = document.createElement('dialog'); dialog.id = 'settings-dialog'; dialog.dataset.cancel = 'settings-cancel';
  dialog.innerHTML = `<h3>设置</h3><form id="settings-form">
    <fieldset><legend>外观与阅读</legend><div class="settings-grid">
      <label>颜色主题<select name="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>默认启动模式<select name="default_mode"><option value="edit">编辑模式</option><option value="read">阅读模式</option></select></label>
      <label>代码块主题<select name="code_theme"><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>正文字体<select name="font_body"></select></label><label>等宽字体<select name="font_mono"></select></label>
      <label>字号单位<select name="font_unit"><option value="px">px</option><option value="em">em</option></select></label>
      <label>正文字号<input name="font_size" type="number" min="8" max="32" step="any" required></label>
      <label>编辑功能区显示状态<select name="toolbar_visible"><option value="true">显示</option><option value="false">隐藏</option></select></label>
      <label>行距<input name="line_height" type="number" min="1" max="3" step="0.05" required></label>
    </div></fieldset>
    <fieldset><legend>纸张与图片</legend><div class="settings-grid">
      <label>默认 A4 纸张<select name="paper_enabled"><option value="false">关闭（随窗口排版）</option><option value="true">开启</option></select></label>
      <label>A4 排版方式<select name="paper_layout"><option value="continuous">连续排版</option><option value="paged">分页排版</option></select></label>
      <label>A4 正文对齐<select name="paper_align"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></label>
      <label>默认图片显示<select name="image_layout"><option value="fit">适应正文宽度</option><option value="natural">原始尺寸（超宽缩小）</option></select></label>
    </div></fieldset>
    <fieldset><legend>侧栏导航</legend><div class="settings-grid">
      <label>默认侧栏状态<select name="sidebar_visible"><option value="true">显示</option><option value="false">收起</option></select></label>
      <label>侧栏宽度（px）<input name="sidebar_width" type="number" min="180" max="420" step="1" required></label>
      <label>默认大纲状态<select name="outline_collapsed"><option value="false">展开</option><option value="true">折叠</option></select></label>
      <label data-desktop-setting>文件列表区域（%）<input name="file_list_ratio" type="number" min="20" max="80" step="1" required></label>
    </div><p class="dialog-hint">拖动侧栏右边缘可调整宽度；大纲标题旁的箭头用于折叠和展开。</p></fieldset>
    <fieldset><legend>编辑与文件</legend><div class="settings-grid">
      <label>默认显示源码栏<select name="show_source"><option value="false">关闭（仅显示富文本）</option><option value="true">开启（源码与富文本分栏）</option></select></label>
      <label>源码栏宽度（%）<input name="split" type="number" min="20" max="80" step="1" required></label>
      <label>保存前备份份数<input name="backup_count" type="number" min="0" max="20" step="1" required></label>
    </div>
    <div class="settings-tools"><button type="button" id="settings-directory">打开配置目录</button><button type="button" id="settings-association">注册 .md 文件关联</button></div><p id="settings-tool-status" role="status"></p></fieldset>
    <fieldset><legend>快捷键</legend><p class="dialog-hint">点入后按组合键；Esc 恢复该项默认值。</p><div id="settings-shortcuts" class="shortcut-list"></div></fieldset>
  </form><div id="settings-error" role="alert"></div><div class="dialog-actions"><button id="settings-help" type="button">帮助</button><button id="settings-cancel">取消</button><button id="settings-save" class="primary-button">保存设置</button></div>`;
  document.body.append(dialog);
  if (!document.getElementById('sidebar-files')) { dialog.querySelectorAll<HTMLElement>('[data-desktop-setting], .settings-tools, #settings-tool-status').forEach(element => element.hidden = true); }
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  let fontUnit: 'px' | 'em' = 'px';
  const sizeBounds = () => { const size = field('font_size') as HTMLInputElement; size.min = fontUnit === 'px' ? '8' : '0.5'; size.max = fontUnit === 'px' ? '32' : '2'; };
  field('font_unit').onchange = () => { const next = field('font_unit').value as 'px' | 'em'; field('font_size').value = String(convertFontSize(Number(field('font_size').value), fontUnit, next)); fontUnit = next; sizeBounds(); };
  const cancel = dialog.querySelector<HTMLButtonElement>('#settings-cancel')!;
  cancel.onclick = () => options.close(dialog);
  form.onsubmit = event => { event.preventDefault(); dialog.querySelector<HTMLButtonElement>('#settings-save')!.click(); };
  document.getElementById('settings-open')!.onclick = () => {
    const saved = settings(), view = saved.last_view;
    const current = view ? { ...saved, paper_enabled: view.paper, show_source: view.source, sidebar_visible: view.sidebar, toolbar_visible: view.toolbar } : saved;
    for (const [name, mono] of [['font_body', false], ['font_mono', true]] as const) {
      const select = field(name) as HTMLSelectElement;
      select.replaceChildren(...[...new Set(['', current[name], ...options.fonts(mono)])].map(value => new Option(value || '默认', value)));
    }
    for (const name of ['font_unit', 'sidebar_visible', 'toolbar_visible', 'theme', 'code_theme', 'default_mode', 'show_source', 'font_body', 'font_mono', 'font_size', 'line_height', 'split', 'backup_count', 'paper_enabled', 'paper_layout', 'paper_align', 'image_layout', 'sidebar_width', 'file_list_ratio', 'outline_collapsed'] as const) field(name).value = String(current[name]);
    fontUnit = current.font_unit; sizeBounds();
    dialog.querySelector('#settings-error')!.textContent = ''; dialog.querySelector('#settings-tool-status')!.textContent = '';
    dialog.querySelector('#settings-shortcuts')!.replaceChildren(...shortcutCommands.map(command => {
      const row = document.createElement('label'); row.className = 'shortcut-row'; row.append(command.label);
      const input = document.createElement('input'); input.dataset.shortcut = command.id; input.value = current.shortcuts[command.id] ?? command.fallback;
      input.setAttribute('aria-label', `${command.label} 快捷键`); input.maxLength = 40;
      input.onkeydown = event => {
        if (event.isComposing || event.key === 'Tab') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { input.value = ''; return; }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        input.value = [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.metaKey ? ['Meta'] : []), event.key.length === 1 ? event.key.toUpperCase() : event.key].join('+');
      };
      row.append(input); return row;
    }));
    options.open(dialog); field('theme').focus({ preventScroll: true }); form.scrollTop = 0;
    dialog.querySelector<HTMLElement>('.dialog-content')?.scrollTo(0, 0);
  };
  dialog.querySelector<HTMLButtonElement>('#settings-save')!.onclick = async () => {
    if (!form.reportValidity()) return;
    const button = dialog.querySelector<HTMLButtonElement>('#settings-save')!; button.disabled = cancel.disabled = true;
    const patch: Partial<Settings> = {
      font_unit: field('font_unit').value as Settings['font_unit'], sidebar_visible: field('sidebar_visible').value === 'true', toolbar_visible: field('toolbar_visible').value === 'true',
      theme: field('theme').value as Settings['theme'], code_theme: field('code_theme').value as Settings['code_theme'], default_mode: field('default_mode').value as Settings['default_mode'], font_body: field('font_body').value, font_mono: field('font_mono').value,
      paper_enabled: field('paper_enabled').value === 'true', paper_layout: field('paper_layout').value as Settings['paper_layout'], paper_align: field('paper_align').value as Settings['paper_align'], image_layout: field('image_layout').value as Settings['image_layout'], sidebar_width: Number(field('sidebar_width').value), file_list_ratio: Number(field('file_list_ratio').value), outline_collapsed: field('outline_collapsed').value === 'true',
      show_source: field('show_source').value === 'true', font_size: Number(field('font_size').value), line_height: Number(field('line_height').value), split: Number(field('split').value), backup_count: Number(field('backup_count').value), shortcuts: {},
    };
    for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-shortcut]')) {
      const command = shortcutCommands.find(command => command.id === input.dataset.shortcut)!;
      if (input.value && input.value !== command.fallback) patch.shortcuts![command.id] = input.value;
    }
    const last = settings().last_view;
    if (last) patch.last_view = { ...last,
      paper: patch.paper_enabled!,
      source: patch.show_source!,
      sidebar: patch.sidebar_visible!,
      toolbar: patch.toolbar_visible!,
    };
    try { await saveSettings(patch); options.applied(); options.close(dialog); }
    catch (reason) { dialog.querySelector('#settings-error')!.textContent = reason instanceof Error ? reason.message : String(reason); }
    finally { button.disabled = cancel.disabled = false; }
  };
  for (const [id, command] of [['settings-directory', 'open_settings_directory'], ['settings-association', 'register_file_association']]) {
    const button = dialog.querySelector<HTMLButtonElement>(`#${id}`)!;
    button.onclick = async () => {
      const status = dialog.querySelector<HTMLElement>('#settings-tool-status')!;
      button.disabled = true;
      try {
        if (!isTauri()) throw new Error('此功能需要桌面应用。');
        const result = await invoke<string>(command);
        status.textContent = command === 'open_settings_directory' ? '已打开配置目录' : result;
        status.dataset.state = 'normal';
      } catch (reason) { status.textContent = String(reason); status.dataset.state = 'error'; }
      finally { button.disabled = false; }
    };
  }
  const help = document.createElement('dialog'); help.id = 'help-dialog'; help.dataset.cancel = 'help-close';
  help.innerHTML = '<h3>帮助</h3><div class="help-controls"><label>文档<select id="help-document"></select></label><label>筛选<input id="help-filter" type="search" placeholder="搜索内容或分类"></label></div><div id="help-content"></div><div id="help-link-status" role="status"></div><div class="dialog-actions"><button id="help-close" class="primary-button">关闭</button></div>';
  document.body.append(help);
  document.getElementById('settings-help')!.onclick = () => { options.close(dialog); document.getElementById('help-menu')!.click(); };
  const select = help.querySelector<HTMLSelectElement>('#help-document')!, filter = help.querySelector<HTMLInputElement>('#help-filter')!;
  for (const path of Object.keys(documents).sort()) select.add(new Option(path.split('/').at(-1)!.replace(/\.md$/i, ''), path));
  const usage = Object.keys(documents).find(path => path.endsWith('/MDRE使用.md'));
  if (usage) select.value = usage;
  const renderer = new MarkdownIt({ html: false, linkify: false });
  const content = help.querySelector<HTMLElement>('#help-content')!;
  let currentPath = select.value;
  const applyFilter = () => {
    const query = filter.value.trim().toLowerCase();
    content.querySelectorAll<HTMLElement>('tbody tr, :scope > p, :scope > ul > li, :scope > ol > li, :scope > pre').forEach(row => row.hidden = !!query && !row.textContent!.toLowerCase().includes(query));
  };
  let displayRequest = 0;
  const show = async (path = select.value) => {
    const request = ++displayRequest;
    currentPath = path;
    content.classList.toggle('syntax-table', path.endsWith('/MDRE语法.md'));
    help.querySelector('#help-link-status')!.textContent = '';
    let source = documents[path] ?? '暂无帮助文档';
    if (path in references) {
      content.textContent = '正在加载…';
      try {
        const response = await fetch(references[path]);
        if (!response.ok) throw new Error('帮助附件加载失败。');
        source = await response.text();
      } catch (reason) {
        if (request === displayRequest) { content.textContent = ''; help.querySelector('#help-link-status')!.textContent = String(reason); }
        return;
      }
    }
    if (request !== displayRequest) return;
    if (path.endsWith('.txt')) { const pre = document.createElement('pre'); pre.textContent = source; content.replaceChildren(pre); }
    else content.innerHTML = renderer.render(source);
    help.querySelector('#help-link-status')!.textContent = '';
    content.scrollTop = 0; applyFilter();
  };
  select.onchange = () => { filter.value = ''; show(); }; filter.oninput = applyFilter;
  // 本地引用在帮助页内打开，外部链接只在用户点击后交给默认浏览器。
  content.onclick = async event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href')!;
    const status = help.querySelector<HTMLElement>('#help-link-status')!;
    try {
      if (/^https?:\/\//i.test(href)) {
        if (!isTauri()) throw new Error('请在桌面应用中打开外部链接。');
        await invoke('open_external', { url: href });
      } else {
        const resolved = decodeURIComponent(new URL(href, `https://help.local/${currentPath.replace('../../', '')}`).pathname.slice(1));
        const path = `../../${resolved}`;
        if (!(path in documents) && !(path in references)) throw new Error('帮助文档不存在。');
        if (path in documents) select.value = path;
        filter.value = ''; await show(path);
      }
    } catch (reason) { status.textContent = String(reason); }
  };
  document.getElementById('help-menu')!.onclick = () => { if (usage) select.value = usage; filter.value = ''; show(); options.open(help); filter.focus(); };
  help.querySelector<HTMLButtonElement>('#help-close')!.onclick = () => options.close(help);
}
