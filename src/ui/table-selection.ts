import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import type { Model } from '../model';

export function setupTableSelection(view: EditorView, model: () => Model, writable: () => boolean) {
  const chosen = new Set<string>();
  let anchor: HTMLElement | null = null;
  const paint = () => view.dom.querySelectorAll<HTMLElement>('[data-cell]').forEach(cell => cell.classList.toggle('selected-cell', chosen.has(cell.dataset.cell!)));
  const tableCells = (cell: HTMLElement) => [...cell.closest('table')!.querySelectorAll<HTMLElement>('[data-cell]')];
  const selected = (cell: HTMLElement) => {
    const cells = tableCells(cell), range = view.state.selection;
    if (chosen.has(cell.dataset.cell!)) return cells.filter(item => chosen.has(item.dataset.cell!)).map(item => item.dataset.cell!);
    const ids = cells.filter(item => {
      const block = model().blocks.find(block => block.id === item.dataset.cell);
      return block && !range.empty && range.from < block.pos + block.node.nodeSize - 1 && range.to > block.pos + 1;
    }).map(item => item.dataset.cell!);
    return ids.includes(cell.dataset.cell!) ? ids : [cell.dataset.cell!];
  };
  view.dom.addEventListener('mousedown', event => {
    const cell = (event.target as Element).closest<HTMLElement>('[data-cell]');
    if (event.button !== 0 || !writable()) return;
    if (cell && (event.ctrlKey || event.metaKey || event.shiftKey && anchor?.closest('table') === cell.closest('table'))) {
      event.preventDefault(); event.stopImmediatePropagation();
      const all = tableCells(cell);
      if (event.shiftKey && anchor) {
        const rows = [...cell.closest('table')!.rows];
        const rowA = rows.indexOf(anchor.closest('tr')!), rowB = rows.indexOf(cell.closest('tr')!);
        const colA = (anchor.closest('td,th') as HTMLTableCellElement).cellIndex, colB = (cell.closest('td,th') as HTMLTableCellElement).cellIndex;
        chosen.clear();
        for (const item of all) { const row = rows.indexOf(item.closest('tr')!), col = (item as HTMLTableCellElement).cellIndex; if (row >= Math.min(rowA,rowB) && row <= Math.max(rowA,rowB) && col >= Math.min(colA,colB) && col <= Math.max(colA,colB)) chosen.add(item.dataset.cell!); }
      } else { const id = cell.dataset.cell!; if (chosen.has(id)) chosen.delete(id); else chosen.add(id); anchor = cell; }
      paint(); return;
    }
    chosen.clear(); anchor = cell; paint();
  }, true);
  const selectAll = (cell: HTMLElement) => {
    const all = tableCells(cell); chosen.clear(); all.forEach(item => chosen.add(item.dataset.cell!)); anchor = cell; paint();
    const blocks = all.map(item => model().blocks.find(block => block.id === item.dataset.cell)!);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, blocks[0].pos + 1, blocks.at(-1)!.pos + blocks.at(-1)!.node.nodeSize - 1)));
  };
  return { selected, selectAll };
}
