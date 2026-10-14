import type { EditorView as CMView } from '@codemirror/view';
import type { EditorView } from 'prosemirror-view';
import type { DocumentSession } from '../session';
import { viewOffset } from '../mapping';
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
    this.panes = { source: source.scrollDOM, render: render.dom.parentElement! };
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
  private sync() {
    const doc = this.document(); if (!doc) return;
    const renderOnly = doc.readOnly || !this.panes.source.getClientRects().length;
    const context = `${doc.id}:${doc.revision}:${renderOnly}`;
    if (!this.ready() || doc.composition) { this.preservePending = false; return; }
    if (this.resetPending || context !== this.context) {
      const restored = this.resetPending;
      this.resetPending = false; this.preservePending = false; this.context = context;
      this.driver = renderOnly || (restored && doc.readingAnchor) ? 'render' : doc.selection.active; this.anchor = null;
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
