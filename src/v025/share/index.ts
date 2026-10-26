// MDRE 0.2.5：导出可分享副本（Markdown + 被引用图片打包为 zip）。
// 原文档与源图片只读不写；图片目标在副本 Markdown 中改写为 zip 内相对路径。
import { env, registerV025Api, type V025Env } from '../runtime';
import { collectImageReferences, imageExtensionOf, type ImageReference } from '../../image-references';
import { bytesToBase64, dataUrlToBytes, hashBytes, sniffImageExtension } from './bytes';
import { rewriteImageDestination } from './markdown';
import { buildZip, type ZipEntry } from './zip';

export type ShareCopyResult = {
  path: string | null;
  bytes: number;
  images: number;
  skipped: number;
  canceled: boolean;
};

type ImagePlan = { entries: ZipEntry[]; rewrites: Map<number, string>; skipped: number };

let installed = false;

export function initShare() {
  if (installed) return;
  installed = true;
  installMenuItem();
  registerExportApi();
}

function appendExportItem(popup: HTMLElement, id: string, plugin: boolean) {
  if (document.getElementById(id)) return;
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  const label = document.createElement('span');
  label.textContent = '导出可分享副本…';
  button.append(label, document.createElement('kbd'));
  button.addEventListener('click', () => {
    if (plugin) popup.hidden = true;
    void runShareCopy();
  });
  const paint=()=>{const doc=env().workspace?.active;button.disabled=!doc||!!doc.welcome;};
  paint();window.addEventListener('mdre:document-changed',paint);
  popup.append(button);
}

function whenElement<T extends Element>(selector: string, callback: (element: T) => void, timeoutMs = 15000) {
  const existing = document.querySelector<T>(selector);
  if (existing) { callback(existing); return; }
  let finished = false;
  let timer = 0;
  const finish = (element: T) => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    window.clearTimeout(timer);
    callback(element);
  };
  const observer = new MutationObserver(() => {
    const element = document.querySelector<T>(selector);
    if (element) finish(element);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  timer = window.setTimeout(() => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    console.error('MDRE 0.2.5：等待导出菜单容器超时', selector);
  }, timeoutMs);
}

function installMenuItem() {
  const api = env();
  if (api.platform === 'plugin') {
    // 插件版：状态栏导出菜单在隐藏编辑功能区时显示；顶部菜单栏“导出”在普通界面可见，两处都提供入口。
    // 两者都由 main.ts 动态创建，晚于 initShare 时用 MutationObserver 等待。
    whenElement<HTMLElement>('#status-export-menu', popup => appendExportItem(popup, 'status-share-copy', true));
    whenElement<HTMLElement>('#export-menu', trigger => {
      const popup = trigger.closest('.menu')?.querySelector<HTMLElement>('.menu-popup');
      if (popup) appendExportItem(popup, 'share-copy', false);
    });
    return;
  }
  whenElement<HTMLElement>('#export-menu', trigger => {
    const popup = trigger.closest('.menu')?.querySelector<HTMLElement>('.menu-popup');
    if (popup) appendExportItem(popup, 'share-copy', false);
    else console.error('MDRE 0.2.5：未找到桌面版导出菜单弹层');
  });
}

/** 注册验收接口：window.mdre.exportShareCopy(path?) → 失败抛错，取消返回 null。 */
function registerExportApi() {
  registerV025Api('exportShareCopy', async (path?: unknown) => {
    const result = await exportShareCopy(typeof path === 'string' && path ? path : undefined);
    return result.canceled
      ? null
      : { path: result.path, bytes: result.bytes, images: result.images, skipped: result.skipped };
  });
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? '未知错误');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function safeDocumentTitle(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || '未命名';
}

function canRewrite(doc: any, reference: ImageReference, destination: string): boolean {
  if (reference.sourceFrom < 0 || reference.sourceTo <= reference.sourceFrom) return false;
  const slice = String(doc?.source ?? '').slice(reference.sourceFrom, reference.sourceTo);
  return rewriteImageDestination(slice, destination) !== null;
}

