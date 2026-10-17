import { invoke, isTauri } from '@tauri-apps/api/core';
export const RECENT_LIMIT = 5;
export type LastSession = { folder: string | null; files: string[]; active_file: string | null; sidebar_visible: boolean; sidebar_tab: 'files' | 'outline' };

// S-34/S-42/S-43/S-45/S-47：配置扩展为「主题 + 启动模式 + 分栏比例 + 字体 + 最近打开 + 备份份数 + 快捷键」。
// 键名与 Rust `Settings` 的 serde 字段保持一致（蛇形），避免跨端读写错位。
export type ViewState = { name: string; paper: boolean; source: boolean; sidebar: boolean; toolbar: boolean };
export type Settings = {
  font_unit: 'px' | 'em';
  sidebar_visible: boolean;
  toolbar_visible: boolean;
  last_view: ViewState | null;
  theme: 'system' | 'light' | 'dark';
  code_theme: 'light' | 'dark';
  default_mode: 'edit' | 'read';
  show_source: boolean;
  split: number;
  paper_enabled: boolean;
  paper_layout: 'continuous' | 'paged';
  paper_align: 'left' | 'center' | 'right' | 'justify';
  image_layout: 'fit' | 'natural';
  sidebar_width: number;
  file_list_ratio: number;
  outline_collapsed: boolean;
  font_body: string;
  font_mono: string;
  font_size: number;
  line_height: number;
  recent: string[];
  recent_folders: string[];
  last_session: LastSession | null;
  backup_count: number;
  shortcuts: Record<string, string>;
};
export const defaults: Settings = {
  font_unit: 'px', sidebar_visible: true, toolbar_visible: true, last_view: null,
  theme: 'system', code_theme: 'light', default_mode: 'edit', show_source: true, split: 50,
  paper_enabled: false, paper_layout: 'continuous', paper_align: 'justify', image_layout: 'fit', sidebar_width: 216, file_list_ratio: 60, outline_collapsed: false,
  font_body: '', font_mono: '', font_size: 15, line_height: 1.85,
  recent: [], recent_folders: [], last_session: null, backup_count: 0, shortcuts: {},
};
// S-47：可自定义的命令与默认组合键；配置文件里只覆盖需要改的项。
export const shortcutCommands: { id: string; label: string; fallback: string }[] = [
  { id: 'save', label: '保存', fallback: 'Ctrl+S' },
  { id: 'save-as', label: '另存为', fallback: 'Ctrl+Shift+S' },
  { id: 'open', label: '打开文件', fallback: 'Ctrl+O' },
  { id: 'new', label: '新建文档', fallback: 'Ctrl+N' },
  { id: 'close-tab', label: '关闭当前标签', fallback: 'Ctrl+W' },
  { id: 'find-open', label: '查找', fallback: 'Ctrl+F' },
  { id: 'replace-open', label: '替换', fallback: 'Ctrl+H' },
  { id: 'mode-toggle', label: '切换编辑 / 阅读模式', fallback: 'Ctrl+Shift+V' },
  { id: 'outline-toggle', label: '侧栏', fallback: 'Ctrl+Shift+O' },
  { id: 'goto-line', label: '跳转到行', fallback: 'Ctrl+G' },
  { id: 'refresh', label: '刷新渲染', fallback: 'Ctrl+Shift+R' },
  { id: 'focus-mode', label: '专注', fallback: 'F11' },
  { id: 'underline', label: '下划线', fallback: 'Ctrl+U' },
  { id: 'paper-toggle', label: 'A4 纸张', fallback: '' },
  { id: 'export-html', label: '导出 HTML', fallback: '' },
];
const validators: Record<keyof Settings, (value: unknown) => boolean> = {
  font_unit: value => value === 'px' || value === 'em',
  sidebar_visible: value => typeof value === 'boolean',
  toolbar_visible: value => typeof value === 'boolean',
  last_view: value => value === null || !!value && typeof value === 'object' && typeof (value as ViewState).name === 'string' && ['paper','source','sidebar','toolbar'].every(key => typeof (value as Record<string, unknown>)[key] === 'boolean'),
  theme: value => ['system', 'light', 'dark'].includes(value as string),
  code_theme: value => ['light', 'dark'].includes(value as string),
  default_mode: value => ['edit', 'read'].includes(value as string),
  show_source: value => typeof value === 'boolean',
  paper_enabled: value => typeof value === 'boolean',
  paper_layout: value => ['continuous', 'paged'].includes(value as string),
  paper_align: value => ['left', 'center', 'right', 'justify'].includes(value as string),
  image_layout: value => ['fit', 'natural'].includes(value as string),
  sidebar_width: value => typeof value === 'number' && value >= 180 && value <= 420,
  file_list_ratio: value => typeof value === 'number' && value >= 20 && value <= 80,
  outline_collapsed: value => typeof value === 'boolean',
  split: value => typeof value === 'number' && value >= 20 && value <= 80,
  font_body: value => typeof value === 'string' && value.length <= 200,
  font_mono: value => typeof value === 'string' && value.length <= 200,
  font_size: value => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 32,
  line_height: value => typeof value === 'number' && value >= 1 && value <= 3,
  recent: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  recent_folders: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  last_session: value => {
    if (value === null) return true;
    if (!value || typeof value !== 'object') return false;
    const state = value as LastSession;
    return (state.folder === null || typeof state.folder === 'string') && Array.isArray(state.files) && state.files.every(path => typeof path === 'string')
      && (state.active_file === null || typeof state.active_file === 'string') && typeof state.sidebar_visible === 'boolean' && ['files', 'outline'].includes(state.sidebar_tab);
  },
  backup_count: value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 20,
  shortcuts: value => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>).every(([id, key]) => shortcutCommands.some(command => command.id === id) && typeof key === 'string' && key.length <= 40),
};
// 只接受已知字段与合法取值；其余一律回落默认值，避免坏配置把界面卡死。
export function sanitize(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const next: Settings = { ...defaults, recent: [...defaults.recent], recent_folders: [], shortcuts: { ...defaults.shortcuts } };
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    const value = raw?.[key];
    if (value === undefined || !validators[key](value)) continue;
    if (key === 'recent' || key === 'recent_folders') next[key] = (value as string[]).slice(0, RECENT_LIMIT);
    else if (key === 'last_session') next.last_session = value === null ? null : { ...(value as LastSession), files: [...(value as LastSession).files] };
    else if (key === 'shortcuts') next.shortcuts = { ...(value as Record<string, string>) };
    else Object.assign(next, { [key]: value });
  }
  const min = next.font_unit === 'px' ? 8 : 0.5, max = next.font_unit === 'px' ? 32 : 2;
  if (next.font_size < min || next.font_size > max) next.font_size = next.font_unit === 'px' ? 15 : 15 / 16;
  return next;
}
let current: Settings = { ...defaults, recent: [], shortcuts: {} };

