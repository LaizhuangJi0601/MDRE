import type { Model } from '../model';

export type OutlineEntry = { id: string; level: number; text: string; from: number; parent: string | null };

// G-1：大纲按标题层级取自同一份带源码映射的模型，标题以外的块不进入大纲。
export function outlineEntries(model: Model): OutlineEntry[] {
  return model.blocks.filter(block => block.type === 'heading').map(block => ({
    id: block.id, from: block.from, parent: block.parent,
    level: Math.min(6, Math.max(1, Number(block.node.attrs.level ?? 1))),
    text: (block.node.textContent || '').trim() || '（空标题）',
  }));
}
// G-2：当前所在章节 = 光标之前最后一个标题。
export function currentOutline(entries: OutlineEntry[], source: number): string | null {
  let active: string | null = null;
  for (const entry of entries) { if (entry.from > source) break; active = entry.id; }
  return active;
}
export function renderOutline(container: HTMLElement, entries: OutlineEntry[], activeId: string | null, onJump: (entry: OutlineEntry) => void) {
  container.replaceChildren(...entries.map(entry => {
    const button = document.createElement('button');
    button.className = 'outline-item'; button.dataset.outline = entry.id; button.dataset.level = String(entry.level);
    button.style.paddingLeft = `${8 + (entry.level - 1) * 12}px`;
    button.textContent = entry.text; button.title = `H${entry.level} · ${entry.text}`;
    button.classList.toggle('active', entry.id === activeId);
    if (entry.id === activeId) button.setAttribute('aria-current', 'true');
    button.onclick = () => onJump(entry);
    return button;
  }));
}
