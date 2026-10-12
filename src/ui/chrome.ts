import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { icon } from './icons';

// 合成事件或文本节点的 target 可能不是 Element，closest 需要先做类型判断。
const closestOf = <T extends Element = Element>(target: EventTarget | null, selector: string): T | null =>
  target instanceof Element ? target.closest<T>(selector) : null;

export function setupMenus() {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.menu'));
  let active: HTMLElement | null = null;
  const close = () => {
    if (!active) return;
    active.querySelector<HTMLElement>('.menu-popup')!.hidden = true;
    active.querySelectorAll<HTMLElement>('.menu-submenu').forEach(submenu => submenu.hidden = true);
    active.querySelector('button')!.setAttribute('aria-expanded', 'false'); active = null;
  };
  const open = (menu: HTMLElement) => {
    close(); active = menu;
    menu.querySelector<HTMLElement>('.menu-popup')!.hidden = false;
    menu.querySelector('button')!.setAttribute('aria-expanded', 'true');
  };
  for (const menu of menus) {
    menu.querySelector<HTMLButtonElement>('.menu-trigger')!.onclick = () => active === menu ? close() : open(menu);
    menu.onpointerenter = () => { if (active && active !== menu) open(menu); };
    menu.querySelector<HTMLElement>('.menu-popup')!.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.id === 'recent-menu') return;
      close();
      // 命令项优先点击真实元素；只有 data-command 的菜单项交给应用的统一命令分发。
      if (button.dataset.command) {
        const element = document.getElementById(button.dataset.command);
        if (element) element.click();
        else document.dispatchEvent(new CustomEvent('mdre:command', { detail: button.dataset.command }));
      }
    });
  }
  document.addEventListener('pointerdown', event => { if (!closestOf(event.target, '.menu')) close(); });
  document.addEventListener('keydown', event => {
    const accelerator = ['f', 'e', 'v', 'x'].indexOf(event.key.toLowerCase());
    if (event.altKey && accelerator >= 0) { event.preventDefault(); open(menus[accelerator]); return; }
    if (!active) return;
    if (event.key === 'Escape') { const trigger = active.querySelector<HTMLButtonElement>('button')!; close(); trigger.focus(); event.preventDefault(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); open(menus[(menus.indexOf(active) + (event.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const items = Array.from(active.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Tab') close();
  });
}

export function setupTooltips() {
  const tooltip = document.getElementById('tooltip')!;
  let target: HTMLElement | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => { clearTimeout(timer); timer = undefined; tooltip.hidden = true; target?.removeAttribute('aria-describedby'); target = null; };
  const show = (element: HTMLElement, delay: number, keyboard = false) => {
    // 已在显示同一个目标时不要重启计时；否则每次 mousemove 都会把提示推后。
    if (target === element) return;
    clearTimeout(timer); timer = undefined;
    if (target) target.removeAttribute('aria-describedby');
    target = element;
    timer = setTimeout(() => {
      // 计时期间目标已改变或已离开，就不再显示，避免提示停留在上一个按钮上。
      if (target !== element) return;
      if (!element.isConnected || !(keyboard ? element.contains(document.activeElement) : element.matches(':hover'))) { hide(); return; }
      // 子菜单可能自身未 hidden，但祖先菜单已收起；只检查实际可见的浮层。
      if (Array.from(document.querySelectorAll<HTMLElement>('.dropdown-popup, .menu-popup, dialog[open]')).some(popup => popup.getClientRects().length > 0)) { hide(); return; }
      tooltip.textContent = element.dataset.tooltip!; tooltip.hidden = false; element.setAttribute('aria-describedby', 'tooltip');
      const rect = element.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - tooltip.offsetWidth) / 2, innerWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${rect.bottom + tooltip.offsetHeight + 10 < innerHeight ? rect.bottom + 7 : rect.top - tooltip.offsetHeight - 7}px`;
    }, delay);
  };
  document.addEventListener('pointerover', event => { const element = closestOf<HTMLElement>(event.target, '[data-tooltip]'); if (element) show(element, 260); });
  document.addEventListener('pointerout', event => {
    if (!target) return;
    const next = event.relatedTarget instanceof Element ? closestOf<HTMLElement>(event.relatedTarget, '[data-tooltip]') : null;
    // 移到另一个带提示的元素时直接改投目标，避免先隐藏再重新计时造成闪烁或残留。
    if (next && next !== target) { show(next, 260); return; }
    if (!target.contains(event.relatedTarget as Node | null)) hide();
  });
  document.addEventListener('focusin', event => { const element = closestOf<HTMLElement>(event.target, '[data-tooltip]'); if (element) show(element, 0, true); });
  document.addEventListener('focusout', hide); document.addEventListener('pointerdown', hide); document.addEventListener('keydown', hide);
  window.addEventListener('blur', hide); window.addEventListener('resize', hide);
}

export async function setupWindowControls(error: (reason: unknown) => void) {
  const controls = document.querySelector<HTMLElement>('.window-controls')!;
  if (!isTauri()) { controls.hidden = true; return; }
  const appWindow = getCurrentWindow(), maximize = document.getElementById('window-maximize')!;
  const update = async () => {
    const maximized = await appWindow.isMaximized();
    maximize.innerHTML = icon(maximized ? 'restore' : 'maximize');
    maximize.dataset.tooltip = maximized ? '还原窗口' : '最大化'; maximize.setAttribute('aria-label', maximize.dataset.tooltip);
  };
  document.getElementById('window-minimize')!.onclick = () => { appWindow.minimize().catch(error); };
  maximize.onclick = () => { appWindow.toggleMaximize().then(update).catch(error); };
  document.getElementById('window-close')!.onclick = () => { appWindow.close().catch(error); };
  await appWindow.onResized(() => { update().catch(error); });
  await update();
}
