// 剪贴板与轻量互通（v0.2.5）：复制为富文本 + HTML→Markdown 粘贴。
// 依赖 runtime 钩子层：editorContextHooks（右键菜单）/ pasteInterceptors（Ctrl+V）/
// menuPasteHandlers（右键“粘贴”）；所有写入统一走 env().structural，一次粘贴一步撤销。
import { editorContextHooks, env, menuPasteHandlers, pasteInterceptors } from '../runtime';
import {
  CLIPBOARD_HTML_LIMIT,
  CLIPBOARD_IMAGE_LIMIT,
  htmlToMarkdown,
  htmlToPlainText,
  plainTextToMarkdown,
  sanitizeClipboardHtml,
  type HtmlConversion,
  type PasteImage,
} from '../../html-to-markdown';
import { imageMarkdown } from '../../image-path';
import { saveImage, savedImageSource } from '../../assets';
import { projectSelection, renderToSource } from '../../mapping';
import { renderRichCopy } from './rich-html';

type Origin = 'source' | 'render';

type PasteTarget = {
  from: number;
  to: number;
  origin: Origin;
  /** 位于代码块或行内代码内：按纯文本原样粘贴 */
  inCode: boolean;
  /** 位于围栏代码块内 */
  codeBlock: boolean;
  /** 位于表格单元格内：复杂内容降级为文本 */
  inCell: boolean;
};

type PasteRecord = {
  origin: Origin;
  mode: 'html' | 'code' | 'cell' | 'plain' | 'failed' | 'blocked';
  ignored: number;
  mergedTables: number;
  skippedImages: number;
  wording: string;
};

let lastMenuOrigin: Origin | null = null;
let lastPaste: PasteRecord | null = null;

const unsupported = (reason: unknown) => {
  try { env().error(reason); } catch { /* 环境尚未就绪时忽略 */ }
};

function message(text: string): void {
  try { env().message(text); } catch { /* 状态栏不可用时忽略 */ }
}

function activeDocument(): any {
  return env().workspace?.active ?? null;
}

function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ───────────────────────────── 复制为富文本 ─────────────────────────────

function currentRichRange(doc: any): { from: number; to: number } | null {
  const renderState = env().render?.state;
  if (!renderState) return null;
  const selection = renderState.selection as any;
  // 渲染栏视图选区是“是否有选区”的权威来源；空选区时不能沿用文档里可能过期的投影区间，
  // 否则会把“复制整篇渲染内容”退化成复制一个残留字符。
  if (selection.from !== selection.to) return { from: selection.from, to: selection.to };
  const stored = doc?.selection;
  if (stored?.active === 'source' && stored.source && stored.source.from !== stored.source.to) {
    try {
      const projected = projectSelection(doc.model, stored);
      if (projected.render.from !== projected.render.to) return projected.render;
    } catch { /* 映射失败按无选区处理。 */ }
  }
  return null;
}

async function resolveRichImage(doc: any, node: any, position: number | null): Promise<string | null> {
  const source = String(node?.attrs?.src ?? '');
  if (!source) return null;
  if (/^(?:data|https?):/i.test(source)) return source;
  // 渲染视图中的图片通常已经解析为 data URI，优先复用避免再走一次 IPC。
  if (position !== null) {
    try {
      const dom = env().render.nodeDOM(position);
      if (dom instanceof HTMLImageElement && dom.src && !/^file:/i.test(dom.src)) return dom.src;
    } catch { /* 位置可能已变化，退回文档解析 */ }
  }
  try {
    return await env().resolveImage(doc, source);
  } catch {
    return null;
  }
}

