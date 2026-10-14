import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

const key = new PluginKey<DecorationSet>('paper-pagination');
// 行内公式的上标可能超出文字行框，跨页处为字形留出 4px 余量。
const mm = 96 / 25.4, width = 210 * mm, height = 297 * mm, margin = 20 * mm + 4, gap = 24, stride = height + gap, capacity = height - margin * 2;

// 分页空白是视图装饰，不进入文档、源码、复制内容或撤销历史。
export function paperPagination() {
  return new Plugin<DecorationSet>({
    key,
    state: { init: () => DecorationSet.empty, apply(tr, previous) { return tr.getMeta(key) ?? previous.map(tr.mapping, tr.doc); } },
    props: { decorations: state => key.getState(state) },
    view(view) {
      const existing = view.dom.closest<HTMLElement>('.paper-canvas');
      const pane = existing?.parentElement ?? view.dom.parentElement!;
      const canvas = existing ?? document.createElement('div');
      const stage = existing?.querySelector<HTMLElement>('.paper-stage') ?? document.createElement('div');
      const sheets = existing?.querySelector<HTMLElement>('.paper-sheets') ?? document.createElement('div');
      if (!existing) {
        canvas.className = 'paper-canvas'; stage.className = 'paper-stage'; sheets.className = 'paper-sheets';
        sheets.contentEditable = 'false'; sheets.setAttribute('aria-hidden', 'true');
        view.dom.before(canvas); canvas.append(stage); stage.append(sheets, view.dom);
      }
      let frame = 0, destroyed = false, measuring = false, observedWidth = 0;
      const schedule = () => { if (!frame && !destroyed && !measuring) frame = requestAnimationFrame(layout); };
      const set = (decorations: Decoration[]) => view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, [...decorations])));
      function layout() {
        frame = 0;
        if (destroyed || view.composing) return;
        measuring = true;
        try {
          if (key.getState(view.state)?.find().length) set([]);
          sheets.replaceChildren();
          canvas.removeAttribute('style'); stage.removeAttribute('style');
          if (!pane.classList.contains('paper-paged')) {
            pane.dataset.pages = '1'; pane.dataset.columns = '1';
            pane.dispatchEvent(new CustomEvent('mdre:paper-pages')); return;
          }
          // 缩放只作用于最终画布，分页始终按同一套未缩放的 A4 坐标计算。
          // CSS zoom 会改变文字栅格和实际换行，改用整体 transform 避免比例混用。
          const zoom = Number(getComputedStyle(pane).getPropertyValue('--paper-zoom')) || 1;
          const columns = Math.max(1, Math.min(3, Math.floor(((pane.clientWidth - 48) / zoom + gap) / (width + gap))));
          const origin = view.dom.getBoundingClientRect().top;
          const y = (value: number) => (value - origin) / zoom;
          const candidates: { node: PMNode; pos: number; dom: HTMLElement }[] = [];
          function collect(node: PMNode, pos: number) {
            const dom = view.nodeDOM(pos);
            if (!(dom instanceof HTMLElement)) return;
            const box = dom.getBoundingClientRect();
            if (node.isTextblock || node.isAtom || node.type.name === 'table_row' || (['list_item', 'blockquote'].includes(node.type.name) && box.height / zoom <= capacity)) {
              candidates.push({ node, pos, dom }); return;
            }
            node.forEach((child, offset) => collect(child, pos + 1 + offset));
          }
          view.state.doc.forEach((node, pos) => collect(node, pos));
          const decorations: Decoration[] = [];
          const breaks: { pos: number; page: number }[] = [];
          let shift = 0, page = 0, lastBottom = margin;
          const add = (pos: number, size: number, inline: boolean, row: boolean) => {
            if (size <= 0.5) return;
            const next = !inline && !row ? view.nodeDOM(pos) : null;
            const previous = next instanceof HTMLElement ? next.previousElementSibling : null;
            const collapsedMargin = next instanceof HTMLElement && previous instanceof HTMLElement
              ? Math.max(0, Math.min(parseFloat(getComputedStyle(next).marginTop) || 0, parseFloat(getComputedStyle(previous).marginBottom) || 0)) : 0;
            decorations.push(Decoration.widget(pos, () => {
              const spacer = document.createElement(row ? 'tr' : inline ? 'span' : 'div');
              spacer.className = `page-spacer${inline ? ' page-spacer-inline' : ''}`;
              spacer.contentEditable = 'false'; spacer.setAttribute('aria-hidden', 'true'); spacer.dataset.pageBreak = String(pos);
              if (row) { const cell = document.createElement('td'); cell.colSpan = view.state.doc.nodeAt(pos)?.childCount ?? 1; cell.style.height = `${size}px`; spacer.append(cell); }
              else spacer.style.height = `${size}px`;
              // 装饰块隔开相邻段落后，抵消原来折叠的外边距，保持分页计算和实际行位置一致。
              if (collapsedMargin) spacer.style.setProperty('margin-top', `${-collapsedMargin}px`, 'important');
              return spacer;
            }, { side: -1, ignoreSelection: true, key: `page-${pos}-${Math.round(size)}`, stopEvent: () => true }));
            shift += size;
            if (inline) breaks.push({ pos, page });
          };
          for (const { node, pos, dom } of candidates) {
            const rect = dom.getBoundingClientRect(), top = y(rect.top), bottom = y(rect.bottom), size = bottom - top;
            let end = page * stride + height - margin;
            if (bottom + shift > end + 0.5 && size <= capacity) {
              page++;
              add(pos, page * stride + margin - (top + shift), false, node.type.name === 'table_row');
            } else if (node.isTextblock && size > capacity) {
              // 长段按视觉行分开，二分定位跨页行的第一个字符，不拆开模型段落。
              let start = pos + 1, limit = pos + node.nodeSize - 1;
              while (start < limit) {
                end = page * stride + height - margin;
                if (y(view.coordsAtPos(limit).bottom) + shift <= end) break;
                let low = start, high = limit;
                while (low < high) {
                  const middle = Math.floor((low + high) / 2);
                  if (y(view.coordsAtPos(middle).bottom) + shift > end) high = middle; else low = middle + 1;
                }
                if (low >= limit) break;
                const lineTop = y(view.coordsAtPos(low).top);
                page++;
                add(low, page * stride + margin - (lineTop + shift), true, false);
                start = low + 1;
              }
            } else if (size > capacity && top + shift > page * stride + margin + 1) {
              page++; add(pos, page * stride + margin - (top + shift), false, node.type.name === 'table_row');
            }
            lastBottom = Math.max(lastBottom, bottom + shift);
            page = Math.max(page, Math.floor((lastBottom + margin - 1) / stride));
          }
          if (decorations.length) set(decorations);
          const pages = Math.max(1, page + 1);
          const displacement = (index: number) => ({ x: (index % columns) * (width + gap), y: (Math.floor(index / columns) - index) * stride });
          const style = (x: number, y: number) => `position:relative;left:${x}px;top:${y}px;`;
          // 同一个编辑器以装饰定位到对应纸张，不复制内容或拆改文档节点。
          // 长段落后续页使用行内装饰，列表项和表格行使用节点装饰。
          for (const { node, pos } of candidates) {
            const dom = view.nodeDOM(pos);
            if (!(dom instanceof HTMLElement)) continue;
            const startPage = Math.max(0, Math.floor((y(dom.getBoundingClientRect().top) + 1) / stride));
            const base = displacement(startPage);
            if (base.x || base.y) decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: style(base.x, base.y), 'data-paper-page': String(startPage + 1) }));
            else decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-paper-page': String(startPage + 1) }));
            if (node.isTextblock) {
              const cuts = breaks.filter(item => item.pos > pos && item.pos < pos + node.nodeSize - 1);
              cuts.forEach((cut, index) => {
                const target = displacement(cut.page), end = cuts[index + 1]?.pos ?? pos + node.nodeSize - 1;
                decorations.push(Decoration.inline(cut.pos, end, { style: style(target.x - base.x, target.y - base.y), 'data-paper-page': String(cut.page + 1) }));
              });
            }
          }
          set(decorations);
          const rows = Math.ceil(pages / columns), canvasWidth = columns * width + (columns - 1) * gap, canvasHeight = rows * height + (rows - 1) * gap;
          canvas.style.width = `${canvasWidth * zoom}px`; canvas.style.height = `${canvasHeight * zoom}px`;
          stage.style.width = `${canvasWidth}px`; stage.style.height = `${canvasHeight}px`;
          for (let index = 0; index < pages; index++) {
            const sheet = document.createElement('div'), footer = document.createElement('span');
            sheet.className = 'paper-sheet'; sheet.dataset.page = String(index + 1);
            sheet.style.left = `${index % columns * (width + gap)}px`; sheet.style.top = `${Math.floor(index / columns) * stride}px`;
            footer.className = 'paper-page-number'; footer.textContent = String(index + 1); sheet.append(footer); sheets.append(sheet);
          }
          pane.dataset.pages = String(pages); pane.dataset.columns = String(columns);
          pane.dispatchEvent(new CustomEvent('mdre:paper-pages'));
        } finally { measuring = false; }
      }
      pane.addEventListener('mdre:paper-layout', schedule);
      view.dom.addEventListener('load', schedule, true);
      view.dom.addEventListener('compositionend', schedule);
      const resize = new ResizeObserver(entries => { const width = entries[0].contentRect.width; if (width !== observedWidth) { observedWidth = width; schedule(); } });
      resize.observe(pane);
      const appearance = new MutationObserver(schedule); appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      document.fonts.addEventListener('loadingdone', schedule);
      schedule();
      return { update(next: EditorView, previous) { if (!next.state.doc.eq(previous.doc) || key.getState(next.state) !== key.getState(previous)) schedule(); }, destroy() {
        destroyed = true; cancelAnimationFrame(frame); resize.disconnect(); appearance.disconnect();
        pane.removeEventListener('mdre:paper-layout', schedule); view.dom.removeEventListener('load', schedule, true);
        view.dom.removeEventListener('compositionend', schedule); document.fonts.removeEventListener('loadingdone', schedule);
        // 重建 EditorState 时插件视图也会重建；保留 DOM 层级，避免连续输入丢失焦点。
        queueMicrotask(() => { if (view.isDestroyed) canvas.remove(); });
      } };
    },
  });
}
