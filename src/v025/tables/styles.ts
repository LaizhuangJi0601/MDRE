// v0.2.5 表格交互样式：列宽拖拽光标、测量容器与“转换为 Markdown 表格”确认弹窗。
// 样式在模块初始化时注入，避免改动 Lead 维护的 style.css 与插件构建配置。
const STYLE_ID = 'mdre-tables-ui-style';

const CSS = `
/* 列边框悬停与拖动期间统一光标；只改 body 类，避免触发 ProseMirror 重绘。 */
body.mdre-table-col-hover, body.mdre-table-col-hover * { cursor: col-resize !important; }
body.mdre-col-resizing, body.mdre-col-resizing * { cursor: col-resize !important; user-select: none !important; }
/* 拖动预览：覆盖原表格的同尺寸副本（pointer-events 穿透），内部用 colgroup 实时换算百分比宽度。 */
.mdre-width-overlay { position: fixed; z-index: 60; pointer-events: none; background: var(--surface); box-shadow: 0 0 0 1px var(--accent); }
.mdre-width-overlay table { border-collapse: collapse; width: 100%; margin: 0; table-layout: fixed; }
.mdre-width-overlay th, .mdre-width-overlay td { border: 1px solid var(--border); padding: 6px 9px; vertical-align: top; overflow-wrap: anywhere; }
.mdre-width-overlay th { background: var(--hover); font-weight: 600; }
.mdre-width-overlay table tr:first-child > * { background: var(--hover); }
/* 单元格内容自然宽度的离屏测量容器（不参与视觉布局）。 */
.mdre-cell-measure { position: fixed; left: -10000px; top: 0; visibility: hidden; pointer-events: none; white-space: nowrap; display: inline-block; padding: 0; border: 0; margin: 0; max-width: none; max-height: none; overflow: visible; z-index: -1; }
dialog#mdre-table-convert-dialog { width: min(560px, 92vw); }
dialog#mdre-table-convert-dialog .mdre-convert-loss { margin: 6px 0 10px; padding-left: 20px; color: var(--text); font-size: 13px; line-height: 1.65; }
dialog#mdre-table-convert-dialog .mdre-convert-loss li + li { margin-top: 4px; }
dialog#mdre-table-convert-dialog .mdre-convert-note { margin: 0 0 6px; }
`;

export function injectTableStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
