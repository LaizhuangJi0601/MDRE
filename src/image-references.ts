// MDRE 0.2.5：图片引用收集（图片管理面板与可分享副本共用）。
// 只读取文档模型与文档元数据，不做任何 IO；平台差异（读取图片字节）由调用方通过 env.invoke 完成。
import { absoluteImagePath } from './image-path';

export type ImageReferenceKind = 'local' | 'remote' | 'data';

export type ImageReference = {
  /** Markdown 中的原始目标（可能包含百分号编码）。 */
  src: string;
  alt: string;
  /** 渲染文档中的节点位置；用于跳转到图片所在位置。 */
  pos: number;
  /** 列表展示名称：alt 优先，其次文件名，最后“图片 N”。 */
  name: string;
  kind: ImageReferenceKind;
  /** 本地图片的绝对路径；网络图片与内嵌图片为 null。 */
  absolutePath: string | null;
  /** 列表展示的“电脑中的路径”：绝对路径 / 原 URL / 内嵌图片提示。 */
  displayPath: string;
  /** 原文相对路径（zip 内可直接保留）；绝对路径、网络/内嵌或越出文档目录时为 null。 */
  relative: string | null;
  /** 图片在源码中的区间，用于改写 Markdown；无法定位时为 -1。 */
  sourceFrom: number;
  sourceTo: number;
};

const REMOTE = /^https?:\/\//i;
const DATA = /^data:/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** 取目录（统一正斜杠）；无法确定目录时返回 null。 */
export function directoryOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = toForwardSlashes(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return index === 0 ? '/' : null;
  return normalized.slice(0, index);
}

/** 拼接目录与相对路径，折叠 `.` 与可回退的 `..`（不越出目录）。 */
export function joinPath(directory: string, relative: string): string {
  const base = toForwardSlashes(directory);
  const combined = `${base.replace(/\/+$/, '')}/${toForwardSlashes(relative)}`;
  const drive = /^[A-Za-z]:/.exec(combined)?.[0] ?? '';
  const unc = combined.startsWith('//');
  const absolute = combined.startsWith('/') || unc;
  const stack: string[] = [];
  for (const part of combined.slice(drive.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(part);
  }
  if (drive) return `${drive}/${stack.join('/')}`;
  if (unc) return `//${stack.join('/')}`;
  return `${absolute ? '/' : ''}${stack.join('/')}`;
}

export function baseNameOf(path: string): string {
  const normalized = toForwardSlashes(path).replace(/[?#].*$/, '');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 相对路径（解码后）且不越出文档目录时返回 zip 内可直接使用的相对路径；否则 null。 */
export function documentRelativePath(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || REMOTE.test(trimmed) || DATA.test(trimmed) || /^file:/i.test(trimmed)) return null;
  if (WINDOWS_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed) || trimmed.startsWith('/')) return null;
  const decoded = safeDecode(trimmed);
  const stack: string[] = [];
  for (const part of toForwardSlashes(decoded).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!stack.length) return null; stack.pop(); continue; }
    stack.push(part);
  }
  return stack.length ? stack.join('/') : null;
}

/** 普通相对路径（允许 `..`，交给 joinPath 折叠）；绝对路径/网络/内嵌图片返回 null。 */
function plainRelativePath(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || REMOTE.test(trimmed) || DATA.test(trimmed) || /^file:/i.test(trimmed)) return null;
  if (WINDOWS_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed) || trimmed.startsWith('/')) return null;
  const decoded = toForwardSlashes(safeDecode(trimmed));
  return decoded || null;
}

/** 本地图片的绝对路径（图片不存在时不保证文件真实存在；`..` 相对路径按文档目录解析）。 */
export function absolutePathOfImage(doc: any, source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed || REMOTE.test(trimmed) || DATA.test(trimmed)) return null;
  const direct = /^file:/i.test(trimmed) ? absoluteImagePath(trimmed) : absoluteImagePath(safeDecode(trimmed));
  if (direct) return toForwardSlashes(direct);
  const relative = plainRelativePath(trimmed);
  if (!relative) return null;
  const documentDirectory = directoryOfPath(typeof doc?.path === 'string' ? doc.path : null);
  if (documentDirectory) return joinPath(documentDirectory, relative);
  const resourceRoot = toForwardSlashes(String(doc?.resourceRoot ?? '')).replace(/\/+$/, '');
  // 恢复区/无路径文档的资源根本身就是 assets 目录，源码里的 `assets/` 前缀不重复拼接。
  if (resourceRoot) return joinPath(resourceRoot, relative.replace(/^assets\//, ''));
  return null;
}

export function imageExtensionOf(source: string): string {
  const name = baseNameOf(safeDecode(source));
  return /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

function describeImage(doc: any, source: string, alt: string, pos: number, index: number): ImageReference {
  const trimmed = source.trim();
  const base = { src: source, alt, pos, sourceFrom: -1, sourceTo: -1 };
  if (DATA.test(trimmed)) {
    return {
      ...base,
      kind: 'data',
      name: alt.trim() || `内嵌图片 ${index + 1}`,
      absolutePath: null,
      displayPath: '内嵌图片（data URI）',
      relative: null,
    };
  }
  if (REMOTE.test(trimmed)) {
    return {
      ...base,
      kind: 'remote',
      name: alt.trim() || baseNameOf(trimmed) || `网络图片 ${index + 1}`,
      absolutePath: null,
      displayPath: trimmed,
      relative: null,
    };
  }
  const relative = documentRelativePath(trimmed);
  const absolutePath = absolutePathOfImage(doc, trimmed);
  const decoded = safeDecode(trimmed);
  const fallbackName = absolutePath ? baseNameOf(absolutePath) : baseNameOf(decoded);
  return {
    ...base,
    kind: 'local',
    name: alt.trim() || fallbackName || `图片 ${index + 1}`,
    absolutePath,
    displayPath: absolutePath ?? (relative || decoded || '（空图片地址）'),
    relative,
  };
}

function imageSourceAnchors(doc: any): { from: number; to: number }[] {
  const atoms = doc?.model?.atoms;
  if (!Array.isArray(atoms)) return [];
  const anchors: { from: number; to: number }[] = [];
  for (const atom of atoms) {
    if (atom?.kind !== 'image') continue;
    if (!Number.isInteger(atom.from) || !Number.isInteger(atom.to) || atom.to < atom.from) continue;
    anchors.push({ from: atom.from, to: atom.to });
  }
  return anchors;
}

/** 按文档引用顺序收集当前模型中的全部图片。 */
export function collectImageReferences(doc: any): ImageReference[] {
  const root = doc?.model?.doc;
  if (!root || typeof root.descendants !== 'function') return [];
  const references: ImageReference[] = [];
  let index = 0;
  root.descendants((node: any, pos: number) => {
    if (node?.type?.name !== 'image') return undefined;
    const source = String(node.attrs?.src ?? '');
    const alt = String(node.attrs?.alt ?? '');
    references.push(describeImage(doc, source, alt, pos, index));
    index += 1;
    return undefined;
  });
  const anchors = imageSourceAnchors(doc);
  if (anchors.length === references.length) {
    references.forEach((reference, position) => {
      reference.sourceFrom = anchors[position].from;
      reference.sourceTo = anchors[position].to;
    });
  }
  return references;
}
