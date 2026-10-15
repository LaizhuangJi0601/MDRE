import { icon, type Icon } from './icons';

export type ContextItem = { id: string; label: string; icon?: Icon; accelerator?: string; disabled?: boolean; separator?: boolean; checked?: boolean; children?: ContextItem[]; colorPicker?: { value: string; change: (value: string) => void }; run?: () => void };
// 两种菜单共用定位、键盘与关闭行为，鼠标操作不清除编辑选区。
export function contextMenu(id: string) {
  const dom = document.createElement('div'); dom.id = id; dom.className = 'context-menu'; dom.role = 'menu'; dom.hidden = true; document.body.append(dom);
  // 子菜单点击展开并保持，鼠标移动不改变当前展开项。
  const submenu = document.createElement('div'); submenu.className = 'context-menu context-submenu'; submenu.role = 'menu'; submenu.hidden = true; document.body.append(submenu);
  let restoreFocus: HTMLElement | null = null;
  let activeParent: HTMLButtonElement | null = null;
  const collapse = () => { activeParent?.setAttribute('aria-expanded', 'false'); activeParent = null; submenu.hidden = true; };
  const close = (restore = false) => { dom.hidden = true; collapse(); if (restore) restoreFocus?.focus(); };
  const place = (node: HTMLElement, x: number, y: number) => {
    node.hidden = false;
    node.style.left = `${Math.max(4, Math.min(x, innerWidth - node.offsetWidth - 4))}px`;
    node.style.top = `${Math.max(4, Math.min(y, innerHeight - node.offsetHeight - 4))}px`;
  };
  const fill = (node: HTMLElement, items: ContextItem[], onPick?: () => void) => {
    node.replaceChildren(...items.map(item => {
      // 分隔线沿用与菜单项相同的网格，保证三列对齐。
      if (item.separator) { const rule = document.createElement('div'); rule.className = 'context-rule'; rule.setAttribute('role', 'separator'); return rule; }
      if (item.colorPicker) {
        const label = document.createElement('label'); label.className = 'context-color-picker';
        const text = document.createElement('span'); text.textContent = item.label;
        const input = document.createElement('input'); input.type = 'color'; input.value = item.colorPicker.value;
        input.dataset.context = item.id; input.setAttribute('aria-label', item.label); input.disabled = !!item.disabled;
        input.oninput = () => item.colorPicker!.change(input.value);
        label.append(text, input); return label;
      }
      const button = document.createElement('button');
      button.dataset.context = item.id; button.role = item.checked === undefined ? 'menuitem' : 'menuitemradio';
      if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
      // 与工具栏一致的应用内悬停提示；title 保留作为无脚本时的兜底。
      const hint = item.accelerator ? `${item.label}（${item.accelerator}）` : item.label;
      button.title = hint; button.dataset.tooltip = hint;
      const glyph = document.createElement('span'); glyph.className = 'context-icon';
      // 颜色项直接用真实色块，比通用图标更容易辨认。
      if (item.icon?.startsWith('#')) {
        const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = item.icon;
        glyph.append(swatch);
      } else { glyph.innerHTML = item.icon ? icon(item.icon) : ''; }
      const label = document.createElement('span'); label.className = 'context-label'; label.textContent = item.label;
      const key = document.createElement('span'); key.className = 'context-accelerator';
      key.textContent = item.children ? '›' : item.checked ? '✓' : item.accelerator ?? '';
      button.append(glyph, label, key);
      button.disabled = !!item.disabled;
      if (item.children) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const expand = () => {
          if (button.disabled || (activeParent === button && !submenu.hidden)) return;
          collapse(); activeParent = button; button.setAttribute('aria-expanded', 'true');
          const rect = button.getBoundingClientRect(), parent = dom.getBoundingClientRect();
          fill(submenu, item.children!, onPick); submenu.hidden = false;
          // 右侧空间不足时向左展开，避免视口钳制把子菜单压到父项上。
          const width = submenu.offsetWidth;
          const x = parent.right + width <= innerWidth - 4 ? parent.right - 2 : parent.left - width + 2;
          place(submenu, x, rect.top - 5);
        };
        button.onclick = event => { event.stopPropagation(); expand(); };
      } else {
        button.onclick = () => { close(); item.run?.(); onPick?.(); };
      }
      return button;
    }));
  };
  const preserveSelection = (event: MouseEvent) => { if (!(event.target as Element).closest('input')) event.preventDefault(); };
  dom.addEventListener('mousedown', preserveSelection);
  submenu.addEventListener('mousedown', preserveSelection);
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node;
    if (!dom.contains(target) && !submenu.contains(target)) close();
  });
  window.addEventListener('resize', () => close());
  document.addEventListener('keydown', event => {
    if (dom.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'ArrowRight') {
      const button = document.activeElement?.closest?.('button[aria-haspopup="menu"]') as HTMLButtonElement | null;
      if (button && dom.contains(button)) { event.preventDefault(); button.click(); submenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
      return;
    }
    if (event.key === 'ArrowLeft' && !submenu.hidden) { event.preventDefault(); const parent = activeParent; collapse(); parent?.focus(); return; }
    if ((document.activeElement as HTMLElement)?.matches('input')) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const scope = !submenu.hidden && submenu.contains(document.activeElement) ? submenu : dom;
    const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  return { dom, close, open(items: ContextItem[], x: number, y: number) {
    collapse();
    document.querySelectorAll<HTMLElement>('.context-menu').forEach(menu => menu.hidden = true);
    restoreFocus = document.activeElement as HTMLElement;
    dom.replaceChildren();
    submenu.hidden = true;
    fill(dom, items);
    place(dom, x, y);
  } };
}