export function settings(): Settings { return current; }
export function shortcutOf(id: string): string {
  const command = shortcutCommands.find(item => item.id === id);
  return current.shortcuts[id] ?? command?.fallback ?? '';
}
// S-47：把 `Ctrl+Shift+S` 一类写法解析为匹配函数；空串表示未绑定。
export function matchShortcut(binding: string, event: KeyboardEvent): boolean {
  if (!binding) return false;
  const parts = binding.split('+').map(part => part.trim().toLowerCase()).filter(Boolean);
  const key = parts.find(part => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd'].includes(part));
  if (!key) return false;
  const wants = { ctrl: parts.includes('ctrl') || parts.includes('control'), shift: parts.includes('shift'), alt: parts.includes('alt'), meta: parts.includes('meta') || parts.includes('cmd') };
  if (event.ctrlKey !== wants.ctrl || event.shiftKey !== wants.shift || event.altKey !== wants.alt || event.metaKey !== wants.meta) return false;
  const name = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  const code = event.code.toLowerCase();
  if (key === 'f11') return event.key === 'F11';
  return name === key || code === `key${key}` || code === `digit${key}`;
}
// I-7：配置存 Tauri 应用数据目录；读取失败保留默认值并向上报告。
export async function loadSettings(): Promise<Settings> {
  if (!isTauri()) return current;
  const loaded = await invoke<Partial<Settings>>('read_settings');
  current = sanitize(loaded ?? {});
  return current;
}
// 立即反映当前选择，磁盘/宿主写入串行执行，避免相邻设置操作互相覆盖。
let settingsWrites: Promise<void> = Promise.resolve();
export function saveSettings(patch: Partial<Settings>): Promise<void> {
  const previous = current, next = sanitize({ ...current, ...patch });
  current = next;
  const operation = settingsWrites.then(async () => {
    if (isTauri()) await invoke('write_settings', { settings: next });
  }).catch(reason => { if (current === next) current = previous; throw reason; });
  settingsWrites = operation.catch(() => {});
  return operation;
}