async function copyRichToClipboard(): Promise<void> {
  const doc = activeDocument();
  if (!doc || doc.welcome || !doc.model || !env().render?.state?.doc) { message('没有可复制的渲染内容'); return; }
  const range = currentRichRange(doc);
  const result = await renderRichCopy(env().render.state.doc, {
    range,
    title: env().documentTitle(doc),
    resolveImage: (node, position) => resolveRichImage(doc, node, position),
  });
  const notices: string[] = [];
  if (result.downgraded) notices.push(`${result.downgraded} 处私有格式已降级`);
  if (result.imageFailures) notices.push(`${result.imageFailures} 个图片无法解析已跳过`);
  if (result.dropped) notices.push(`${result.dropped} 项内容无法映射已丢弃`);
  const suffix = notices.length ? `，${notices.join('，')}` : '';
  const outcome = await writeClipboard(result.html, result.body, result.text);
  if (outcome === 'rich') message(`已复制为富文本${suffix}`);
  else if (outcome === 'plain') message(`富文本剪贴板不可用，已复制纯文本${suffix}`);
  else { unsupported(new Error('复制到剪贴板失败：浏览器拒绝了剪贴板写入。')); message('复制失败，剪贴板不可用'); }
}

type ClipboardOutcome = 'rich' | 'plain' | 'failed';

async function writeClipboard(html: string, fragment: string, text: string): Promise<ClipboardOutcome> {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text || ' '], { type: 'text/plain' }),
      })]);
      return 'rich';
    } catch (reason) {
      console.warn('MDRE 富文本剪贴板写入失败，尝试 execCommand 兜底', reason);
    }
  }
  // 权限被拒或 ClipboardItem 不可用时，隐藏 contenteditable + execCommand 兜底。
  try {
    if (execCommandCopy(fragment)) return 'rich';
  } catch (reason) {
    console.warn('MDRE execCommand 兜底复制失败', reason);
  }
  try {
    await env().copyText(text || ' ');
    return 'plain';
  } catch (reason) {
    console.warn('MDRE 纯文本复制同样失败', reason);
    return 'failed';
  }
}

function execCommandCopy(html: string): boolean {
  const host = document.createElement('div');
  host.className = 'mdre-clipboard-fallback';
  host.contentEditable = 'true';
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;white-space:pre-wrap;';
  // HTML 由受控渲染模型序列化（raw HTML 已经白名单清洗），不会带入脚本。
  host.innerHTML = html;
  document.body.append(host);
  const selection = document.getSelection();
  const saved = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const range = document.createRange();
  range.selectNodeContents(host);
  try {
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    selection?.removeAllRanges();
    if (saved) selection?.addRange(saved);
    host.remove();
  }
}

function contextHook(info: any): void {
  lastMenuOrigin = info?.origin === 'source' ? 'source' : 'render';
  if (info?.origin !== 'render') return;
  const items = info.items as { id?: string; label?: string; icon?: string; accelerator?: string; disabled?: boolean; run?: () => void }[];
  if (!Array.isArray(items) || items.some(item => item.id === 'copy-rich')) return;
  const pasteIndex = items.findIndex(item => item.id === 'paste');
  if (pasteIndex < 0) return;
  // 渲染栏右键一级“复制/剪切/粘贴”区域：在“粘贴”之后加入“复制为富文本”。
  items.splice(pasteIndex + 1, 0, {
    id: 'copy-rich',
    label: '复制为富文本',
    icon: 'markdown',
    accelerator: 'Ctrl+Shift+C',
    disabled: false,
    run: info.run(() => copyRichToClipboard()),
  });
}

function shortcutKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
  if (String(event.key).toLowerCase() !== 'c') return;
  const target = event.target as HTMLElement | null;
  // 输入控件、内联代码编辑器和已打开的弹窗保留原生复制行为。
  if (target?.closest?.('input, textarea, select, .inline-editor, dialog[open]')) return;
  event.preventDefault();
  event.stopPropagation();
  void copyRichToClipboard().catch(unsupported);
}

// ───────────────────────────── HTML → Markdown 粘贴 ─────────────────────────────

function modelContext(model: any, offset: number): { inCell: boolean; blockChain: any[] } {
  const blocks: any[] = Array.isArray(model?.blocks) ? model.blocks : [];
  const containing = blocks
    .filter(block => offset >= block.from && offset <= block.to)
    .sort((a, b) => a.node.nodeSize - b.node.nodeSize)[0];
  const chain: any[] = [];
  let current = containing;
  for (let guard = 0; current && guard < 32; guard++) {
    chain.push(current);
    const parentId = current.parent;
    current = parentId ? blocks.find(block => block.id === parentId) : undefined;
  }
  return { inCell: chain.some(block => block.type === 'table_cell'), blockChain: chain };
}