async function planImages(api: V025Env, doc: any, references: ImageReference[], markdownName: string): Promise<ImagePlan> {
  const entries: ZipEntry[] = [];
  const rewrites = new Map<number, string>();
  const used = new Set<string>([markdownName.toLowerCase()]);
  let skipped = 0;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    // data URI 图片已内嵌在 Markdown 中，不需要重复打包，也不需要改写。
    if (reference.kind === 'data') continue;
    // HTTPS 图片无法在桌面/插件里离线读取，保持原链接并计入跳过数量。
    if (reference.kind === 'remote') { skipped += 1; continue; }
    let bytes: Uint8Array | null = null;
    try {
      if (!reference.absolutePath) throw new Error('图片路径无法解析。');
      bytes = dataUrlToBytes(await api.invoke<string>('read_binary', { path: reference.absolutePath }));
    } catch { bytes = null; }
    if (!bytes || !bytes.length) { skipped += 1; continue; }
    if (reference.relative) {
      const name = reference.relative;
      if (used.has(name.toLowerCase())) continue;
      used.add(name.toLowerCase());
      entries.push({ name, data: bytes });
      continue;
    }
    const extension = imageExtensionOf(reference.absolutePath ?? reference.src) || sniffImageExtension(bytes);
    const name = `images/${await hashBytes(bytes)}.${extension}`;
    if (!canRewrite(doc, reference, name)) { skipped += 1; continue; }
    rewrites.set(index, name);
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      entries.push({ name, data: bytes });
    }
  }
  return { entries, rewrites, skipped };
}

function rewriteMarkdown(doc: any, references: ImageReference[], rewrites: Map<number, string>): string {
  const source = String(doc?.source ?? '');
  if (!rewrites.size) return source;
  const edits: { from: number; to: number; insert: string }[] = [];
  for (const [index, destination] of rewrites) {
    const reference = references[index];
    if (reference.sourceFrom < 0 || reference.sourceTo <= reference.sourceFrom) continue;
    const slice = source.slice(reference.sourceFrom, reference.sourceTo);
    const next = rewriteImageDestination(slice, destination);
    if (next && next !== slice) edits.push({ from: reference.sourceFrom, to: reference.sourceTo, insert: next });
  }
  edits.sort((first, second) => second.from - first.from);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to);
  return output;
}

/** 生成可分享副本并保存；explicitPath 为绝对 .zip 路径时跳过保存对话框（供自动化使用）。 */
export async function exportShareCopy(explicitPath?: string): Promise<ShareCopyResult> {
  const api = env();
  const doc = api.workspace?.active;
  if (!doc) throw new Error('没有可导出的文档。');
  if (doc.welcome) throw new Error('欢迎页没有可导出的文档。');
  if (doc.modelStale) throw new Error('文档模型待刷新，请先刷新渲染再导出。');
  const title = safeDocumentTitle(String(api.documentTitle(doc) ?? ''));
  const markdownName = `${title}.md`;
  const suggested = `${title}.zip`;
  const references = collectImageReferences(doc);
  const plan = await planImages(api, doc, references, markdownName);
  const markdown = rewriteMarkdown(doc, references, plan.rewrites);
  const entries: ZipEntry[] = [{ name: markdownName, data: new TextEncoder().encode(markdown) }, ...plan.entries];
  const zip = await buildZip(entries);
  const base64 = bytesToBase64(zip);
  const result = (path: string | null): ShareCopyResult => ({
    path, bytes: zip.length, images: plan.entries.length, skipped: plan.skipped, canceled: path === null,
  });
  if (api.platform === 'plugin') {
    const request: Record<string, unknown> = { suggested, base64 };
    if (explicitPath) request.path = explicitPath;
    return result(await api.invoke<string | null>('save_share_copy', request));
  }
  const path = explicitPath ?? (api.isTauri() ? await api.invoke<string | null>('pick_export', { format: 'zip', suggested }) : null);
  if (!path) {
    if (!api.isTauri()) throw new Error('保存可分享副本需要桌面应用。');
    return result(null);
  }
  await api.invoke('write_export_binary', { path, base64 });
  return result(path);
}

/** 导出菜单入口：统一展示状态栏提示与错误，不向事件处理抛异常。 */
export async function runShareCopy(explicitPath?: string): Promise<ShareCopyResult | null> {
  const api = env();
  try {
    api.message('正在生成可分享副本…');
    const result = await exportShareCopy(explicitPath);
    if (result.canceled) {
      api.message('已取消导出可分享副本。');
      return result;
    }
    const skipped = result.skipped ? `，跳过 ${result.skipped} 张无法读取的图片` : '';
    api.message(`已导出可分享副本 · ${result.images} 张图片 · ${formatBytes(result.bytes)} · ${result.path}${skipped}`);
    return result;
  } catch (reason) {
    api.message(`导出可分享副本失败：${reasonMessage(reason)}`);
    try { api.error(reason); } catch { /* 状态栏已提示失败原因。 */ }
    return null;
  }
}
