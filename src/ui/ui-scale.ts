import { settings, saveSettings } from '../persistence/settings';

// v0.3.0：界面缩放（全应用/插件中除正文文字以外的显示，包括文件列表内容、菜单、工具栏、状态栏与对话框）。
// 正文、源码编辑区、PDF 页面与代码视图保持各自的字号/缩放设置，不参与这里的缩放。
// 实现统一使用 CSS `zoom`：布局尺寸随之放大，控件与文字不会相互遮挡；
// 需要按像素定位的弹窗在 dialogs.ts / window-dialog.ts 里用 toStylePixels 换算回缩放前单位。
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;

export function normalizeUiScale(value: number) {
  const stepped = Math.round(Number(value) / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Number.isFinite(stepped) ? stepped : 100));
}

export function uiScalePercent() { return normalizeUiScale(settings().ui_scale); }
// 0.8 – 2.0。
export function uiScale() { return uiScalePercent() / 100; }
// CSS zoom 中，元素的内联 left/top/width/height 以缩放前单位解释；视觉尺寸 = 样式值 × 缩放。
export function toStylePixels(visual: number) { return visual / uiScale(); }
export function toVisualPixels(style: number) { return style * uiScale(); }

export function applyUiScale(value = uiScalePercent()) {
  const percent = normalizeUiScale(value);
  document.documentElement.style.setProperty('--ui-scale', String(percent / 100));
  document.documentElement.dataset.uiScale = String(percent);
  return percent;
}

// v0.3.0：Ctrl+滚轮调节界面缩放（步进 10%，80%–200%），与 A4/PDF 各自的 Ctrl+滚轮缩放共存。
// exclude 用于让宿主把落在 A4 渲染区或 PDF 查看器上的 Ctrl+滚轮让给它们自己的缩放逻辑。
export function setupUiScaleWheel(options: { onChange?: (percent: number) => void; exclude?: (event: WheelEvent) => boolean } = {}) {
  let accumulator = 0;
  const handler = (event: WheelEvent) => {
    if (!event.ctrlKey || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('#pdf-view')) return;
    if (options.exclude?.(event)) return;
    event.preventDefault();
    accumulator += event.deltaY;
    if (Math.abs(accumulator) < 40) return;
    const direction = accumulator > 0 ? -1 : 1;
    accumulator = 0;
    const current = uiScalePercent();
    const next = normalizeUiScale(current + direction * UI_SCALE_STEP);
    if (next === current) return;
    applyUiScale(next);
    void saveSettings({ ui_scale: next }).catch(() => { /* 写盘失败时保留本次会话缩放 */ });
    window.dispatchEvent(new Event('mdre:settings-applied'));
    options.onChange?.(next);
  };
  document.addEventListener('wheel', handler, { passive: false, capture: true });
  return () => document.removeEventListener('wheel', handler, { capture: true });
}
