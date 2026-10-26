import { parse, normalize, type Model, type Range } from './model';
import { patch, difference, type Patch } from './edits';
import { projectSelection, mapOffset } from './mapping';

export type Selection = { source: Range; render: Range; active: 'source' | 'render' };
export type Ticket = { docId: string; revision: number; transactionId: number; origin: string };
export type SaveState = 'saved' | 'pending' | 'unbound' | 'conflict' | 'failed';
type History = { forward: Patch; inverse: Patch; before: Selection; after: Selection };
export type Draft = Ticket & { range: Range; text: string };
export type ReadingAnchor = { block: string; source: number; offset: number };
export type SessionOptions = { title?: string; path?: string | null; encoding?: string; bom?: boolean; diskFingerprint?: string | null; savedText?: string };
export function fingerprint(text: string): string {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, '0');
}
const initialSelection = (): Selection => ({ source: { from: 0, to: 0 }, render: { from: 1, to: 1 }, active: 'source' });
export class DocumentSession {
  revision = 0;
  transactionId = 0;
  readonly originalBytes: Uint8Array;
  readonly originalText: string;
  source: string;
  model: Model;
  selection = initialSelection();
  readOnly = false;
  welcome = false;
  parseMs = 0;
  renderMs = 0;
  composition: 'source' | 'render' | null = null;
  title: string;
  path: string | null;
  encoding: string;
  bom: boolean;
  savedText: string;
  savedFingerprint: string;
  diskFingerprint: string | null;
  saveStatus: 'idle' | 'saving' | 'conflict' | 'failed' = 'idle';
  fileOperation = false;
  modelStale = false;
  saveError = '';
  discarded = false;
  recoveryRevision = -1;
  recoveryRoot: string | null = null;
  resourceRoot: string | null = null;
  resources = new Set<string>();
  recoveryState: 'pending' | 'writing' | 'ready' | 'failed' = 'pending';
  recoveryError = '';
  recovered = false;
  renderRevision = -1;
  readingAnchor: ReadingAnchor | null = null;
  sourceScroll = { top: 0, left: 0 };
  private undoEntries: History[] = [];
  private redoEntries: History[] = [];
  constructor(readonly id: string, bytes: Uint8Array | string, options: SessionOptions = {}) {
    this.originalBytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice();
    this.originalText = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    this.source = this.originalText;
    this.model = this.parseModel(this.source);
    this.title = options.title ?? id;
    this.path = options.path ?? null;
    this.encoding = options.encoding ?? 'utf-8';
    this.bom = options.bom ?? this.source.startsWith('\uFEFF');
    this.savedText = options.savedText ?? this.originalText;
    this.savedFingerprint = fingerprint(this.savedText);
    this.diskFingerprint = options.diskFingerprint !== undefined ? options.diskFingerprint : this.path ? this.savedFingerprint : null;
  }
  get dirty() { return this.source !== this.savedText; }
  get saveState(): SaveState {
    if (this.saveStatus === 'conflict') return 'conflict';
    if (this.saveStatus === 'failed') return 'failed';
    if (this.dirty) return 'pending';
    return this.path ? 'saved' : 'unbound';
  }
  get needsRecovery() { return !this.welcome && !this.discarded && !this.composition && this.recoveryRevision !== this.revision && (this.revision > 0 || this.recovered || this.dirty || !!this.source); }
  get historySize() { return this.undoEntries.length; }
  // 保存成功后绑定路径与磁盘基准；保存期间的新修改不会被清掉脏标记。
  markSaved(path: string, fingerprintValue: string, text: string, encoding = this.encoding) {
    if (path !== this.path || text !== this.savedText || encoding !== this.encoding) this.recoveryRevision = -1;
    this.path = path; this.encoding = encoding; this.bom = text.startsWith('\uFEFF');
    this.savedText = text; this.savedFingerprint = fingerprint(text); this.diskFingerprint = fingerprintValue;
    this.title = path.replace(/^.*[\\/]/, '');
    this.recovered = false;
    this.saveStatus = 'idle'; this.saveError = '';
  }
  markConflict(message: string, disk: string | null) { this.saveStatus = 'conflict'; this.saveError = message; this.diskFingerprint = disk; }
  markFailed(message: string) { this.saveStatus = 'failed'; this.saveError = message; }
  clearFailure() { if (this.saveStatus !== 'conflict') this.saveStatus = 'idle'; this.saveError = ''; }
  // 冲突后按磁盘内容重新载入：丢弃本地未保存修改与历史，保留标签身份。
  reloadFrom(text: string, fingerprintValue: string, encoding: string) {
    this.recovered = false;
    this.source = text; this.model = this.parseModel(text); this.modelStale = false; this.savedText = text; this.savedFingerprint = fingerprint(text);
    this.diskFingerprint = fingerprintValue; this.encoding = encoding; this.bom = text.startsWith('\uFEFF');
    this.undoEntries = []; this.redoEntries = []; this.revision++; this.transactionId++;
    this.saveStatus = 'idle'; this.saveError = '';
  }
  ticket(origin: string): Ticket { return { docId: this.id, revision: this.revision, transactionId: this.transactionId, origin }; }
  current(ticket: Ticket): boolean { return ticket.docId === this.id && ticket.revision === this.revision && ticket.transactionId === this.transactionId; }
  bytes(): Uint8Array { return !this.dirty ? this.originalBytes.slice() : new TextEncoder().encode(this.source); }
  commit(ticket: Ticket, edit: Patch, after: Selection = this.selection, expected?: Model): void {
    if (this.readOnly) throw new Error('当前为只读模式，修改未提交。');
    if (!this.current(ticket)) throw new Error('文档版本已变化，修改未提交；草稿已保留。');
    if (this.composition && ticket.origin !== `composition-${this.composition}`) throw new Error('请先提交当前组合输入，修改未提交。');
    const source = patch(this.source, edit);
    if (source === this.source) return;
    const next = expected || this.parseModel(source, this.model, edit);
    if (expected) this.parseMs = 0;
    if (next.source !== source) throw new Error('补丁与模型不一致。');
    after = projectSelection(next, after);
    const entry = { forward: edit, inverse: { from: edit.from, to: edit.from + edit.insert.length, insert: this.source.slice(edit.from, edit.to) }, before: structuredClone(this.selection), after: structuredClone(after) };
    this.undoEntries.push(entry);
    if (this.undoEntries.length > 500) this.undoEntries.shift();
    this.redoEntries = [];
    this.source = source; this.model = next; this.modelStale = false; this.selection = after; this.revision++; this.transactionId++;
    if (this.readingAnchor) this.readingAnchor.source = next.blocks.find(b => b.id === this.readingAnchor!.block)?.from ?? mapOffset(this.readingAnchor.source, edit);
  }
  changeSource(text: string, after: Selection = this.selection): void { this.commit(this.ticket('source'), difference(this.source, text), after); }
  // 5.1.5 大文档降级：只提交源码与历史，模型留到手动刷新时重建（模型过期期间结构命令拒绝执行）。
  liteCommit(ticket: Ticket, edit: Patch, after: Selection = this.selection): void {
    if (this.readOnly) throw new Error('当前为只读模式，修改未提交。');
    if (!this.current(ticket)) throw new Error('文档版本已变化，修改未提交；草稿已保留。');
    const source = patch(this.source, edit);
    if (source === this.source) return;
    const entry = { forward: edit, inverse: { from: edit.from, to: edit.from + edit.insert.length, insert: this.source.slice(edit.from, edit.to) }, before: structuredClone(this.selection), after: structuredClone(after) };
    this.undoEntries.push(entry);
    if (this.undoEntries.length > 500) this.undoEntries.shift();
    this.redoEntries = [];
    this.source = source; this.selection = after; this.revision++; this.transactionId++;
    this.modelStale = true;
  }
  refreshModel(): void {
    if (!this.modelStale) return;
    this.model = this.parseModel(this.source);
    this.modelStale = false;
  }
  undo(): void { this.travel(this.undoEntries, this.redoEntries, true); }
  redo(): void { this.travel(this.redoEntries, this.undoEntries, false); }
  private travel(from: History[], to: History[], undo: boolean): void {
    if (this.readOnly) throw new Error('当前为只读模式，撤销/重做未执行。');
    if (this.composition) throw new Error('请先提交当前组合输入，撤销/重做未执行。');
    const entry = from.at(-1); if (!entry) return;
    const edit = undo ? entry.inverse : entry.forward, source = patch(this.source, edit), next = this.parseModel(source, this.model, edit);
    from.pop(); to.push(entry); this.source = source; this.model = next; this.modelStale = false;
    this.selection = structuredClone(undo ? entry.before : entry.after); this.revision++; this.transactionId++;
    if (this.readingAnchor) this.readingAnchor.source = next.blocks.find(b => b.id === this.readingAnchor!.block)?.from ?? mapOffset(this.readingAnchor.source, edit);
  }
  draft(range: Range): Draft { return { ...this.ticket('dialog'), range, text: this.source.slice(range.from, range.to) }; }
  confirm(draft: Draft) { this.commit(draft, { ...draft.range, insert: draft.text }); }
  viewToSource(offset: number): number { return normalize(this.source).offsets[offset]; }
  private parseModel(source: string, previous?: Model, edit?: Patch) {
    const started = performance.now();
    const model = parse(source, previous, edit);
    this.parseMs = performance.now() - started;
    return model;
  }
}
export class Workspace {
  documents = new Map<string, DocumentSession>();
  activeId = '';
  pendingSwitch: string | null = null;
  add(doc: DocumentSession) {
    if (this.documents.has(doc.id)) throw new Error('同名文档已打开，请先返回原文档。');
    this.documents.set(doc.id, doc); if (!this.activeId) this.activeId = doc.id;
  }
  get active() { return this.documents.get(this.activeId)!; }
  switchTo(id: string): boolean {
    if (!this.documents.has(id)) throw new Error('文档不存在。');
    if (this.active?.composition) { this.pendingSwitch = id; return false; }
    this.activeId = id; this.pendingSwitch = null; return true;
  }
  compositionEnded() { this.active.composition = null; if (this.pendingSwitch) this.switchTo(this.pendingSwitch); }
  accept(ticket: Ticket): boolean { return ticket.docId === this.activeId && !!this.active && this.active.current(ticket); }
  // A-10/D-16：标签顺序与内容无关，只调整 Map 的迭代顺序。
  reorder(id: string, targetId: string) {
    const entries = [...this.documents.entries()];
    const from = entries.findIndex(([key]) => key === id), to = entries.findIndex(([key]) => key === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = entries.splice(from, 1);
    entries.splice(to, 0, moved);
    this.documents = new Map(entries);
  }
  remove(id: string, nextId: string | null = null) {
    if (!this.documents.has(id)) return;
    this.documents.delete(id);
    if (this.activeId === id || !this.documents.has(this.activeId)) this.activeId = nextId && this.documents.has(nextId) ? nextId : this.documents.keys().next().value ?? '';
  }
}
