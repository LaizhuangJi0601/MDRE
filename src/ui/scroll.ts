import type { EditorView as CMView } from '@codemirror/view';
import type { EditorView } from 'prosemirror-view';
import type { DocumentSession } from '../session';
import { viewOffset, sourceToRender, renderToSource } from '../mapping';
import { captureView } from './layout';

type Side = 'source' | 'render';
type Segment = { id: string; start: number; end: number };
type Anchor = { id: string; fraction: number; edge: 'top' | 'bottom' | null };

// 一次用户滚动只驱动另一栏；镜像滚动和布局变化不反向驱动。
export class ScrollSync {
  private driver: Side = 'source';
  private expected = new Map<Side, number>();
  private anchor: Anchor | null = null;
  private context = '';
  private frame = 0;
  private resetPending = false;
  private preservePending = false;
  private panes: Record<Side, HTMLElement>;
  constructor(private document: () => DocumentSession, private render: EditorView, private source: CMView, private ready: () => boolean) {
    this.panes = { source: source.scrollDOM, render: render.dom.closest<HTMLElement>('#render')! };
    this.panes.render.addEventListener('mdre:search-jump', () => { this.driver = 'render'; this.preservePending = false; this.expected.clear(); });
    for (const side of ['source', 'render'] as const) for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) this.panes[side].addEventListener(event, () => { this.driver = side; }, { passive: true });
    for (const side of ['source', 'render'] as const) this.panes[side].addEventListener('scroll', () => {
      const top = this.panes[side].scrollTop, expected = this.expected.get(side); this.expected.delete(side);
      if (expected !== undefined && Math.abs(top - expected) < 1) return;
      // CodeMirror 测量折行后也会自动调整滚动位置；只有用户输入决定驱动栏。
      this.preservePending = false; this.schedule();
    }, { passive: true });
    const observer = new ResizeObserver(() => { this.preservePending = true; this.schedule(); });
    observer.observe(render.dom); observer.observe(this.panes.source); observer.observe(this.panes.render);
  }
  reset() {
    this.resetPending = true;
    for (const side of ['source', 'render'] as const) this.expected.set(side, this.panes[side].scrollTop);
    this.schedule();
  }
  refresh() { this.schedule(); }
  private schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.sync(); }); }
  private segments(side: Side): Segment[] {
    const doc = this.document(), pane = this.panes[side], paneTop = pane.getBoundingClientRect().top;
    const leaves = doc.model.blocks.filter(b => b.node.isTextblock || b.node.isAtom).sort((a, b) => a.pos - b.pos);
    const result = leaves.flatMap(block => {
      if (side === 'source') {
        const from = this.source.lineBlockAt(viewOffset(doc.model, block.from)), to = this.source.lineBlockAt(viewOffset(doc.model, Math.max(block.from, block.to - 1)));
        const top = this.source.documentTop - paneTop + pane.scrollTop;
        return [{ id: block.id, start: top + from.top, end: top + to.bottom }];
      }
      const dom = this.render.nodeDOM(block.pos); if (!(dom instanceof HTMLElement)) return [];
      const rect = dom.getBoundingClientRect(); return [{ id: block.id, start: rect.top - paneTop + pane.scrollTop, end: rect.bottom - paneTop + pane.scrollTop }];
    });
    return result;
  }
  private read(side: Side, segments: Segment[]): Anchor | null {
    const pane = this.panes[side], top = pane.scrollTop;
    // 块间空白归属于下一个可见块，避免两栏顶部落在相邻的不同章节。
    const segment = segments.find(candidate => candidate.end > top) ?? segments.at(-1);
    if (!segment) return null;
    const max = pane.scrollHeight - pane.clientHeight;
    return { id: segment.id, fraction: Math.max(0, Math.min(1, (top - segment.start) / Math.max(1, segment.end - segment.start))), edge: top < 1 ? 'top' : max > 0 && top >= max - 1 ? 'bottom' : null };
  }
  private place(side: Side, anchor: Anchor, segments: Segment[]) {
    const segment = segments.find(s => s.id === anchor.id); if (!segment) return;
    const pane = this.panes[side], max = Math.max(0, pane.scrollHeight - pane.clientHeight);
    const top = anchor.edge === 'top' ? 0 : anchor.edge === 'bottom' ? max : Math.min(max, segment.start + anchor.fraction * (segment.end - segment.start));
    if (Math.abs(pane.scrollTop - top) < .5) return;
    pane.scrollTop = top; this.expected.set(side, pane.scrollTop);
  }
  private scrollTo(side: Side, top: number) {
    const pane = this.panes[side], target = Math.max(0, Math.min(top, pane.scrollHeight - pane.clientHeight));
    if (Math.abs(pane.scrollTop - target) < .5) return;
    pane.scrollTop = target; this.expected.set(side, pane.scrollTop);
  }
  private paperSync() {
    const doc = this.document(), from = this.panes[this.driver], follower = this.driver === 'source' ? 'render' : 'source';
    if (from.scrollTop < 1) { this.scrollTo(follower, 0); return; }
    if (this.driver === 'source') {
      const bounds = from.getBoundingClientRect();
      // 读取实际折行位置，避免长源码行被当成整个段落的开头。
      const pos = this.source.posAtCoords({ x: bounds.left + 64, y: bounds.top + 8 }, false)
        ?? this.source.lineBlockAtHeight(bounds.top - this.source.documentTop + 8).from;
      const raw = doc.model.offsets[Math.min(pos, doc.model.offsets.length - 1)], at = sourceToRender(doc.model, raw);
      const rect = this.render.coordsAtPos(at), pane = this.panes.render, viewport = pane.getBoundingClientRect();
      const sourceRect = this.source.coordsAtPos(pos), offset = sourceRect ? sourceRect.top - bounds.top : 8;
      this.scrollTo('render', pane.scrollTop + rect.top - viewport.top - offset);
      // 缩放后的多列纸张中，把对应列也移动到可见范围。
      if (rect.left < viewport.left + 8 || rect.right > viewport.right - 8) pane.scrollLeft += rect.left - viewport.left - 24;
      return;
    }
    const bounds = from.getBoundingClientRect(), walker = document.createTreeWalker(this.render.dom, NodeFilter.SHOW_TEXT);
    let best: { top: number; left: number; bottom: number; pos: number } | null = null;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!text.textContent?.trim() || text.parentElement?.closest('[contenteditable="false"]')) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        if (rect.bottom <= bounds.top + 8 || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
        const top = Math.max(rect.top, bounds.top + 8), left = Math.max(rect.left, bounds.left + 8);
        if (best && (top > best.top + 1 || Math.abs(top - best.top) <= 1 && left >= best.left)) continue;
        const hit = this.render.posAtCoords({ left: left + 1, top: Math.min(rect.bottom - 1, top + 2) });
        if (hit) best = { top, left, bottom: rect.bottom, pos: hit.pos };
      }
    }
    // 代码、公式等不可编辑原子块也能成为阅读锚点。
    for (const block of doc.model.blocks.filter(block => block.node.isAtom)) {
      const dom = this.render.nodeDOM(block.pos); if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect(), top = Math.max(rect.top, bounds.top + 8);
      if (rect.bottom <= bounds.top + 8 || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
      if (!best || top < best.top - 1) best = { top, left: rect.left, bottom: rect.bottom, pos: block.pos };
    }
    if (!best) return;
    const at = viewOffset(doc.model, renderToSource(doc.model, best.pos)), pane = this.panes.source, offset = best.top - bounds.top;
    const rect = this.source.coordsAtPos(at);
    this.scrollTo('source', rect ? pane.scrollTop + rect.top - pane.getBoundingClientRect().top - offset
      : this.source.documentTop - pane.getBoundingClientRect().top + pane.scrollTop + this.source.lineBlockAt(at).top - offset);
    // CodeMirror 虚拟行进入视口后，按实际字符位置完成第二次精确定位。
    const ticket = doc.ticket('scroll');
    this.source.requestMeasure({ read: () => this.source.coordsAtPos(at), write: rect => {
      if (!rect || !doc.current(ticket) || this.document() !== doc || this.driver !== 'render') return;
      this.scrollTo('source', pane.scrollTop + rect.top - pane.getBoundingClientRect().top - offset);
    } });
  }
  private sync() {
    const doc = this.document(); if (!doc) return;
    const renderOnly = doc.readOnly || !this.panes.source.getClientRects().length;
    const paper = this.panes.render.classList.contains('paper-mode');
    const context = `${doc.id}:${doc.revision}:${renderOnly}:${paper}`;
    if (!this.ready() || doc.composition) { this.preservePending = false; return; }
    if (this.resetPending || context !== this.context) {
      const restored = this.resetPending;
      this.resetPending = false; this.preservePending = false; this.context = context;
      this.driver = renderOnly || (restored && doc.readingAnchor) ? 'render' : doc.selection.active; this.anchor = null;
    }
    if (paper) {
      this.preservePending = false;
      if (!renderOnly) this.paperSync();
      captureView(doc, this.render, this.source); return;
    }
    if (renderOnly) {
      const segments = this.segments('render');
      if (this.preservePending && this.anchor) this.place('render', this.anchor, segments);
      this.preservePending = false; this.anchor = this.read('render', segments);
      captureView(doc, this.render, this.source); return;
    }
    const driver = this.segments(this.driver), follower = this.driver === 'source' ? 'render' : 'source';
    if (this.preservePending && this.anchor) this.place(this.driver, this.anchor, driver);
    this.preservePending = false;
    this.anchor = this.read(this.driver, driver);
    if (this.anchor) this.place(follower, this.anchor, this.segments(follower));
    captureView(doc, this.render, this.source);
  }
}
