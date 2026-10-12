import { invoke, isTauri } from '@tauri-apps/api/core';
import { DocumentSession, type Workspace } from '../session';
import { resourceRootOf } from '../assets';
import { parse } from '../model';
import { settings } from './settings';

export type WrittenText = { path: string; fingerprint: string; bytes: number };
export type WriteFailure = { kind: 'conflict' | 'io' | 'encoding'; message: string; diskFingerprint?: string | null; exists?: boolean };
export type SaveChoice = { onMissingResources?: (missing: string[]) => Promise<boolean> };
export type SaveOptions = { path?: string; overwrite?: boolean; choice?: SaveChoice };
export type ReadTextFile = { path: string; text: string; encoding: string; bom: boolean; newline: string; fingerprint: string; bytes: number };

export const directoryOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '');
export function pathKey(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').split('/')) { if (part === '.') continue; if (part === '..' && parts.length > 1) parts.pop(); else parts.push(part); }
  return parts.join('/').replace(/\/+$/, '').toLowerCase();
}
export const samePath = (left: string | null, right: string | null): boolean => {
  if (!left || !right) return false;
  return pathKey(left) === pathKey(right);
};

// E.1：同一路径串行保存；过期快照合并为最新内容，旧写入完成不清除新修改的脏标记。
export class SaveQueue {
  private chains = new Map<string, Promise<void>>();
  private documents = new Map<string, Promise<void>>();
  constructor(private changed: () => void) {}
  pending(): boolean { return this.chains.size > 0; }
  async save(doc: DocumentSession, options: SaveOptions = {}): Promise<WrittenText> {
    if (doc.fileOperation) throw new Error('文件操作正在进行，请稍后保存。');
    if (!isTauri()) throw new Error('保存需要桌面应用。');
    const target = options.path ?? doc.path;
    if (!target) throw new Error('当前文档还没有文件路径，请使用「另存为」。');
    const key = pathKey(target);
    const previous = Promise.all([this.chains.get(key), this.documents.get(doc.id)]);
    let result: WrittenText | null = null;
    const task = previous.then(async () => { result = await this.write(doc, target, options); }, async () => { result = await this.write(doc, target, options); });
    const clear = () => { if (this.chains.get(key) === finished) this.chains.delete(key); if (this.documents.get(doc.id) === finished) this.documents.delete(doc.id); };
    const finished = task.then(clear, clear);
    this.chains.set(key, finished); this.documents.set(doc.id, finished);
    await task;
    return result!;
  }
  private async write(doc: DocumentSession, target: string, options: SaveOptions): Promise<WrittenText> {
    const snapshot = doc.source, revision = doc.revision;
    const firstSave = !samePath(doc.path, target);
    doc.saveStatus = 'saving'; this.changed();
    try {
    // E-8/S-43：覆盖已有文件前先轮转 .bak；备份失败即中止保存，不静默继续。
    if (!firstSave) await invoke('rotate_backup', { path: target, copies: settings().backup_count });
    const missing = firstSave ? await this.copyResources(doc, target, snapshot) : [];
    if (missing.length && options.choice?.onMissingResources) {
      const proceed = await options.choice.onMissingResources(missing);
      if (!proceed) throw new Error(`有 ${missing.length} 张图片缺失，已取消保存：${missing.join('、')}`);
    } else if (missing.length) {
      throw new Error(`有 ${missing.length} 张图片缺失，未保存：${missing.join('、')}`);
    }
      const written = await invoke<WrittenText>('write_text_file', {
        request: {
          path: target, text: snapshot, encoding: doc.encoding, bom: doc.bom,
          expectedFingerprint: firstSave ? null : doc.diskFingerprint,
          overwrite: firstSave || !!options.overwrite,
        },
      });
      doc.markSaved(written.path, written.fingerprint, snapshot);
      if (firstSave) doc.resourceRoot = `${directoryOf(written.path)}/assets`;
      if (doc.revision !== revision) doc.saveStatus = 'idle';
      this.changed();
      return written;
    } catch (failure) {
      const detail = failure as WriteFailure;
      if (detail?.kind === 'conflict') doc.markConflict(detail.message ?? '保存冲突', detail.diskFingerprint ?? null);
      else { doc.markFailed(detail?.message ?? String(failure)); doc.saveStatus = detail?.kind === 'encoding' ? 'failed' : 'failed'; }
      this.changed();
      throw failure;
    }
  }
  // D.1：首次保存/另存为先把被引用图片复制到目标 assets/，缺失的列出来交给调用方决定。
  private async copyResources(doc: DocumentSession, target: string, snapshot: string): Promise<string[]> {
    const model = doc.model.source === snapshot ? doc.model : parse(snapshot);
    const references = new Set(model.atoms.filter(atom => atom.kind === 'image').map(atom => String(model.doc.nodeAt(atom.pos)!.attrs.src)).filter(src => !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)));
    if (!references.size) return [];
    const root = resourceRootOf(doc);
    if (!root && !doc.path) return [...references];
    const directory = directoryOf(target), missing: string[] = [];
    for (const reference of references) {
      const relative = decodeURIComponent(reference).replace(/^\.\//, '');
      const source = doc.path ? `${directoryOf(doc.path)}/${relative}` : `${root!.replace(/[\\/]+$/, '')}/${relative.replace(/^assets\//, '')}`;
      try { await invoke('copy_resource', { source, relative, directory }); }
      catch (error) { if (String(error).includes('名称冲突')) throw error; missing.push(relative); }
    }
    return missing;
  }
  async flush(): Promise<void> { await Promise.all([...this.chains.values()]); }
}
export async function readTextFile(path: string): Promise<ReadTextFile> { return invoke<ReadTextFile>('read_text_file', { path }); }
export async function pickFile(save: boolean, suggested?: string): Promise<string | null> { return invoke<string | null>('pick_file', { save, suggested: suggested ?? null }); }
export async function discardRecovery(docId: string): Promise<void> { await invoke('discard_recovery', { docId }); }
// 恢复目录名是 docId 的哈希，合并重复快照时直接用快照记录的目录，避免哈希算法在两侧重复实现。
export async function discardRecoveryAt(directory: string): Promise<void> { await invoke('discard_recovery_dir', { directory }); }
// B-12/D-22：默认每 1 分钟扫描所有未落盘文档，与前台无关；失败与冲突保留可见状态。
export async function autosaveAll(workspace: Workspace, queue: SaveQueue, changed: () => void): Promise<void> {
  for (const doc of workspace.documents.values()) {
    if (!doc.dirty || doc.recovered || doc.composition || doc.fileOperation || !doc.path || doc.saveStatus === 'saving' || doc.saveStatus === 'conflict') continue;
    try { await queue.save(doc); } catch { changed(); }
  }
}
export function startAutosave(workspace: Workspace, queue: SaveQueue, changed: () => void, interval = 60_000) {
  return setInterval(() => void autosaveAll(workspace, queue, changed), interval);
}
