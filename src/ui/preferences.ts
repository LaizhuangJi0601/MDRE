import {t} from '../i18n/ui';
import { convertFontSize } from './font-size';
import { setupHelp } from './help';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { settings, saveSettings, shortcutCommands, defaults, type Settings } from '../persistence/settings';
import { normalizeUiScale, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, toStylePixels, uiScale } from './ui-scale';

// 帮助资源由构建工具从此目录导入，随程序离线打包。
const documents = import.meta.glob('../../docs/help/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const references = import.meta.glob('../../docs/licenses/*.{md,txt}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
export type PreferencesDraft = { patch: Partial<Settings>; values: Record<string,string>; valid: boolean };
// S-45 / v0.2.7 需求 5.3：字体候选来自本机已安装字体，失败或非 Windows 时回落到内置列表。
const FALLBACK_FONTS = {
  body: ['Microsoft YaHei', 'Segoe UI', 'SimSun', 'KaiTi', 'Noto Sans SC', 'sans-serif'],
  mono: ['Consolas', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
};
let systemFontsPromise: Promise<string[]> | undefined;
let systemFonts: string[] = [];
// 枚举结果由宿主缓存；这里再做一层进程内缓存，多个设置弹窗共用一次请求。
const loadSystemFonts = () => systemFontsPromise ??= (async () => {
  try {
    const value = await invoke<string[]>('list_system_fonts');
    systemFonts = Array.isArray(value) ? value.filter(font => typeof font === 'string' && font.trim()).map(font => font.trim()) : [];
  } catch { systemFonts = []; }
  return systemFonts;
})();
void loadSystemFonts();
// v0.2.7 需求 5.2：记住设置弹窗上次显示的位置与尺寸，关闭后再次打开回到原处。
// v0.3.0：界面缩放后弹窗的视觉尺寸是内联样式 × --ui-scale，记录和恢复都以视觉像素换算。
type DialogBounds = { left: number; top: number; width: number; height: number };
const BOUNDS_STORAGE_KEY = 'mdre.settings.dialog.bounds';
const desktopApp = (() => { try { return isTauri(); } catch { return false; } })();
let rememberedBounds: DialogBounds | null = null;
let boundsRequested = false;
const sanitizeBounds = (value: unknown): DialogBounds | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const bounds = {} as DialogBounds;
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const number = Number(source[key]);
    if (!Number.isFinite(number)) return null;
    bounds[key] = number;
  }
  if (bounds.width < 200 || bounds.height < 160 || bounds.width > 8000 || bounds.height > 8000) return null;
  return bounds;
};
// 插件端把位置存进扩展 globalState，跨编辑器标签仍保持一致；桌面端用 localStorage。
const updateRememberedBounds = async () => {
  if (boundsRequested) return;
  boundsRequested = true;
  if (!desktopApp) {
    try {
      const value = await invoke<unknown>('read_ui_state', { key: BOUNDS_STORAGE_KEY });
      rememberedBounds = sanitizeBounds(value);
      if (rememberedBounds) return;
    } catch { /* 宿主没有该接口时继续使用 localStorage */ }
  }
  try { rememberedBounds = sanitizeBounds(JSON.parse(localStorage.getItem(BOUNDS_STORAGE_KEY) || 'null')); } catch { rememberedBounds = null; }
};
void updateRememberedBounds();
const rememberDialogBounds = (dialog: HTMLDialogElement) => {
  if (!dialog.open || dialog.dataset.maximized === 'true' || document.body.dataset.settingsWindow) return;
  const rect = dialog.getBoundingClientRect();
  const bounds = sanitizeBounds({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  if (!bounds) return;
  rememberedBounds = bounds;
  try { localStorage.setItem(BOUNDS_STORAGE_KEY, JSON.stringify(bounds)); } catch { /* 存储不可用时只保留在内存 */ }
  if (!desktopApp) void invoke('write_ui_state', { key: BOUNDS_STORAGE_KEY, value: bounds }).catch(() => {});
};
const applyDialogBounds = (dialog: HTMLDialogElement) => {
  if (document.body.dataset.settingsWindow) return;
  const saved = rememberedBounds;
  if (!saved) return;
  const width = Math.max(320, Math.min(saved.width, innerWidth - 24));
  const height = Math.max(240, Math.min(saved.height, innerHeight - 24));
  dialog.dataset.moved = 'true';
  dialog.style.width = `${toStylePixels(width)}px`;
  dialog.style.height = `${toStylePixels(height)}px`;
  const rect = dialog.getBoundingClientRect();
  dialog.style.left = `${toStylePixels(Math.max(12, Math.min(saved.left, innerWidth - rect.width - 12)))}px`;
  dialog.style.top = `${toStylePixels(Math.max(12, Math.min(saved.top, innerHeight - rect.height - 12)))}px`;
};
type Options = { open: (dialog: HTMLDialogElement) => void; close: (dialog: HTMLDialogElement) => void; applied: () => void; fonts: (mono: boolean) => string[]; draftChanged?: (draft: PreferencesDraft) => Promise<void>; draftCleared?: () => void; openSettings?: () => void; checkUpdates?: () => void };
const UI_SCALE_OPTIONS = Array.from({ length: (UI_SCALE_MAX - UI_SCALE_MIN) / UI_SCALE_STEP + 1 }, (_, index) => UI_SCALE_MIN + index * UI_SCALE_STEP);
export function setupPreferences(options: Options) {
  const dialog = document.createElement('dialog'); dialog.id = 'settings-dialog'; dialog.dataset.cancel = 'settings-close';
  dialog.setAttribute('aria-label', '设置');
  dialog.innerHTML = `${document.body.dataset.settingsWindow ? '' : '<h3>设置</h3>'}<form id="settings-form">
    <fieldset><legend>外观与阅读</legend><div class="settings-grid">
      <label>语言<select name="language"><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
      <label>颜色主题<select name="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>界面动画<select name="motion"><option value="system">跟随系统</option><option value="on">开启</option><option value="off">关闭</option></select></label>
      <label>默认启动模式<select name="default_mode"><option value="edit">编辑模式</option><option value="read">阅读模式</option></select></label>
      <label>代码块主题<select name="code_theme"><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>界面缩放<div class="ui-scale-control"><button type="button" id="ui-scale-minus" aria-label="减小界面缩放">−</button><select name="ui_scale" aria-label="界面缩放">${UI_SCALE_OPTIONS.map(value => `<option value="${value}">${value}%</option>`).join('')}</select><button type="button" id="ui-scale-plus" aria-label="增大界面缩放">+</button></div></label>
      <label>正文字体<select name="font_body"></select></label><label>等宽字体<select name="font_mono"></select></label>
      <label>字号单位<select name="font_unit"><option value="px">px</option><option value="em">em</option></select></label>
      <label>正文字号<input name="font_size" type="number" min="8" max="32" step="any" required></label>
      <label>编辑功能区显示状态<select name="toolbar_visible"><option value="true">显示</option><option value="false">隐藏</option></select></label>
      <label>行距<input name="line_height" type="number" min="1" max="3" step="0.05" required></label>
    </div><p class="dialog-hint">界面缩放只改变菜单、侧栏、状态栏与对话框等界面元素，不影响正文与源码字号。</p><div class="settings-preview"><strong>阅读效果预览</strong><p>在这里查看字体、字号与行距。Markdown 让写作更专注。</p></div></fieldset>
    <fieldset><legend>纸张与图片</legend><div class="settings-grid">
      <label>默认 A4 纸张<select name="paper_enabled"><option value="false">关闭（随窗口排版）</option><option value="true">开启</option></select></label>
      <label>A4 排版方式<select name="paper_layout"><option value="continuous">连续排版</option><option value="paged">分页排版</option></select></label>
      <label>A4 正文对齐<select name="paper_align"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></label>
      <label>非 A4 正文对齐<select name="reading_align"><option value="justify">两端对齐</option><option value="left">左对齐</option><option value="center">居中对齐</option><option value="right">右对齐</option></select></label>
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
    <fieldset><legend>Word 转换</legend><div class="settings-grid">
      <label class="settings-wide">Pandoc 程序路径<input name="pandoc_path" type="text" placeholder="未检测到 Pandoc，请选择 pandoc.exe"></label>
      <label class="settings-wide">Word 参考样式（可选）<input name="word_reference" type="text" placeholder="完整的 .docx 文件路径"></label>
    </div><div class="settings-tools"><button type="button" id="pandoc-browse">选择 pandoc.exe</button><button type="button" id="pandoc-detect">检测 Pandoc</button><button type="button" id="reference-browse">选择参考 DOCX</button></div><p class="dialog-hint">Pandoc 不随 MDRE 分发。路径必须具体到 pandoc.exe，不能只填文件夹；清空路径恢复自动检测。</p><p id="pandoc-status" role="status"></p></fieldset>
    <fieldset><legend>快捷键</legend><p class="dialog-hint">点入后按组合键；Esc 恢复该项默认值。</p><div id="settings-shortcuts" class="shortcut-list"></div></fieldset>
  </form><div id="settings-error" role="alert"></div><div class="dialog-actions"><button id="settings-help" type="button">帮助</button><button id="settings-update" type="button">检查版本更新</button><button id="settings-defaults" type="button">恢复本页默认</button><button id="settings-close" class="primary-button">关闭</button></div>`;
  document.body.append(dialog);
  if (!document.getElementById('sidebar-files')) { dialog.querySelectorAll<HTMLElement>('[data-desktop-setting], #settings-directory, #settings-association, #settings-tool-status').forEach(element => element.hidden = true); }
  const updateButton = dialog.querySelector<HTMLButtonElement>('#settings-update')!;
  if (!desktopApp || !options.checkUpdates) updateButton.hidden = true;
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const search = document.createElement('label'); search.className='settings-search'; search.innerHTML='搜索设置 <input type="search" placeholder="输入设置名称或说明" aria-label="搜索设置">';
  const layout=document.createElement('div'); layout.className='settings-layout'; const navigation=document.createElement('nav'); navigation.className='settings-navigation'; navigation.setAttribute('aria-label','设置分类');
  const sections=[...form.querySelectorAll('fieldset')]; let active=0;
  const filterSettings=()=>{const query=search.querySelector('input')!.value.trim().toLowerCase(); sections.forEach((section,index)=>{section.hidden=query ? !t(section.textContent!).toLowerCase().includes(query) : index!==active;}); navigation.querySelectorAll('button').forEach((b,i)=>b.setAttribute('aria-current',String(i===active))); if(!sections[4].hidden) void detectPandoc(); form.scrollTop=0;};
  sections.forEach((section,index)=>{const b=document.createElement('button'); b.type='button'; b.textContent=section.querySelector('legend')!.textContent; b.onclick=()=>{active=index;search.querySelector('input')!.value='';filterSettings();};navigation.append(b);});
  sections.forEach(section=>{const legend=section.querySelector('legend')!; section.setAttribute('aria-label',legend.textContent!);});
  for(const label of form.querySelectorAll('.settings-grid label')) { const text=label.firstChild!; const strong=document.createElement('strong'); strong.textContent=text.textContent; text.replaceWith(strong); }
  form.before(search,layout); layout.append(navigation,form); search.querySelector('input')!.oninput=filterSettings;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  // v0.2.7：字体下拉先放已知候选，本机字体读取完成后再补齐，保证弹窗立即打开。
  const fillFontSelect = (select: HTMLSelectElement, mono: boolean, value: string) => {
    const current = value || select.value || '';
    const families = [...new Set([...systemFonts, ...FALLBACK_FONTS[mono ? 'mono' : 'body'], ...options.fonts(mono)])];
    const choices = ['', ...(current ? [current] : []), ...families.filter(family => family !== current)];
    select.replaceChildren(...choices.map(family => new Option(family || '默认', family)));
    select.value = current;
  };
  const refreshFontSelects = () => {
    for (const [name, mono] of [['font_body', false], ['font_mono', true]] as const) {
      const select = field(name) as HTMLSelectElement;
      if (select) fillFontSelect(select, mono, select.value);
    }
  };
  const loadFontsIntoDialog = () => {
    void loadSystemFonts().then(() => { if (dialog.open) refreshFontSelects(); });
  };
  // 自动检测结果仅用于显示，保持自动模式；只有用户编辑或浏览才固定路径。
  let manualPandoc='', pandocGeneration=0, detected=false;
  const pandocInput=field('pandoc_path') as HTMLInputElement;
  pandocInput.addEventListener('input',()=>{manualPandoc=pandocInput.value.trim(); detected=false; pandocGeneration++; dialog.querySelector('#pandoc-status')!.textContent=manualPandoc?'手动指定路径':'清空后将自动检测';});
  async function detectPandoc(force=false) {
    if(detected && !force)return;
    detected=true; const generation=++pandocGeneration, status=dialog.querySelector('#pandoc-status')!;
    status.textContent='正在检测…';
    try {const tool=await invoke<{path:string;version:string}>('detect_pandoc',{tool:manualPandoc}); if(generation!==pandocGeneration)return; pandocInput.value=tool.path; status.textContent=`${manualPandoc?'手动指定':'自动检测'} · ${tool.version}`;}
    catch(reason){if(generation!==pandocGeneration)return; pandocInput.value=manualPandoc; status.textContent=manualPandoc?String(reason):'未检测到 Pandoc，请选择 pandoc.exe';}
  }
  let fontUnit: 'px' | 'em' = 'px';
  const sizeBounds = () => { const size = field('font_size') as HTMLInputElement; size.min = fontUnit === 'px' ? '8' : '0.5'; size.max = fontUnit === 'px' ? '32' : '2'; };
  field('font_unit').onchange = () => { const next = field('font_unit').value as 'px'|'em'; field('font_size').value = String(convertFontSize(Number(field('font_size').value), fontUnit, next)); fontUnit = next; sizeBounds(); };
  const preview = dialog.querySelector<HTMLElement>('.settings-preview')!;
  function paintPreview() {
    const sample = preview.querySelector('p')!;
    sample.style.fontFamily = field('font_body').value || 'inherit';
    sample.style.fontSize = `${field('font_size').value}${field('font_unit').value}`;
    sample.style.lineHeight = field('line_height').value;
    preview.dataset.previewTheme = field('theme').value;
  }
  const error = dialog.querySelector<HTMLElement>('#settings-error')!;
  // v0.3.0：设置使用独立窗口时，按窗口可视区域与当前界面缩放摆放弹窗，200% 时也不会超出窗口。
  const fitSettingsWindow = () => {
    if (!document.body.dataset.settingsWindow || !dialog.open) return;
    const scale = uiScale();
    const width = Math.min(960, (innerWidth - 24) / scale);
    const height = Math.min(720, (innerHeight - 24) / scale);
    dialog.style.width = `${width}px`;
    dialog.style.height = `${height}px`;
    const rect = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(12, (innerWidth - rect.width) / 2) / scale}px`;
    dialog.style.top = `${Math.max(12, (innerHeight - rect.height) / 2) / scale}px`;
  };
  window.addEventListener('mdre:settings-applied', fitSettingsWindow);
  window.addEventListener('resize', fitSettingsWindow);
  let pendingDraft: PreferencesDraft | null = null;
  const openDialog = async () => {
    if (options.openSettings && !document.body.dataset.settingsWindow) { options.openSettings(); return; }
    if (isTauri() && !document.body.dataset.settingsWindow) { void invoke('open_settings_window').catch(reason => { error.textContent = String(reason); options.open(dialog); }); return; }
    await updateRememberedBounds();
    const saved = settings(), view = saved.last_view;
    const current = view ? { ...saved, paper_enabled: view.paper, show_source: view.source, sidebar_visible: view.sidebar, toolbar_visible: view.toolbar } : saved;
    for (const [name, mono] of [['font_body', false], ['font_mono', true]] as const) {
      fillFontSelect(field(name) as HTMLSelectElement, mono, String(current[name]));
    }
    for (const name of ['language', 'reading_align', 'pandoc_path', 'word_reference', 'font_unit', 'sidebar_visible', 'toolbar_visible', 'theme', 'motion', 'code_theme', 'default_mode', 'show_source', 'font_body', 'font_mono', 'font_size', 'line_height', 'split', 'backup_count', 'paper_enabled', 'paper_layout', 'paper_align', 'image_layout', 'sidebar_width', 'file_list_ratio', 'outline_collapsed', 'ui_scale'] as const) field(name).value = String(current[name]);
    manualPandoc = current.pandoc_path; detected = false; pandocGeneration++;
    filterSettings();
    fontUnit = current.font_unit; sizeBounds(); paintPreview();
    if (pendingDraft) { const draft = pendingDraft; pendingDraft = null; applyDraftValues(draft); }
    error.textContent = '';
    dialog.querySelector('#settings-tool-status')!.textContent = '';
    dialog.querySelector('#settings-shortcuts')!.replaceChildren(...shortcutCommands.map(command => {
      const row = document.createElement('label'); row.className = 'shortcut-row'; row.append(command.label);
      const input = document.createElement('input'); input.dataset.shortcut = command.id; input.value = current.shortcuts[command.id] ?? command.fallback;
      input.setAttribute('aria-label', `${command.label} 快捷键`); input.maxLength = 40;
      input.onkeydown = event => {
        if (event.isComposing || event.key === 'Tab') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return; }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        input.value = [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.metaKey ? ['Meta'] : []), event.key.length === 1 ? event.key.toUpperCase() : event.key].join('+');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      row.append(input); return row;
    }));
    options.open(dialog); applyDialogBounds(dialog); fitSettingsWindow();
    void updateRememberedBounds().then(() => { if (dialog.open) applyDialogBounds(dialog); });
    loadFontsIntoDialog();
    search.querySelector('input')!.focus({ preventScroll: true }); form.scrollTop = 0;
    dialog.querySelector<HTMLElement>('.dialog-content')?.scrollTo(0, 0);
  };
  document.getElementById('settings-open')!.onclick = openDialog;
  // v0.3.0 需求 4：设置即时生效并保存，不再有“应用/取消/确定”，关闭设置页前不会退出。
  const closeDialog = () => { rememberDialogBounds(dialog); options.close(dialog); };
  const closeButton = dialog.querySelector<HTMLButtonElement>('#settings-close')!;
  closeButton.onclick = () => closeDialog();
  dialog.oncancel = event => { event.preventDefault(); closeDialog(); };
  form.onsubmit = event => { event.preventDefault(); void applyNow(); };
  const collect = (): Partial<Settings> => {
    const patch: Partial<Settings> = {
      language: field('language').value as Settings['language'], reading_align: field('reading_align').value as Settings['reading_align'],
      pandoc_path: manualPandoc.trim().replace(/^"|"$/g,''), word_reference: field('word_reference').value.trim().replace(/^"|"$/g,''),
      font_unit: field('font_unit').value as Settings['font_unit'], sidebar_visible: field('sidebar_visible').value === 'true', toolbar_visible: field('toolbar_visible').value === 'true',
      theme: field('theme').value as Settings['theme'], motion: field('motion').value as Settings['motion'], code_theme: field('code_theme').value as Settings['code_theme'], default_mode: field('default_mode').value as Settings['default_mode'], font_body: field('font_body').value, font_mono: field('font_mono').value,
      ui_scale: normalizeUiScale(Number(field('ui_scale').value)),
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
    return patch;
  };
  let saving = false, applyTimer: ReturnType<typeof setTimeout> | undefined;
  const applyNow = async (): Promise<boolean> => {
    if (saving) { clearTimeout(applyTimer); applyTimer = setTimeout(() => void applyNow(), 180); return false; }
    const invalid = dialog.querySelector<HTMLInputElement>(':invalid');
    if (invalid) { error.textContent = '有无效设置未保存，请修正后继续。'; return false; }
    error.textContent = '';
    saving = true;
    try {
      await saveSettings(collect());
      options.draftCleared?.();
      options.applied();
      window.dispatchEvent(new Event('mdre:settings-applied'));
      return true;
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      return false;
    } finally { saving = false; }
  };
  // 连续输入（路径、字号）合并为一次保存；下拉、勾选与按钮立即保存。
  const scheduleApply = (immediate = false) => {
    clearTimeout(applyTimer);
    if (immediate) void applyNow();
    else applyTimer = setTimeout(() => { applyTimer = undefined; void applyNow(); }, 200);
  };
  const scaleSelect = field('ui_scale') as HTMLSelectElement;
  const stepScale = (delta: number) => {
    const next = normalizeUiScale(Number(scaleSelect.value) + delta);
    scaleSelect.value = String(next);
    scheduleApply(true);
  };
  dialog.querySelector<HTMLButtonElement>('#ui-scale-minus')!.onclick = () => stepScale(-UI_SCALE_STEP);
  dialog.querySelector<HTMLButtonElement>('#ui-scale-plus')!.onclick = () => stepScale(UI_SCALE_STEP);
  form.addEventListener('input', () => { paintPreview(); scheduleApply(); });
  form.addEventListener('change', () => { paintPreview(); scheduleApply(true); });
  dialog.querySelector<HTMLButtonElement>('#settings-update')!.onclick = () => options.checkUpdates?.();
  dialog.querySelector<HTMLButtonElement>('#settings-defaults')!.onclick = () => {
    const section = sections[active];
    for (const control of section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) { const key = control.name as keyof Settings; if (key in defaults) control.value = String(defaults[key]); }
    section.querySelectorAll<HTMLInputElement>('[data-shortcut]').forEach(input => input.value = '');
    fontUnit = field('font_unit').value as 'px'|'em'; sizeBounds(); paintPreview();
    if (active === 4) { manualPandoc = ''; detected = false; void detectPandoc(); }
    scheduleApply(true);
  };
  for (const [id, kind, name] of [['pandoc-browse','pandoc','pandoc_path'],['reference-browse','reference','word_reference']]) {
    dialog.querySelector<HTMLButtonElement>('#'+id)!.onclick = async () => { try { const picked = await invoke<string|null>('pick_word',{kind}); if (picked) { field(name).value = picked; if (name === 'pandoc_path') { manualPandoc = picked; void detectPandoc(true); } scheduleApply(true); } } catch (reason) { dialog.querySelector('#pandoc-status')!.textContent = String(reason); } };
  }
  dialog.querySelector<HTMLButtonElement>('#pandoc-detect')!.onclick = () => { void detectPandoc(true); };
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
  setupHelp({documents,references,open:options.open,close:options.close,external:async url=>{
    if(!isTauri())throw new Error('请在桌面应用中打开外部链接。');
    await invoke('open_external',{url});
  }});
  // 弹窗位置由拖动 / 缩放时的内联样式变化驱动，合并为 250ms 一次记录。
  let boundsTimer:ReturnType<typeof setTimeout>|undefined;
  new MutationObserver(()=>{
    clearTimeout(boundsTimer);
    boundsTimer=setTimeout(()=>{boundsTimer=undefined;rememberDialogBounds(dialog);},250);
  }).observe(dialog,{attributes:true,attributeFilter:['style']});
  filterSettings();
  const applyDraftValues = (draft: PreferencesDraft) => {
    for(const [key,value] of Object.entries(draft.values)){
      const input=key.startsWith('shortcut:') ? form.querySelector<HTMLInputElement>(`[data-shortcut="${CSS.escape(key.slice(9))}"]`) : form.elements.namedItem(key) as HTMLInputElement|null;
      if(input)input.value=value;
    }
    manualPandoc=field('pandoc_path').value; detected=false; pandocGeneration++;fontUnit=field('font_unit').value as 'px'|'em';sizeBounds();paintPreview();
  };
  // 旧版本草稿只在无效时用于恢复供修正；新版设置默认即时保存，不再产生草稿。
  return { saveDraft: async () => true, restoreDraft: (draft: PreferencesDraft) => {
    if(!dialog.open){pendingDraft=draft;return;}
    applyDraftValues(draft);
  } };
}
