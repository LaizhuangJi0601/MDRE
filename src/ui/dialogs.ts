// 弹窗统一居中，标题可拖动，右下角可缩放；内容滚动而操作按钮常驻。
const configured = new WeakSet<HTMLDialogElement>();
export function positionDialog(dialog: HTMLDialogElement) {
  if (!configured.has(dialog)) {
    configured.add(dialog);
    const title = dialog.querySelector<HTMLElement>('h3')!;
    const content = document.createElement('div'); content.className = 'dialog-content';
    const actions = dialog.querySelector('.dialog-actions');
    for (const child of [...dialog.childNodes]) if (child !== title && child !== actions) content.append(child);
    title.after(content);
    title.classList.add('dialog-title'); title.tabIndex = 0; title.title = '拖动标题调整位置；方向键移动';
    const resize = document.createElement('button'); resize.className = 'dialog-resize'; resize.type = 'button';
    resize.setAttribute('aria-label', '调整弹窗大小'); resize.title = '拖动调整大小；方向键调整'; dialog.append(resize);
    const fit = () => {
      if (!dialog.open) return;
      const rect = dialog.getBoundingClientRect();
      const centered = dialog.dataset.moved !== 'true';
      dialog.style.left = `${Math.max(12, Math.min(centered ? (innerWidth - rect.width) / 2 : rect.left, innerWidth - rect.width - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min(centered ? (innerHeight - rect.height) / 2 : rect.top, innerHeight - rect.height - 12))}px`;
    };
    const observer = new ResizeObserver(fit); observer.observe(dialog);
    window.addEventListener('resize', fit);
    const adjust = (dx: number, dy: number, sizing: boolean, rect: DOMRect) => {
      dialog.dataset.moved = 'true';
      if (sizing) {
        dialog.style.width = `${Math.max(Math.min(320, innerWidth - 24), Math.min(rect.width + dx, innerWidth - rect.left - 12))}px`;
        dialog.style.height = `${Math.max(Math.min(180, innerHeight - 24), Math.min(rect.height + dy, innerHeight - rect.top - 12))}px`;
      } else {
        dialog.style.left = `${Math.max(12, Math.min(rect.left + dx, innerWidth - rect.width - 12))}px`;
        dialog.style.top = `${Math.max(12, Math.min(rect.top + dy, innerHeight - rect.height - 12))}px`;
      }
    };
    for (const [control, sizing] of [[title, false], [resize, true]] as const) {
      const handle: HTMLElement = control;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); handle.setPointerCapture(event.pointerId);
        const rect = dialog.getBoundingClientRect(), x = event.clientX, y = event.clientY;
        const move = (next: PointerEvent) => adjust(next.clientX - x, next.clientY - y, sizing, rect);
        const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('lostpointercapture', finish); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('lostpointercapture', finish);
      });
      handle.addEventListener('keydown', event => {
        const steps: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
        const delta = steps[event.key];
        if (delta) { event.preventDefault(); adjust(delta[0], delta[1], sizing, dialog.getBoundingClientRect()); }
      });
    }
  }
  dialog.dataset.moved = 'false';
  for (const property of ['width', 'height', 'left', 'top']) dialog.style.removeProperty(property);
  if (!dialog.open) dialog.show();
  const rect = dialog.getBoundingClientRect();
  dialog.style.left = `${Math.max(12, (innerWidth - rect.width) / 2)}px`;
  dialog.style.top = `${Math.max(12, (innerHeight - rect.height) / 2)}px`;
}
