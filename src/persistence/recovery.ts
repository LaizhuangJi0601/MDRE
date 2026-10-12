import { invoke, isTauri } from '@tauri-apps/api/core';
import { DocumentSession, type ReadingAnchor, type Selection, type Workspace } from '../session';
import { parse } from '../model';

export type RecoverySnapshot = {
  schema: 1; id: string; title: string; path: string | null; source: string; originalText: string;
  revision: number; encoding: string; bom: boolean; savedFingerprint: string; diskFingerprint: string | null;
  selection: Selection; readingAnchor: ReadingAnchor | null; sourceScroll: { top: number; left: number };
  resourceOwners: string[]; updatedAt: number;
  recoveryRoot?: string;
  savedText?: string;
};
export type RecoveryResult = { root: string; revision: number };
export type RecoveryRead = { snapshots: RecoverySnapshot[]; errors: string[]; root: string };
export const snapshot = (doc: DocumentSession): RecoverySnapshot => ({
  schema: 1, id: doc.id, title: doc.title, path: doc.path, source: doc.source, originalText: doc.originalText,
  revision: doc.revision, encoding: doc.encoding, bom: doc.bom, savedFingerprint: doc.savedFingerprint, diskFingerprint: doc.diskFingerprint,
  selection: structuredClone(doc.selection), readingAnchor: structuredClone(doc.readingAnchor), sourceScroll: { ...doc.sourceScroll },
  resourceOwners: [...doc.resources].sort(), updatedAt: Date.now(), savedText: doc.savedText,
});
export function restore(record: RecoverySnapshot, root: string): DocumentSession {
  const doc = new DocumentSession(record.id, record.originalText, {
    title: record.title, path: record.path, encoding: record.encoding, bom: record.bom,
    diskFingerprint: record.diskFingerprint, savedText: record.savedText ?? record.originalText,
  });
  doc.source = record.source; doc.model = parse(record.source); doc.revision = record.revision;
  doc.selection = structuredClone(record.selection); doc.readingAnchor = record.readingAnchor; doc.sourceScroll = record.sourceScroll;
  doc.resources = new Set(record.resourceOwners ?? []);
  doc.recovered = true; doc.recoveryRevision = record.revision; doc.recoveryRoot = record.recoveryRoot ?? root; doc.recoveryState = 'ready';
  return doc;
}
// 不可变快照串行提交；完成时只确认该快照版本，不改变正式保存基准。
export class RecoveryManager {
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private workspace: Workspace, private changed: () => void, private write = (record: RecoverySnapshot) => invoke<RecoveryResult>('write_recovery', { snapshot: record })) {}
  start() { this.timer = setInterval(() => void this.flush(), 60_000); }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      for (const doc of this.workspace.documents.values()) {
        if (!doc.needsRecovery) continue;
        // 已绑定文件且没有未保存内容时不需要恢复快照：这类快照会在下次启动把文件“复活”成重复标签。
        if (doc.path && !doc.dirty && !doc.recovered) continue;
        const record = snapshot(doc);
        doc.recoveryState = 'writing'; this.changed();
        try {
          const result = await this.write(record);
          // 同版本另存为也会改变路径和保存基准，旧写入不能清掉较新的恢复需求。
          doc.recoveryRevision = record.path === doc.path && record.encoding === doc.encoding && record.savedText === doc.savedText ? record.revision : -1; doc.recoveryRoot = result.root;
          doc.recoveryState = 'ready'; doc.recoveryError = '';
        } catch (reason) { doc.recoveryState = 'failed'; doc.recoveryError = String(reason); }
        this.changed();
      }
    });
    return this.queue;
  }
}
export async function readRecovery(): Promise<RecoveryRead> {
  if (!isTauri()) return { root: '', snapshots: [], errors: ['浏览器预览不提供桌面恢复快照。'] };
  try { return await invoke<RecoveryRead>('read_recovery'); }
  catch (reason) { return { root: '', snapshots: [], errors: [`读取恢复快照失败：${String(reason)}`] }; }
}
