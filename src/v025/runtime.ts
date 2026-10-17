import type { ContextItem } from '../ui/context-menu';

// MDRE 0.2.5 扩展钩子层：main.ts 在完成初始化后提供环境并调用各功能模块。
// 该文件在桌面版与插件版中保持一致，平台差异通过 platform 字段与 env.invoke 表达。
export type V025Platform = 'desktop' | 'plugin';
export type V025Env = {
  platform: V025Platform;
  workspace: any;
  render: any;
  source: any;
  schema: any;
  isTauri: () => boolean;
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  structural: (edit: { from: number; to: number; insert: string }, cursor?: { from: number; to: number }, origin?: 'source' | 'render') => void;
  error: (reason: unknown) => void;
  status: () => void;
  message: (text: string) => void;
  flushInline: (doc?: any) => void;
  documentTitle: (doc?: any) => string;
  resolveImage: (doc: any, source: string) => Promise<string | null>;
  copyText: (text: string) => Promise<void>;
  readText: () => Promise<string>;
  openFloating: (dialog: HTMLDialogElement) => void;
  closeFloating: (dialog: HTMLDialogElement) => void;
  settings: () => any;
  saveSettings: (patch: Record<string, unknown>) => Promise<any>;
};

let current: V025Env | null = null;
export function provideV025Env(value: V025Env) { current = value; }
export function env(): V025Env {
  if (!current) throw new Error('MDRE 扩展环境尚未初始化。');
  return current;
}

// 右键菜单扩展：main.ts 组好菜单项后调用；模块可原地修改 items 或 table-operations.children。
export type EditorContextInfo = {
  doc: any;
  origin: 'source' | 'render';
  items: ContextItem[];
  cell: HTMLElement | null;
  writable: boolean;
  selected: boolean;
  run: (operation: () => void | Promise<void>) => (() => void);
  copyText: () => string;
  pasteText: (text: string) => void;
  tableCells: string[];
};
export const editorContextHooks: ((info: EditorContextInfo) => void)[] = [];

// 粘贴拦截：在原有粘贴处理之前同步调用；返回 true 表示已接管。
// 实现必须在返回前同步读取 clipboardData（浏览器只在事件同步阶段提供数据）。
export const pasteInterceptors: ((event: ClipboardEvent, origin: 'source' | 'render') => boolean)[] = [];

// 右键菜单“粘贴”接管：返回 true 表示已处理（可异步读取剪贴板）。
export const menuPasteHandlers: (() => boolean | Promise<boolean>)[] = [];

// 文档变化：show = 切换/打开文档，preview = 渲染刷新完成。
export const documentHooks: ((doc: any, kind: 'show' | 'preview') => void)[] = [];
export function notifyDocument(doc: any, kind: 'show' | 'preview') {
  for (const hook of documentHooks) {
    try { hook(doc, kind); } catch (reason) { console.error('MDRE 扩展文档钩子失败', reason); }
  }
}

// 供验收脚本/自动化调用的扩展接口（window.mdre.v025(name, ...)）。
const v025Api = new Map<string, (...args: any[]) => any>();
export function registerV025Api(name: string, fn: (...args: any[]) => any) { v025Api.set(name, fn); }
export function callV025Api(name: string, ...args: any[]): any {
  const fn = v025Api.get(name);
  if (!fn) throw new Error(`扩展接口未实现：${name}`);
  return fn(...args);
}
