import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DocumentSession } from './session';
import { absoluteImagePath, imageFileUri } from './image-path';
export { imageMarkdown } from './image-path';

export type SavedImage = { relativePath: string; absolutePath: string; resourceRoot: string; bytes: number; hash: string; deduplicated: boolean; fallback?: boolean };
const resolved = new Map<string, string>();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export function imageExtension(file: File): string {
  const type = file.type.toLowerCase();
  const fromType = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.exec(type)?.[1];
  if (fromType) return fromType === 'jpeg' ? 'jpg' : fromType === 'svg+xml' ? 'svg' : fromType;
  return /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? 'png';
}
export function savedImageSource(saved: SavedImage): string { return saved.fallback ? saved.relativePath : imageFileUri(saved.absolutePath); }
// 无原始文件的截图先写入持久图片目录，assets 只作为失败后的兜底。
export async function saveImage(doc: DocumentSession, bytes: Uint8Array, extension: string): Promise<SavedImage> {
  if (!isTauri()) throw new Error('图片落盘需要桌面应用。');
  const directory = doc.path ? doc.path.replace(/[\\/][^\\/]*$/, '') : null;
  const saved = await invoke<SavedImage>('save_image', { request: { docId: doc.id, base64: base64(bytes), extension, directory } });
  const currentDirectory = doc.path ? doc.path.replace(/[\\/][^\\/]*$/, '') : null;
  if (saved.fallback && currentDirectory && currentDirectory !== directory) {
    const copied = await invoke<{ absolutePath: string }>('copy_resource', { source: saved.absolutePath, relative: saved.relativePath, directory: currentDirectory });
    saved.absolutePath = copied.absolutePath; saved.resourceRoot = `${currentDirectory}/assets`;
  }
  if (saved.fallback) { doc.resourceRoot = saved.resourceRoot; doc.resources.add(saved.relativePath); }
  return saved;
}
export function resourceRootOf(doc: DocumentSession): string | null {
  return doc.resourceRoot ?? (doc.path ? `${doc.path.replace(/[\\/][^\\/]*$/, '')}/assets` : doc.recoveryRoot ? `${doc.recoveryRoot}/assets` : null);
}
// 预览按文档的临时资源根解析相对路径；远程与 data URL 直接放行。
export async function resolveImage(doc: DocumentSession, src: string): Promise<string | null> {
  if (/^(?:data:|https?:)/i.test(src)) return src;
  const absolute = absoluteImagePath(/^file:/i.test(src) ? src : decodeURIComponent(src));
  if (absolute) {
    if (!isTauri()) return null;
    const key = imageFileUri(src), cached = resolved.get(key); if (cached) return cached;
    const url = await invoke<string>('read_binary', { path: absolute }); resolved.set(key, url); return url;
  }
  const root = resourceRootOf(doc);
  if ((!root && !doc.path) || !isTauri()) return null;
  const key = `${root}|${src}`;
  const cached = resolved.get(key);
  if (cached) return cached;
  const relative = decodeURIComponent(src);
  const url = doc.path ? await invoke<string>('read_document_image', { path: doc.path, relative }) : await invoke<string>('read_image', { resourceRoot: root, relative });
  resolved.set(key, url);
  return url;
}
export function clearResolvedImages() { resolved.clear(); }
