import type { Model } from '../model';

export type OutlineEntry = { id: string; level: number; text: string; from: number; parent: string | null };

// G-1：大纲按标题层级取自同一份带源码映射的模型，标题以外的块不进入大纲。
// v0.2.7 性能：状态栏每次刷新都会取大纲，按模型对象缓存（模型不可变，新解析产生新对象）。
const outlineCache = new WeakMap<Model, OutlineEntry[]>();
export function outlineEntries(model: Model): OutlineEntry[] {
  const cached = outlineCache.get(model);
  if (cached) return cached;
  const entries = model.blocks.filter(block => block.type === 'heading').map(block => ({
    id: block.id, from: block.from, parent: block.parent,
    level: Math.min(6, Math.max(1, Number(block.node.attrs.level ?? 1))),
    text: (block.node.textContent || '').trim() || '（空标题）',
  }));
  outlineCache.set(model, entries);
  return entries;
}
// G-2：当前所在章节 = 光标之前最后一个标题。
export function currentOutline(entries: OutlineEntry[], source: number): string | null {
  let active: string | null = null;
  for (const entry of entries) { if (entry.from > source) break; active = entry.id; }
  return active;
}
// v0.2.7 性能：大纲在每次状态栏刷新时都会重建。复用已有按钮节点、只改变化项，
// 避免在大文档（数十个标题）下每次按键都重新创建整棵大纲 DOM。
export function renderOutline(container: HTMLElement, entries: OutlineEntry[], activeId: string | null, onJump: (entry: OutlineEntry) => void) {
  const existing = new Map<string, HTMLButtonElement>();
  for (const child of Array.from(container.children)) {
    const button = child as HTMLButtonElement;
    if (button.dataset.outline) existing.set(button.dataset.outline, button);
  }
  const buttons: HTMLButtonElement[] = [];
  for (const entry of entries) {
    const button = existing.get(entry.id) ?? document.createElement('button');
    existing.delete(entry.id);
    button.className = 'outline-item';
    button.dataset.outline = entry.id;
    button.dataset.level = String(entry.level);
    button.style.paddingLeft = `${8 + (entry.level - 1) * 12}px`;
    if (button.textContent !== entry.text) button.textContent = entry.text;
    button.title = `H${entry.level} · ${entry.text}`;
    button.classList.toggle('active', entry.id === activeId);
    if (entry.id === activeId) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    button.onclick = () => onJump(entry);
    buttons.push(button);
  }
  for (const stale of existing.values()) stale.remove();
  for (let index = 0; index < buttons.length; index++) {
    const current = container.children[index];
    if (current !== buttons[index]) container.insertBefore(buttons[index], current ?? null);
  }
}