function charAt(chars: any[], offset: number): any {
  const char = chars.find(item => item.from <= offset && offset < item.to);
  if (char) return char;
  return chars.find(item => item.to === offset && item.from < offset);
}

function hasCodeMark(char: any): boolean {
  const marks = char?.marks ?? [];
  return marks.some((mark: any) => mark?.type?.name === 'code' || mark?.type === 'code');
}

function insideInlineCode(model: any, from: number, to: number): boolean {
  const chars: any[] = Array.isArray(model?.chars) ? model.chars : [];
  if (!chars.length) return false;
  if (from === to) {
    const before = from > 0 ? charAt(chars, from - 1) : null;
    const after = charAt(chars, from);
    return !!before && !!after && hasCodeMark(before) && hasCodeMark(after);
  }
  let seen = false;
  for (const char of chars) {
    if (char.to <= from || char.from >= to) continue;
    seen = true;
    if (!hasCodeMark(char)) return false;
  }
  return seen;
}

function renderContext(): { inCell: boolean; inCode: boolean } {
  const state = env().render?.state;
  if (!state) return { inCell: false, inCode: false };
  const selection = state.selection as any;
  let inCell = false;
  let inCode = false;
  const node = selection.node;
  if (node && node.type?.name === 'opaque' && node.attrs?.kind === 'code') inCode = true;
  try {
    const $from = state.doc.resolve(Math.min(state.selection.from, state.doc.content.size));
    if (typeof $from.marks === 'function' && $from.marks().some((mark: any) => mark.type?.name === 'code')) inCode = true;
    for (let depth = 1; depth <= $from.depth; depth++) {
      const ancestor = $from.node(depth);
      if (ancestor.type?.name === 'table_cell') inCell = true;
      if (ancestor.type?.name === 'opaque' && ancestor.attrs?.kind === 'code') inCode = true;
    }
  } catch { /* 位置失效时按非代码处理 */ }
  return { inCell, inCode };
}

function locateTarget(doc: any, origin: Origin): PasteTarget | null {
  const source = String(doc?.source ?? '');
  let from = 0;
  let to = 0;
  if (origin === 'source') {
    const main = env().source?.state?.selection?.main;
    if (!main) return null;
    from = doc.viewToSource(main.from);
    to = doc.viewToSource(main.to);
  } else {
    const state = env().render?.state;
    if (!state) return null;
    const selection = state.selection as any;
    const node = selection.node;
    if (node) {
      const block = (doc.model?.blocks ?? []).find((item: any) => item.pos === selection.from);
      if (block) { from = block.from; to = block.to; } else { from = renderToSource(doc.model, selection.from, 1); to = renderToSource(doc.model, selection.to, -1); }
    } else {
      from = renderToSource(doc.model, selection.from, 1);
      to = selection.from === selection.to ? from : renderToSource(doc.model, selection.to, -1);
    }
  }
  from = Math.max(0, Math.min(from, source.length));
  to = Math.max(from, Math.min(to, source.length));
  if (from === 0 && source.startsWith('\uFEFF')) { from = 1; to = Math.max(1, to); }
  const model = modelContext(doc.model, from);
  const codeChain = model.blockChain.some(block => block.type === 'opaque' && block.node?.attrs?.kind === 'code');
  const render = origin === 'render' ? renderContext() : { inCell: false, inCode: false };
  return {
    from,
    to,
    origin,
    inCell: model.inCell || render.inCell,
    codeBlock: codeChain || (render.inCode && !render.inCell),
    inCode: codeChain || render.inCode || insideInlineCode(doc.model, from, to),
  };
}

function ensureCompositionSettled(doc: any): boolean {
  if (!doc.composition) return true;
  try { env().flushInline(doc); } catch { /* 提交失败时按仍组合处理 */ }
  if (doc.composition) {
    lastPaste = { origin: 'render', mode: 'blocked', ignored: 0, mergedTables: 0, skippedImages: 0, wording: '请先完成当前输入后再粘贴' };
    message('请先完成当前输入后再粘贴');
    return false;
  }
  return true;
}

