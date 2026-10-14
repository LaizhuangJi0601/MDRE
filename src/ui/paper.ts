import { settings, saveSettings } from '../persistence/settings';
// 纸张显示独立于文档模式；缩放比例固定在渲染页右下角。
export function setupPaper(pane: HTMLElement, button: HTMLButtonElement, label: HTMLElement, fail: (reason: unknown) => void) {
  let enabled = settings().paper_enabled, zoom = 1;
  let anchor: { page: number; x: number; y: number; pointerX: number; pointerY: number } | undefined;
  const information = () => {
    if (!enabled) { label.textContent = ''; return; }
    const percentage = `${Math.round(zoom * 100)}%`;
    if (!pane.classList.contains('paper-paged')) { label.textContent = percentage; return; }
    const viewport = pane.getBoundingClientRect(), sheets = [...pane.querySelectorAll<HTMLElement>('.paper-sheet')];
    const visible = sheets.find(sheet => { const rect = sheet.getBoundingClientRect(); return rect.bottom > viewport.top + 24 && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right; });
    label.textContent = `第 ${visible?.dataset.page ?? 1} / ${pane.dataset.pages ?? 1} 页 · ${percentage}`;
  };
  const paint = () => {
    pane.classList.toggle('paper-mode', enabled);
    pane.classList.toggle('paper-paged', enabled && settings().paper_layout === 'paged');
    pane.style.setProperty('--paper-zoom', String(zoom));
    pane.style.setProperty('--paper-align', settings().paper_align);
    document.documentElement.dataset.imageLayout = settings().image_layout;
    button.setAttribute('aria-pressed', String(enabled));
    button.dataset.tooltip = enabled ? '关闭 A4 纸张（Ctrl＋滚轮缩放）' : 'A4 纸张（Ctrl＋滚轮缩放）';
    information();
    label.hidden = !enabled;
    pane.dispatchEvent(new CustomEvent('mdre:paper-layout'));
  };
  const toggle = () => { enabled = !enabled; paint(); void saveSettings({ paper_enabled: enabled }).catch(fail); };
  pane.addEventListener('scroll', information, { passive: true });
  pane.addEventListener('mdre:paper-pages', () => {
    if (anchor) {
      const sheet = pane.querySelector<HTMLElement>(`.paper-sheet[data-page="${anchor.page}"]`), canvas = pane.querySelector<HTMLElement>('.paper-canvas');
      if (sheet && canvas) {
        pane.scrollLeft = canvas.offsetLeft + (sheet.offsetLeft + anchor.x) * zoom - anchor.pointerX;
        pane.scrollTop = canvas.offsetTop + (sheet.offsetTop + anchor.y) * zoom - anchor.pointerY;
      }
      anchor = undefined;
    }
    information();
  });
  pane.addEventListener('wheel', event => {
    if (!enabled || !event.ctrlKey) return;
    event.preventDefault();
    const previous = zoom;
    const rect = pane.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (pane.classList.contains('paper-paged')) {
      const sheets = [...pane.querySelectorAll<HTMLElement>('.paper-sheet')];
      const sheet = sheets.find(sheet => { const box = sheet.getBoundingClientRect(); return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom; })
        ?? sheets.find(sheet => sheet.getBoundingClientRect().bottom > rect.top);
      if (sheet) { const box = sheet.getBoundingClientRect(); anchor = { page: Number(sheet.dataset.page), x: (event.clientX - box.left) / previous, y: (event.clientY - box.top) / previous, pointerX: x, pointerY: y }; }
    }
    zoom = Math.max(0.25, Math.min(2.5, zoom * Math.exp(-event.deltaY * 0.002)));
    const left = pane.scrollLeft, top = pane.scrollTop;
    paint();
    pane.scrollLeft = (left + x) * zoom / previous - x;
    pane.scrollTop = (top + y) * zoom / previous - y;
  }, { passive: false });
  paint();
  return { toggle, refresh() { enabled = settings().paper_enabled; paint(); }, get enabled() { return enabled; } };
}