function isBlockMarkdown(markdown: string): boolean {
  if (!markdown) return false;
  if (markdown.includes('\n\n')) return true;
  return markdown.split('\n').some(line => /^\s*(?:#{1,6}\s|`{3,}|~{3,}|[-+*]\s|\d{1,9}[.)]\s|>|\|)/.test(line));
}

function padBlockInsert(source: string, from: number, to: number, insert: string, newline: string): string {
  let prefix = '';
  let suffix = '';
  if (from > 0) {
    const before = source.slice(0, from);
    if (!/(?:^|\n)[ \t]*\n$/.test(before)) prefix = before.endsWith('\n') ? newline : newline + newline;
  }
  if (to < source.length) {
    const after = source.slice(to);
    if (!/^\n[ \t]*\n/.test(after)) suffix = after.startsWith('\n') ? newline : newline + newline;
  }
  return prefix + insert + suffix;
}

function performInsert(doc: any, target: PasteTarget, insert: string, block: boolean): void {
  if (!insert) return;
  const newline = newlineOf(doc.source);
  const value = block ? padBlockInsert(doc.source, target.from, target.to, insert, newline) : insert;
  env().structural({ from: target.from, to: target.to, insert: value }, undefined, target.origin);
}

function insertRawText(doc: any, target: PasteTarget, text: string): void {
  const newline = newlineOf(doc.source);
  const raw = text.replace(/\r\n|\r/g, '\n');
  const insert = target.codeBlock ? raw.replace(/\n/g, newline) : raw.replace(/\n/g, ' ');
  if (!insert) return;
  // 代码内容不转义、不加段落边界，保持用户原始文本。
  env().structural({ from: target.from, to: target.to, insert }, undefined, target.origin);
}

function insertPlainText(doc: any, target: PasteTarget, text: string): void {
  let value = text.replace(/\r\n|\r/g, '\n');
  if (target.inCell) value = value.replace(/[ \t]*\n+[ \t]*/g, ' ').trim();
  if (!value.trim()) return;
  const markdown = plainTextToMarkdown(value);
  if (!markdown) return;
  const newline = newlineOf(doc.source);
  const block = !target.inCell && isBlockMarkdown(markdown);
  performInsert(doc, target, markdown.replace(/\n/g, newline), block);
}

function insertMarkdown(doc: any, target: PasteTarget, markdown: string): void {
  const value = markdown.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
  if (!value.trim()) return;
  const newline = newlineOf(doc.source);
  const block = !target.inCell && isBlockMarkdown(value);
  performInsert(doc, target, value.replace(/\n/g, newline), block);
}

function ignoredNotice(conversion: HtmlConversion): string {
  const parts: string[] = [];
  if (conversion.ignored) parts.push(`已忽略 ${conversion.ignored} 项格式`);
  if (conversion.mergedTables) parts.push(`${conversion.mergedTables} 个合并单元格表格已降级为文本`);
  if (conversion.skippedImages) parts.push(`已跳过 ${conversion.skippedImages} 个无法读取的图片`);
  return parts.length ? `，${parts.join('，')}` : '';
}

async function persistPasteImage(doc: any, image: PasteImage): Promise<string | null> {
  let dataUrl: string | null = null;
  if (image.kind === 'data') {
    dataUrl = image.src;
  } else {
    // Word 临时文件图片：先尝试按文档资源/绝对路径读取，读不到由调用方跳过并提示。
    const resolved = await env().resolveImage(doc, image.src);
    if (!resolved) return null;
    if (/^data:image\//i.test(resolved)) dataUrl = resolved;
    else if (/^https?:/i.test(resolved)) return resolved;
    else return null;
  }
  const source = dataUrl;
  if (!source) return null;
  const match = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(source.replace(/\s/g, ''));
  try {
    let bytes: Uint8Array;
    let extension: string;
    if (match) {
      const mime = match[1].toLowerCase();
      extension = mime === 'jpeg' || mime === 'jpg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime;
      const binary = atob(match[2].replace(/\s+/g, ''));
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    } else {
      const response = await fetch(dataUrl);
      if (!response.ok) return null;
      bytes = new Uint8Array(await response.arrayBuffer());
      extension = (/^image\/([a-z0-9.+-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'png').toLowerCase();
      if (extension === 'jpeg') extension = 'jpg';
    }
    if (!bytes.length) return null;
    const saved = await saveImage(doc, bytes, extension);
    return savedImageSource(saved);
  } catch (reason) {
    console.warn('MDRE 粘贴图片写入全局图片库失败', reason);
    return null;
  }
}

async function materializePasteImages(doc: any, conversion: HtmlConversion): Promise<string> {
  let markdown = conversion.markdown;
  let skipped = 0;
  for (const image of conversion.images) {
    const destination = await persistPasteImage(doc, image).catch(() => null);
    if (destination) markdown = markdown.split(image.token).join(imageMarkdown(image.alt || '图片', destination));
    else { markdown = markdown.split(image.token).join(''); skipped++; }
  }
  conversion.skippedImages += skipped;
  return markdown;
}

function fallbackPlainPaste(doc: any, target: PasteTarget, payload: { html: string; text: string }, wording: string, origin: Origin): void {
  const plain = payload.text?.replace(/\r\n|\r/g, '\n') || htmlToPlainText(payload.html);
  insertPlainText(doc, target, plain);
  lastPaste = { origin, mode: 'plain', ignored: 0, mergedTables: 0, skippedImages: 0, wording };
  message(wording);
}

async function handleHtmlPaste(doc: any, origin: Origin, payload: { html: string; text: string }): Promise<void> {
  if (!ensureCompositionSettled(doc)) return;
  const target = locateTarget(doc, origin);
  if (!target) { message('未找到插入位置'); return; }
  const plainSource = payload.text?.replace(/\r\n|\r/g, '\n') ?? '';
  try {
    // 代码块/行内代码内：按纯文本处理，不做 HTML 转换。
    if (target.inCode) {
      const raw = plainSource || htmlToPlainText(payload.html);
      if (!raw.trim()) { message('剪贴板没有可粘贴的文本'); return; }
      insertRawText(doc, target, raw);
      lastPaste = { origin, mode: 'code', ignored: 0, mergedTables: 0, skippedImages: 0, wording: '代码内容已按纯文本粘贴' };
      message('代码内容已按纯文本粘贴');
      return;
    }
    const bytes = byteLength(payload.html);
    if (bytes > CLIPBOARD_HTML_LIMIT) { fallbackPlainPaste(doc, target, payload, '剪贴板 HTML 超过 5 MB，已按纯文本粘贴', origin); return; }
    let conversion: HtmlConversion;
    try {
      conversion = htmlToMarkdown(payload.html);
    } catch (reason) {
      console.warn('MDRE 剪贴板 HTML 转换失败', reason);
      fallbackPlainPaste(doc, target, payload, 'HTML 转换失败，已按纯文本粘贴', origin);
      return;
    }
    if (conversion.oversized) { fallbackPlainPaste(doc, target, payload, '剪贴板 HTML 超过 5 MB，已按纯文本粘贴', origin); return; }
    if (conversion.overImageLimit || conversion.images.length > CLIPBOARD_IMAGE_LIMIT) {
      fallbackPlainPaste(doc, target, payload, `剪贴板图片超过 ${CLIPBOARD_IMAGE_LIMIT} 张，已按纯文本粘贴`, origin);
      return;
    }
    if (!conversion.markdown.trim()) { fallbackPlainPaste(doc, target, payload, '剪贴板 HTML 没有可用内容，已按纯文本粘贴', origin); return; }
    let markdown = conversion.markdown;
    if (conversion.images.length) markdown = await materializePasteImages(doc, conversion);
    if (!markdown.trim()) { fallbackPlainPaste(doc, target, payload, '剪贴板图片无法读取，已按纯文本粘贴', origin); return; }
    const notice = ignoredNotice(conversion);
    // 表格单元格只能容纳行内内容：复杂结构降级为纯文本。
    if (target.inCell && isBlockMarkdown(markdown)) {
      const plain = plainSource || htmlToPlainText(payload.html);
      insertPlainText(doc, target, plain);
      const wording = `表格单元格内复杂内容已降级为纯文本${notice}`;
      lastPaste = { origin, mode: 'cell', ignored: conversion.ignored, mergedTables: conversion.mergedTables, skippedImages: conversion.skippedImages, wording };
      message(wording);
      return;
    }
    insertMarkdown(doc, target, markdown);
    const wording = `已转换为 Markdown 并粘贴${notice}`;
    lastPaste = { origin, mode: 'html', ignored: conversion.ignored, mergedTables: conversion.mergedTables, skippedImages: conversion.skippedImages, wording };
    message(wording);
  } catch (reason) {
    lastPaste = { origin, mode: 'failed', ignored: 0, mergedTables: 0, skippedImages: 0, wording: '粘贴失败，原文未改变' };
    message('粘贴失败，原文未改变');
    unsupported(reason);
  }
}

function pasteInterceptor(event: ClipboardEvent, origin: Origin): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const html = data.getData('text/html');
  if (!html || !html.trim()) return false; // 无 HTML：保持原有纯文本/图片粘贴流程
  if ((data.files?.length ?? 0) > 0) return false; // 截图、图片文件交给原图片粘贴流程
  const doc = activeDocument();
  if (!doc || doc.welcome || doc.readOnly) return false;
  const text = data.getData('text/plain') ?? '';
  // 必须同步读取 clipboardData，再异步转换与写入。
  event.preventDefault();
  void handleHtmlPaste(doc, origin, { html, text }).catch(reason => { unsupported(reason); });
  return true;
}

async function readClipboardPayload(): Promise<{ html: string; text: string } | null> {
  const clipboard = navigator.clipboard as any;
  if (clipboard?.read) {
    try {
      const items = await clipboard.read() as any[];
      let html = '';
      let text = '';
      for (const item of items) {
        const types: string[] = Array.from(item.types ?? []);
        if (!html && types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (!text && types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
      if (html || text) return { html, text };
    } catch (reason) {
      console.warn('MDRE 剪贴板 HTML 读取失败，退回宿主纯文本', reason);
    }
  }
  try {
    return { html: '', text: await env().readText() };
  } catch {
    return null;
  }
}

async function menuPasteHandler(): Promise<boolean> {
  const doc = activeDocument();
  if (!doc || doc.welcome || doc.readOnly) return false;
  const payload = await readClipboardPayload();
  if (!payload?.html?.trim()) return false; // 没有 HTML：交回原有菜单粘贴
  const origin: Origin = lastMenuOrigin ?? (doc.selection?.active === 'source' ? 'source' : 'render');
  await handleHtmlPaste(doc, origin, payload);
  return true;
}

// ───────────────────────────── 初始化与测试桥 ─────────────────────────────

export function initClipboard(): void {
  editorContextHooks.push(contextHook);
  pasteInterceptors.push(pasteInterceptor);
  menuPasteHandlers.push(menuPasteHandler);
  document.addEventListener('keydown', shortcutKeydown, true);
  // 浏览器 harness / 插件预览的验收桥：只暴露本模块的纯转换与显式操作，不改变应用行为。
  Object.assign(window as unknown as Record<string, unknown>, {
    mdreClipboard: {
      convert: (html: string) => htmlToMarkdown(html),
      sanitize: (html: string) => sanitizeClipboardHtml(html),
      plain: (html: string) => htmlToPlainText(html),
      copyRichText: () => copyRichToClipboard(),
      pasteHtml: (html: string, text = '', origin?: Origin) => {
        const doc = activeDocument();
        if (!doc) return Promise.reject(new Error('没有活动文档。'));
        return handleHtmlPaste(doc, origin ?? (doc.selection?.active === 'source' ? 'source' : 'render'), { html, text });
      },
      last: () => lastPaste,
      limits: { html: CLIPBOARD_HTML_LIMIT, images: CLIPBOARD_IMAGE_LIMIT },
    },
  });
}
